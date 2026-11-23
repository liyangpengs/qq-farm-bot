#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const VERBOSE_OUTPUT = process.argv.includes('--verbose')
    || process.argv.includes('-v')
    || process.env.FARM_DEPLOY_VERBOSE === '1';

let workspaceInstall;
let contractBuild;
let coreBuild;
let pnpmInvocation;
const contractEntry = path.join(REPO_ROOT, 'packages/session-contract/dist/index.js');
if (['start', 'update'].includes(process.argv[2]) && !fs.existsSync(contractEntry)) {
    try {
        await buildSessionContract();
    } catch (err) {
        exitWithError(err);
    }
}
const contract = require(contractEntry);
const {
    SESSION_IPC_VERSION,
    acquireExclusiveLock,
    encodeFrame,
    FrameDecoder,
    isProcessAlive,
    listAliveBackendChildren,
    readLockMetadata,
    removeStaleLock,
    resolveRuntimePaths,
    resolveWebRootInfo,
} = contract;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function resolvePnpmInvocation() {
    if (process.env.FARM_PNPM_BIN) {
        return { cmd: process.env.FARM_PNPM_BIN, prefixArgs: [] };
    }
    const rootPkg = readJsonSafe(path.join(REPO_ROOT, 'package.json'));
    const pkgMgr = String(rootPkg?.packageManager || '');
    const preferredVer = pkgMgr.startsWith('pnpm@') ? pkgMgr.slice('pnpm@'.length).split('+')[0] : '';
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || '';
        if (localAppData) {
            const toolsDir = path.join(localAppData, 'pnpm', '.tools', 'pnpm');
            if (fs.existsSync(toolsDir)) {
                const versions = fs.readdirSync(toolsDir)
                    .filter(v => /^\d+\.\d+\.\d+$/.test(v))
                    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
                const ordered = preferredVer && versions.includes(preferredVer)
                    ? [preferredVer, ...versions.filter(v => v !== preferredVer)]
                    : versions;
                for (const ver of ordered) {
                    const candidate = path.join(toolsDir, ver, 'bin', 'pnpm.cmd');
                    if (fs.existsSync(candidate)) return { cmd: candidate, prefixArgs: [] };
                }
            }
        }
        return { cmd: 'pnpm.cmd', prefixArgs: [] };
    }
    const hasPnpm = await new Promise(resolve => {
        const probe = spawn('pnpm', ['--version'], { stdio: 'ignore' });
        probe.once('error', () => resolve(false));
        probe.once('close', code => resolve(code === 0));
    });
    if (hasPnpm) return { cmd: 'pnpm', prefixArgs: [] };
    return { cmd: 'corepack', prefixArgs: ['pnpm'] };
}

function getControlConfig(env = process.env) {
    const runtimePaths = resolveRuntimePaths({
        env,
        appRoot: path.join(REPO_ROOT, 'core'),
        defaultDataDir: path.join(REPO_ROOT, 'core', 'data'),
        defaultRuntimeDir: path.join(REPO_ROOT, 'runtime'),
        defaultResourceRoot: path.join(REPO_ROOT, 'core', 'src'),
        defaultWebRoot: path.join(REPO_ROOT, 'web', 'dist'),
        defaultShareFilePath: path.join(REPO_ROOT, 'core', 'share.txt'),
    });
    const releasesDir = env.FARM_RELEASES_DIR
        ? path.resolve(env.FARM_RELEASES_DIR)
        : path.join(REPO_ROOT, 'releases');
    const port = Number(env.ADMIN_PORT || env.FARM_PORT || env.PORT || 3007) || 3007;
    const stopTimeoutMs = Math.max(1000, Number(env.FARM_STOP_TIMEOUT_MS) || 15000);
    const startTimeoutMs = Math.max(2000, Number(env.FARM_START_TIMEOUT_MS) || 20000);
    return {
        env,
        repoRoot: REPO_ROOT,
        releasesDir,
        hostReleasesDir: path.join(releasesDir, 'host'),
        backendReleasesDir: path.join(releasesDir, 'backend'),
        webReleasesDir: path.join(releasesDir, 'web'),
        dataDir: runtimePaths.dataDir,
        runtimeDir: runtimePaths.runtimeDir,
        hostDataDir: runtimePaths.hostDataDir,
        hostLogDir: runtimePaths.hostLogDir,
        backendLogDir: runtimePaths.backendLogDir,
        socketEndpoint: runtimePaths.sessionSocketEndpoint,
        socketConfigured: runtimePaths.sessionSocketConfigured,
        deployLockPath: path.join(runtimePaths.runtimeDir, 'deploy-operation.lock'),
        hostLockPath: path.join(runtimePaths.runtimeDir, 'session-host.lock'),
        backendLockPath: path.join(runtimePaths.runtimeDir, 'backend-writer.lock'),
        backendChildrenPath: path.join(runtimePaths.runtimeDir, 'backend-children.json'),
        hostPidPath: path.join(runtimePaths.runtimeDir, 'session-host.pid'),
        backendPidPath: path.join(runtimePaths.runtimeDir, 'backend.pid'),
        activeWebPath: runtimePaths.webRootPointerFile,
        shareFilePath: runtimePaths.shareFilePath,
        activeReleasesPath: path.join(runtimePaths.runtimeDir, 'active-releases.json'),
        port,
        stopTimeoutMs,
        startTimeoutMs,
    };
}

function writeJsonAtomic(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function readPidFile(pidPath) {
    try {
        if (!fs.existsSync(pidPath)) return 0;
        const n = Number(fs.readFileSync(pidPath, 'utf8').trim());
        return Number.isSafeInteger(n) && n > 0 ? n : 0;
    } catch {
        return 0;
    }
}

function readActiveReleases(cfg) {
    const raw = readJsonSafe(cfg.activeReleasesPath) || {};
    return {
        host: raw.host || { active: null, previous: null, history: [] },
        backend: raw.backend || { active: null, previous: null, history: [] },
        web: raw.web || { active: null, previous: null, history: [] },
    };
}

function recordActiveRelease(cfg, kind, releaseId) {
    const state = readActiveReleases(cfg);
    const slot = state[kind] || { active: null, previous: null, history: [] };
    if (slot.active && slot.active !== releaseId) {
        slot.previous = slot.active;
    }
    slot.active = releaseId;
    slot.history = [releaseId, ...(slot.history || []).filter(id => id !== releaseId)].slice(0, 10);
    slot.updatedAt = Date.now();
    state[kind] = slot;
    writeJsonAtomic(cfg.activeReleasesPath, state);
    return state;
}

function createReleaseId(prefix = '') {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    let sha = 'local';
    const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (git.status === 0 && git.stdout.trim()) sha = git.stdout.trim();
    const rand = crypto.randomBytes(2).toString('hex');
    return `${prefix ? `${prefix}-` : ''}${stamp}-${sha}-${rand}`;
}

function sendHostIpc(endpoint, requests, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        const results = {};
        let index = 0;
        let settled = false;

        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.destroy(); } catch {}
            if (err) reject(err);
            else resolve(value);
        };

        const timer = setTimeout(() => finish(Object.assign(new Error('Host IPC timeout'), { code: 'HOST_IPC_TIMEOUT' })), timeoutMs);
        timer.unref?.();

        const sendNext = () => {
            if (index >= requests.length) {
                finish(null, results);
                return;
            }
            const req = requests[index];
            socket.write(encodeFrame({ kind: 'req', id: `c_${index}`, op: req.op, params: req.params || {} }));
        };

        const decoder = new FrameDecoder(
            (frame) => {
                if (!frame || frame.kind !== 'res') return;
                const req = requests[index];
                if (!req) return;
                if (!frame.ok) {
                    const err = Object.assign(new Error(frame?.error?.message || `IPC ${req.op} failed`), {
                        code: frame?.error?.code || 'HOST_IPC_ERROR',
                    });
                    finish(err);
                    return;
                }
                results[req.key || req.op] = frame.result;
                index += 1;
                sendNext();
            },
            (err) => finish(err),
        );

        socket.on('error', err => finish(err));
        socket.on('connect', sendNext);
        socket.on('data', chunk => decoder.push(chunk));
    });
}

function httpGetJson(url, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if ((res.statusCode || 500) >= 400) {
                    reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode, body }));
                    return;
                }
                try {
                    resolve(JSON.parse(body || '{}'));
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('timeout', () => {
            req.destroy(Object.assign(new Error('HTTP timeout'), { code: 'HTTP_TIMEOUT' }));
        });
        req.on('error', reject);
    });
}

async function probeHost(cfg) {
    const lock = readLockMetadata(cfg.hostLockPath);
    const pidFile = readPidFile(cfg.hostPidPath);
    const lockAlive = Boolean(lock && isProcessAlive(lock.pid, lock.processStart));
    const pidAlive = Boolean(pidFile && isProcessAlive(pidFile));

    let ipc = null;
    let ipcErr = null;
    try {
        ipc = await sendHostIpc(cfg.socketEndpoint, [
            {
                key: 'hello',
                op: 'hello',
                params: {
                    ipcVersion: SESSION_IPC_VERSION,
                    role: 'control',
                    instanceId: `ctrl_${process.pid}`,
                },
            },
            { key: 'status', op: 'status' },
            { key: 'sessions', op: 'listSessions' },
        ], 1500);
    } catch (err) {
        ipcErr = err;
    }

    if (ipc) {
        const hello = ipc.hello || {};
        if (lockAlive && (Number(hello.pid) !== Number(lock.pid) || hello.hostInstanceId !== lock.instanceId)) {
            return { state: 'conflict', lock, pidFile, ipc, reason: `IPC host PID (${hello.pid}) does not match lock PID (${lock.pid})` };
        }
        if (!lockAlive) {
            return { state: 'conflict', lock, pidFile, ipc, reason: `Host IPC responded (pid=${hello.pid}) without matching active session-host.lock` };
        }
        return {
            state: ipc.status?.ready ? 'ready' : 'starting',
            pid: Number(hello.pid || lock.pid),
            hostInstanceId: String(hello.hostInstanceId || lock.instanceId || ''),
            releaseId: String(hello.releaseId || lock.releaseId || ''),
            ipcVersion: Number(hello.ipcVersion || 0),
            sessions: Array.isArray(ipc.sessions?.sessions) ? ipc.sessions.sessions : [],
            status: ipc.status,
            lock,
            pidFile,
        };
    }

    if (lockAlive || pidAlive) {
        const holderPid = lockAlive ? lock.pid : pidFile;
        return {
            state: 'starting',
            pid: holderPid,
            hostInstanceId: lock?.instanceId || '',
            releaseId: lock?.releaseId || '',
            lock,
            pidFile,
            reason: ipcErr?.message || 'Host process exists but IPC not yet ready',
        };
    }

    return { state: 'absent', pid: 0, lock, pidFile, sessions: [] };
}

async function probeBackend(cfg) {
    const lock = readLockMetadata(cfg.backendLockPath);
    const pidFile = readPidFile(cfg.backendPidPath);
    const lockAlive = Boolean(lock && isProcessAlive(lock.pid, lock.processStart));
    const aliveChildren = listAliveBackendChildren(cfg.backendChildrenPath);

    let httpStatus = null;
    let httpErr = null;
    try {
        httpStatus = await httpGetJson(`http://127.0.0.1:${cfg.port}/api/game-version`, 1500);
    } catch (err) {
        httpErr = err;
    }

    if (httpStatus && httpStatus.ok !== false) {
        const summary = httpStatus.serviceSummary || {};
        const httpInstanceId = String(summary.backendInstanceId || '');
        if (!lockAlive || !httpInstanceId || httpInstanceId !== lock.instanceId) {
            return {
                state: 'conflict',
                pid: lock?.pid || 0,
                lock,
                pidFile,
                aliveChildren,
                httpStatus,
                reason: `HTTP /api/game-version responded with instanceId=${httpInstanceId || 'none'}, mismatch with backend-writer.lock (instance=${lock?.instanceId || 'none'}, pid=${lock?.pid || 'none'})`,
            };
        }
        return {
            state: 'ready',
            pid: Number(lock.pid),
            backendInstanceId: String(httpInstanceId || lock.instanceId || ''),
            releaseId: String(summary.backendReleaseId || lock.releaseId || ''),
            hostConnected: Boolean(summary.hostRunning),
            httpStatus,
            lock,
            pidFile,
            aliveChildren,
        };
    }

    if (lockAlive || aliveChildren.length > 0 || (pidFile && isProcessAlive(pidFile))) {
        return {
            state: 'starting',
            pid: lockAlive ? lock.pid : pidFile,
            backendInstanceId: lock?.instanceId || '',
            releaseId: lock?.releaseId || '',
            lock,
            pidFile,
            aliveChildren,
            reason: httpErr?.message || 'Backend lock/children active; HTTP status not yet ready',
        };
    }

    return { state: 'absent', pid: 0, lock, pidFile, aliveChildren: [] };
}

function stripAnsi(text) {
    return String(text || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function truncateForColumns(text, maxCols) {
    if (!Number.isFinite(maxCols) || maxCols <= 8) return text;
    let width = 0;
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0) || 0;
        const w = code > 0x7f ? 2 : 1;
        if (width + w >= maxCols) {
            return out.length > 0 ? `${out.slice(0, -1)}…` : '';
        }
        out += ch;
        width += w;
    }
    return out;
}

function extractProgressHint(line) {
    if (!line) return null;
    let match;
    if (/transforming\.{0,3}/i.test(line)) return '转换模块中';
    if ((match = line.match(/(\d+)\s+modules transformed/i))) return `已转换 ${match[1]} 个模块`;
    if (/rendering chunks/i.test(line)) return '生成分块中';
    if (/computing gzip size/i.test(line)) return '计算产物体积中';
    if ((match = line.match(/built in\s+([0-9.]+(?:ms|s))/i))) return `打包完成 (${match[1]})`;
    if ((match = line.match(/Progress:\s*resolved\s+(\d+),\s*reused\s+(\d+),\s*downloaded\s+(\d+),\s*added\s+(\d+)/i))) {
        return `已解析 ${match[1]} 个依赖（复用 ${match[2]}，新增 ${match[4]}）`;
    }
    if ((match = line.match(/Packages:\s*\+(\d+)/i)) || (match = line.match(/\|\s*\+(\d+)\s*\++/i))) {
        return `写入 ${match[1]} 个依赖包`;
    }
    return null;
}

async function withProgress(label, run) {
    const startedAt = performance.now();
    const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);
    const heartbeatMs = Math.max(100, Number(process.env.FARM_PROGRESS_INTERVAL_MS) || 10000);
    const isTty = !VERBOSE_OUTPUT && Boolean(process.stderr.isTTY);
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIdx = 0;
    let detail = '';
    let lastLoggedAt = performance.now();

    const renderTty = () => {
        const cols = (process.stderr.columns || 100) - 1;
        const raw = `[发布] ${frames[frameIdx]} ${label}${detail ? ` · ${detail}` : ''} (${elapsed()}s)`;
        process.stderr.write(`\r\x1b[2K${truncateForColumns(raw, cols)}`);
    };

    const updateDetail = (next) => {
        const cleaned = String(next || '').trim();
        if (!cleaned || cleaned === detail) return;
        detail = cleaned;
        if (VERBOSE_OUTPUT) return;
        if (isTty) {
            renderTty();
            return;
        }
        lastLoggedAt = performance.now();
        console.error(`[发布] ${label} · ${detail}（已用时 ${elapsed()} 秒）`);
    };

    let timer;
    if (VERBOSE_OUTPUT) {
        console.error(`[发布] ${label}…`);
        timer = setInterval(() => console.error(`[发布] ${label}，已用时 ${elapsed()} 秒`), heartbeatMs);
    } else if (isTty) {
        renderTty();
        timer = setInterval(() => {
            frameIdx = (frameIdx + 1) % frames.length;
            renderTty();
        }, 200);
    } else {
        console.error(`[发布] ${label}…`);
        timer = setInterval(() => {
            if (performance.now() - lastLoggedAt < heartbeatMs) return;
            lastLoggedAt = performance.now();
            console.error(`[发布] ${label}${detail ? ` · ${detail}` : ''}，已用时 ${elapsed()} 秒`);
        }, Math.max(50, Math.min(2000, heartbeatMs)));
    }
    timer.unref?.();

    try {
        const result = await run({ updateDetail });
        clearInterval(timer);
        if (isTty) {
            process.stderr.write(`\r\x1b[2K[发布] ✓ ${label} (${elapsed()}s)\n`);
        } else {
            console.error(`[发布] 已完成「${label}」，用时 ${elapsed()} 秒`);
        }
        return result;
    } catch (err) {
        clearInterval(timer);
        if (isTty) {
            process.stderr.write(`\r\x1b[2K[发布] ✗ ${label} 失败 (${elapsed()}s)\n`);
        } else {
            console.error(`[发布] 「${label}」失败，用时 ${elapsed()} 秒`);
        }
        if (!VERBOSE_OUTPUT && err?.commandOutput && !err._outputPrinted) {
            console.error(err.commandOutput);
            err._outputPrinted = true;
        }
        throw err;
    } finally {
        clearInterval(timer);
    }
}

function runCommand(cmd, args, options = {}) {
    const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd);
    const command = useShell
        ? [cmd, ...args].map(a => (/[\s"&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a))).join(' ')
        : cmd;
    return new Promise((resolve, reject) => {
        const child = spawn(command, useShell ? [] : args, {
            cwd: REPO_ROOT,
            stdio: VERBOSE_OUTPUT ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
            shell: useShell,
            windowsHide: true,
        });
        const capturedLines = [];
        if (!VERBOSE_OUTPUT) {
            const attachStream = (stream) => {
                if (!stream) return;
                stream.setEncoding('utf8');
                let rem = '';
                const handleLine = (rawLine) => {
                    const cleaned = stripAnsi(rawLine).trim();
                    if (!cleaned) return;
                    capturedLines.push(cleaned);
                    if (capturedLines.length > 80) capturedLines.shift();
                    const hint = extractProgressHint(cleaned);
                    if (hint) options.onProgress?.(hint);
                };
                stream.on('data', (chunk) => {
                    rem += chunk;
                    const parts = rem.split(/\r\n|\n|\r/);
                    rem = parts.pop() ?? '';
                    for (const part of parts) handleLine(part);
                });
                stream.on('end', () => {
                    if (rem) {
                        handleLine(rem);
                        rem = '';
                    }
                });
            };
            attachStream(child.stdout);
            attachStream(child.stderr);
        }
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            const err = new Error(`Command failed (${signal || code}): ${cmd} ${args.join(' ')}`);
            if (capturedLines.length > 0) {
                err.commandOutput = capturedLines.slice(-50).join('\n');
            }
            reject(err);
        });
    });
}

async function runPnpm(args, options = {}) {
    const pnpm = await (pnpmInvocation ??= resolvePnpmInvocation());
    return runCommand(pnpm.cmd, [...pnpm.prefixArgs, ...args], options);
}

function ensureBuildDependencies() {
    return workspaceInstall ??= withProgress('检查并安装构建依赖', progress => runPnpm(['install', '--frozen-lockfile', '--prod=false', '--prefer-offline'], { onProgress: progress.updateDetail }));
}

async function buildSessionContract() {
    await ensureBuildDependencies();
    return contractBuild ??= withProgress('构建会话契约', progress => runPnpm(['build:contract'], { onProgress: progress.updateDetail }));
}

function buildCore() {
    return coreBuild ??= withProgress('构建后端与会话宿主', progress => runPnpm(['-C', 'core', 'build:ts'], { onProgress: progress.updateDetail }));
}

function assertPathIsolatedFromWorkspace(candidateDir, entryFiles, requiredPackages) {
    const resolvedCandidate = fs.realpathSync(path.resolve(candidateDir));
    const forbiddenRoots = ['core', 'packages', 'web', 'node_modules']
        .map(rel => path.join(REPO_ROOT, rel))
        .filter(p => fs.existsSync(p))
        .map(p => fs.realpathSync(p).toLowerCase());

    const checkRealPath = (targetPath, label) => {
        const real = fs.realpathSync(targetPath);
        const lower = real.toLowerCase();
        for (const root of forbiddenRoots) {
            if (lower === root || lower.startsWith(`${root}${path.sep}`.toLowerCase())) {
                throw new Error(`Isolation violation for ${label}: ${real} resolves inside mutable workspace ${root}`);
            }
        }
        return real;
    };

    for (const rel of entryFiles) {
        const abs = path.join(resolvedCandidate, rel);
        if (!fs.existsSync(abs)) {
            throw new Error(`Candidate release is missing required entry file: ${abs}`);
        }
        checkRealPath(abs, rel);
    }

    for (const pkgName of requiredPackages) {
        const pkgEntry = require.resolve(pkgName, { paths: [resolvedCandidate] });
        checkRealPath(pkgEntry, `package:${pkgName}`);
    }

    const nmDir = path.join(resolvedCandidate, 'node_modules');
    if (fs.existsSync(nmDir)) {
        const scanTopModules = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === '.pnpm' || entry.name === '.bin') continue;
                const full = path.join(dir, entry.name);
                if (entry.name.startsWith('@') && entry.isDirectory()) {
                    scanTopModules(full);
                    continue;
                }
                checkRealPath(full, `node_modules/${entry.name}`);
            }
        };
        scanTopModules(nmDir);
    }
}

async function deployPnpmPackage(filterName, candidateDir, onProgress) {
    const targetArg = process.platform === 'win32'
        && path.parse(candidateDir).root.toLowerCase() === path.parse(REPO_ROOT).root.toLowerCase()
        ? path.relative(REPO_ROOT, candidateDir)
        : candidateDir;

    // Across Windows drive letters pnpm --legacy cannot resolve a relative destination;
    // stage on REPO_ROOT's drive inside releases/.pnpm-staging first when needed.
    if (process.platform === 'win32'
        && path.parse(candidateDir).root.toLowerCase() !== path.parse(REPO_ROOT).root.toLowerCase()) {
        const staging = path.join(REPO_ROOT, 'releases', `.pnpm-staging-${process.pid}-${Date.now()}`);
        try {
            fs.mkdirSync(path.dirname(staging), { recursive: true });
            const relStage = path.relative(REPO_ROOT, staging);
            await runPnpm(['--config.prefer-offline=true', '--filter', filterName, 'deploy', '--prod', '--legacy', relStage], { onProgress });
            await fs.promises.cp(staging, candidateDir, { recursive: true, dereference: true });
        } finally {
            fs.rmSync(staging, { recursive: true, force: true });
        }
        return;
    }

    await runPnpm(['--config.prefer-offline=true', '--filter', filterName, 'deploy', '--prod', '--legacy', targetArg], { onProgress });
}

function createReleaseDirectory(releasesDir, releaseId) {
    fs.mkdirSync(releasesDir, { recursive: true });
    const dir = path.join(releasesDir, releaseId);
    fs.mkdirSync(dir);
    return dir;
}

async function stageHostRelease(cfg, options = {}) {
    const releaseId = options.releaseId || createReleaseId('host');
    const candidateDir = createReleaseDirectory(cfg.hostReleasesDir, releaseId);
    if (options.stageFrom) {
        const src = path.resolve(options.stageFrom);
        if (!fs.existsSync(src)) throw new Error(`Host staging source does not exist: ${src}`);
        await withProgress('复制会话宿主发布包', () => fs.promises.cp(src, candidateDir, { recursive: true, dereference: true }));
    } else {
        if (!options.skipBuild) {
            await buildSessionContract();
            await buildCore();
        }
        await withProgress('打包会话宿主', progress => deployPnpmPackage('qq-farm-bot', candidateDir, progress.updateDetail));
        assertPathIsolatedFromWorkspace(candidateDir, ['dist/session/host.js', 'dist/session/gateway-worker.js'], ['@qq-farm-bot/session-contract']);
    }
    await runCommand(process.execPath, ['--check', path.join(candidateDir, 'dist/session/host.js')]);
    return { releaseId, dir: candidateDir };
}

async function stageWebRelease(cfg, options = {}) {
    if (!options.skipBuild && !options.stageFrom) {
        await ensureBuildDependencies();
        await withProgress('构建前端', progress => runPnpm(['build:web'], { onProgress: progress.updateDetail }));
    }
    const sourceDir = options.stageFrom ? path.resolve(options.stageFrom) : path.join(REPO_ROOT, 'web', 'dist');
    if (!fs.existsSync(path.join(sourceDir, 'index.html'))) {
        throw new Error(`Built web output missing index.html at ${sourceDir}`);
    }
    const releaseId = options.releaseId || createReleaseId('web');
    const candidateDir = createReleaseDirectory(cfg.webReleasesDir, releaseId);
    await withProgress('复制前端静态文件', () => fs.promises.cp(sourceDir, candidateDir, { recursive: true, dereference: true }));

    const webInfo = resolveWebRootInfo(cfg.runtimeDir, path.join(REPO_ROOT, 'web', 'dist'), cfg.env);
    const activeWebDir = webInfo.webRoot;
    return { releaseId, dir: candidateDir, previousDir: fs.existsSync(activeWebDir) ? activeWebDir : null };
}

function switchWebRelease(cfg, stagedWeb) {
    const fallbackRoots = stagedWeb.previousDir && stagedWeb.previousDir !== stagedWeb.dir
        ? [stagedWeb.previousDir]
        : [];
    writeJsonAtomic(cfg.activeWebPath, {
        releaseId: stagedWeb.releaseId,
        webRoot: stagedWeb.dir,
        fallbackRoots,
        updatedAt: Date.now(),
    });
    recordActiveRelease(cfg, 'web', stagedWeb.releaseId);
}

async function stageBackendRelease(cfg, options = {}) {
    const releaseId = options.releaseId || createReleaseId('backend');
    const candidateDir = createReleaseDirectory(cfg.backendReleasesDir, releaseId);
    if (options.stageFrom) {
        const src = path.resolve(options.stageFrom);
        if (!fs.existsSync(src)) throw new Error(`Backend staging source does not exist: ${src}`);
        await withProgress('复制后端发布包', () => fs.promises.cp(src, candidateDir, { recursive: true, dereference: true }));
    } else {
        if (!options.skipBuild) {
            await buildSessionContract();
            await buildCore();
        }
        await withProgress('打包后端', progress => deployPnpmPackage('qq-farm-bot', candidateDir, progress.updateDetail));
        assertPathIsolatedFromWorkspace(candidateDir, ['client.js', 'dist/core/worker.js'], ['@qq-farm-bot/session-contract']);
    }

    const entryJs = path.join(candidateDir, 'client.js');
    if (!fs.existsSync(entryJs)) {
        throw new Error(`Candidate backend missing client.js: ${entryJs}`);
    }
    await runCommand(process.execPath, ['--check', entryJs]);
    return { releaseId, dir: candidateDir };
}

function resolveReleaseDir(baseDir, releaseId, fallbackLocalDir) {
    if (releaseId) {
        const candidate = path.join(baseDir, releaseId);
        if (fs.existsSync(candidate)) return { releaseId, dir: candidate };
    }
    if (fallbackLocalDir && fs.existsSync(fallbackLocalDir)) {
        return { releaseId: releaseId || 'workspace', dir: fallbackLocalDir };
    }
    return null;
}

function cleanupStaleUnixSocket(cfg, hostState) {
    if (process.platform === 'win32') return;
    if (hostState.state !== 'absent') return;
    if (fs.existsSync(cfg.socketEndpoint)) {
        if (!fs.lstatSync(cfg.socketEndpoint).isSocket()) throw new Error('IPC path is not a socket');
        fs.unlinkSync(cfg.socketEndpoint);
    }
}

function buildRoleEnv(cfg, role, releaseInfo) {
    const base = {
        ...cfg.env,
        NODE_ENV: cfg.env.NODE_ENV || 'production',
        FARM_DATA_DIR: cfg.dataDir,
        FARM_RUNTIME_DIR: cfg.runtimeDir,
        FARM_SESSION_SOCKET: cfg.socketConfigured,
        FARM_HOST_DATA_DIR: cfg.hostDataDir,
        FARM_HOST_LOG_DIR: cfg.hostLogDir,
        FARM_BACKEND_LOG_DIR: cfg.backendLogDir,
        FARM_RELEASE_ID: releaseInfo.releaseId,
        ADMIN_PORT: String(cfg.port),
    };
    if (role === 'backend') {
        base.FARM_SHARE_FILE = cfg.shareFilePath;
    }
    return base;
}

function spawnDetachedService({ command, args, cwd, env, logFile, pidFile }) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const outFd = fs.openSync(logFile, 'a');
    let child;
    try {
        child = spawn(command, args, {
            cwd,
            env,
            detached: true,
            stdio: ['ignore', outFd, outFd],
            windowsHide: true,
        });
    } finally {
        fs.closeSync(outFd);
    }
    if (!child.pid) throw new Error(`Failed to spawn ${command}`);
    fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');
    child.unref();
    return child.pid;
}

async function waitForHostReady(cfg, expectedPid = 0) {
    const deadline = Date.now() + cfg.startTimeoutMs;
    while (Date.now() < deadline) {
        if (expectedPid > 0 && !isProcessAlive(expectedPid)) {
            throw new Error(`session-host process pid=${expectedPid} exited before becoming ready`);
        }
        const host = await probeHost(cfg);
        if (host.state === 'ready' && (!expectedPid || host.pid === expectedPid)) return host;
        if (host.state === 'conflict') throw new Error(host.reason);
        await sleep(150);
    }
    throw new Error(`Timed out waiting for session-host readiness (${cfg.startTimeoutMs}ms)`);
}

async function waitForBackendReady(cfg, expectedPid, expectedHost) {
    const expectedOnlineSessionIds = expectedHost.sessions.filter(s => s.lifecycle === 'ONLINE').map(s => s.sessionId);
    const label = expectedOnlineSessionIds.length
        ? `等待后端接管 ${expectedOnlineSessionIds.length} 个在线会话`
        : '等待后端就绪';
    return withProgress(label, async () => {
        const deadline = Date.now() + cfg.startTimeoutMs;
        while (Date.now() < deadline) {
            if (expectedPid > 0 && !isProcessAlive(expectedPid)) {
                throw new Error(`backend process pid=${expectedPid} exited prematurely`);
            }
            const backend = await probeBackend(cfg);
            if (backend.state === 'conflict') throw new Error(backend.reason);
            if (backend.state === 'ready' && backend.pid === expectedPid && backend.hostConnected) {
                const host = await probeHost(cfg);
                if (host.state === 'ready' && host.hostInstanceId === expectedHost.hostInstanceId) {
                    const byId = new Map(host.sessions.map(s => [s.sessionId, s]));
                    const allReattached = expectedOnlineSessionIds.every((id) => {
                        const s = byId.get(id);
                        return s?.lifecycle === 'ONLINE' && s.businessState === 'ACTIVE' && s.attachedBackendId === backend.backendInstanceId;
                    });
                    if (allReattached) return backend;
                }
            }
            await sleep(150);
        }
        throw new Error(`Timed out waiting for backend HTTP & session attach readiness (${cfg.startTimeoutMs}ms)`);
    });
}

function cleanupBackendStateFiles(cfg) {
    removeStaleLock(cfg.backendLockPath);
    try {
        if (fs.existsSync(cfg.backendPidPath)) fs.unlinkSync(cfg.backendPidPath);
    } catch {}
    try {
        if (fs.existsSync(cfg.backendChildrenPath) && listAliveBackendChildren(cfg.backendChildrenPath).length === 0) {
            fs.unlinkSync(cfg.backendChildrenPath);
        }
    } catch {}
}

async function stopBackendProcess(cfg, spawnedPid = 0) {
    const backend = await probeBackend(cfg);
    if (backend.state === 'conflict') {
        throw new Error(`Refusing to stop backend on conflict: ${backend.reason}`);
    }
    const targetPids = new Set();
    if (backend.lock && isProcessAlive(backend.lock.pid, backend.lock.processStart)) targetPids.add(backend.lock.pid);
    if (spawnedPid && isProcessAlive(spawnedPid)) targetPids.add(spawnedPid);
    if (backend.pidFile && isProcessAlive(backend.pidFile) && !targetPids.has(backend.pidFile)) {
        throw new Error('Backend PID file points to a live process without matching writer ownership');
    }

    for (const pid of targetPids) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
    }

    const deadline = Date.now() + cfg.stopTimeoutMs;
    while (Date.now() < deadline) {
        const mainAlive = [...targetPids].some(pid => isProcessAlive(pid));
        const childrenAlive = listAliveBackendChildren(cfg.backendChildrenPath);
        const lock = readLockMetadata(cfg.backendLockPath);
        const lockHeld = Boolean(lock && isProcessAlive(lock.pid, lock.processStart));
        if (!mainAlive && childrenAlive.length === 0 && !lockHeld) {
            cleanupBackendStateFiles(cfg);
            return { stopped: true, forced: false };
        }
        await sleep(100);
    }

    for (const pid of targetPids) {
        if (isProcessAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
        }
    }
    for (const child of listAliveBackendChildren(cfg.backendChildrenPath)) {
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
    const afterKillDeadline = Date.now() + 3000;
    while (Date.now() < afterKillDeadline) {
        const mainAlive = [...targetPids].some(pid => isProcessAlive(pid));
        const childrenAlive = listAliveBackendChildren(cfg.backendChildrenPath);
        const lock = readLockMetadata(cfg.backendLockPath);
        if (!mainAlive && childrenAlive.length === 0 && !isProcessAlive(lock?.pid, lock?.processStart)) {
            cleanupBackendStateFiles(cfg);
            return { stopped: true, forced: true };
        }
        await sleep(100);
    }
    throw new Error('Backend or its workers are still running after the stop timeout');
}

async function stopHostProcess(cfg) {
    const host = await probeHost(cfg);
    if (host.state === 'conflict') {
        throw new Error(`Refusing to stop session-host on conflict: ${host.reason}`);
    }
    if (host.state === 'absent') {
        cleanupStaleUnixSocket(cfg, host);
        removeStaleLock(cfg.hostLockPath);
        try { if (fs.existsSync(cfg.hostPidPath)) fs.unlinkSync(cfg.hostPidPath); } catch {}
        return { stopped: true, forced: false };
    }
    const targetPid = host.pid || host.lock?.pid || host.pidFile;
    if (targetPid && (!host.lock || host.lock.pid !== targetPid || !isProcessAlive(targetPid, host.lock.processStart))) {
        throw new Error('Host PID file points to a live process without matching host ownership');
    }
    const targetAlive = () => isProcessAlive(targetPid, host.lock?.processStart);
    if (targetAlive()) {
        try { process.kill(targetPid, 'SIGTERM'); } catch {}
    }
    const deadline = Date.now() + cfg.stopTimeoutMs;
    while (Date.now() < deadline) {
        const lock = readLockMetadata(cfg.hostLockPath);
        const alive = targetAlive() || isProcessAlive(lock?.pid, lock?.processStart);
        if (!alive) {
            removeStaleLock(cfg.hostLockPath);
            try { if (fs.existsSync(cfg.hostPidPath)) fs.unlinkSync(cfg.hostPidPath); } catch {}
            return { stopped: true, forced: false };
        }
        await sleep(100);
    }
    if (targetAlive()) {
        try { process.kill(targetPid, 'SIGKILL'); } catch {}
        const afterKillDeadline = Date.now() + 2000;
        while (Date.now() < afterKillDeadline && targetAlive()) {
            await sleep(100);
        }
    }
    const lock = readLockMetadata(cfg.hostLockPath);
    if (targetAlive() || isProcessAlive(lock?.pid, lock?.processStart)) {
        throw new Error('Session host is still running after the stop timeout');
    }
    removeStaleLock(cfg.hostLockPath);
    try { if (fs.existsSync(cfg.hostPidPath)) fs.unlinkSync(cfg.hostPidPath); } catch {}
    return { stopped: true, forced: true };
}

function pruneOldReleases(releasesDir, slotState, keepCount = 3) {
    if (!fs.existsSync(releasesDir)) return;
    const pinned = new Set([slotState?.active, slotState?.previous].filter(Boolean));
    for (const id of (slotState?.history || []).slice(0, keepCount)) pinned.add(id);
    for (const entry of fs.readdirSync(releasesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (pinned.has(entry.name)) continue;
        try { fs.rmSync(path.join(releasesDir, entry.name), { recursive: true, force: true }); } catch {}
    }
}

function parseFlags(args) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-h') {
            flags.h = true;
            continue;
        }
        if (arg === '-v') {
            flags.verbose = true;
            continue;
        }
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const eqIdx = arg.indexOf('=');
        if (eqIdx > 0) {
            flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
            continue;
        }
        const key = arg.slice(2);
        const next = args[i + 1];
        if (['release', 'stage-host-from', 'stage-backend-from', 'stage-web-from'].includes(key) && next && !next.startsWith('-')) {
            flags[key] = next;
            i += 1;
        } else {
            flags[key] = true;
        }
    }
    return { positional, flags };
}

function withDeployLock(cfg, fn) {
    const handle = acquireExclusiveLock(cfg.deployLockPath, {
        role: 'deploy',
        instanceId: `deploy_${process.pid}`,
        nonce: crypto.randomUUID(),
    });
    return Promise.resolve()
        .then(() => fn(handle))
        .finally(() => {
            try { handle.release(); } catch {}
        });
}

async function followLogs(cfg) {
    const hostLog = path.join(cfg.hostLogDir, 'session-host.log');
    const backendLog = path.join(cfg.backendLogDir, 'service.log');
    const seen = new Map([[hostLog, 0], [backendLog, 0]]);
    for (const file of seen.keys()) {
        if (fs.existsSync(file)) {
            const stat = fs.statSync(file);
            const start = Math.max(0, stat.size - 4096);
            seen.set(file, stat.size);
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(stat.size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            fs.closeSync(fd);
            if (buf.length > 0) process.stdout.write(buf.toString('utf8'));
        }
    }
    let stopped = false;
    const stopTail = () => { stopped = true; };
    process.on('SIGINT', stopTail);
    process.on('SIGTERM', stopTail);
    console.log('Following logs (Ctrl-C only exits log viewer; services keep running)...');
    while (!stopped) {
        for (const [file, offset] of seen.entries()) {
            if (!fs.existsSync(file)) continue;
            const size = fs.statSync(file).size;
            if (size < offset) {
                seen.set(file, 0);
                continue;
            }
            if (size > offset) {
                const len = size - offset;
                const fd = fs.openSync(file, 'r');
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, offset);
                fs.closeSync(fd);
                process.stdout.write(buf.toString('utf8'));
                seen.set(file, size);
            }
        }
        await sleep(300);
    }
}

async function cmdStart(cfg, flags) {
    if (flags.rebuild || flags['force-build']) {
        console.error('已移除 start --rebuild/--force-build；在线更新请执行 `bash ./update.sh`。');
        return 1;
    }

    await withDeployLock(cfg, async () => {
        const host = await probeHost(cfg);
        const backend = await probeBackend(cfg);

        if (host.state === 'conflict') throw new Error(`Host conflict: ${host.reason}`);
        if (backend.state === 'conflict') throw new Error(`Backend conflict: ${backend.reason}`);
        if (host.state === 'starting') throw new Error(`session-host already exists (pid=${host.pid}) but IPC is not ready yet; wait and inspect status.`);

        if (host.state === 'absent' && backend.state !== 'absent') {
            console.log(`Detected stale backend (pid=${backend.pid}) without live session-host; stopping old backend before clean start...`);
            await stopBackendProcess(cfg);
        }

        let releases = readActiveReleases(cfg);
        let activeHost = host;
        if (host.state === 'absent') {
            cleanupStaleUnixSocket(cfg, host);
            let hostRel = resolveReleaseDir(cfg.hostReleasesDir, releases.host?.active);
            if (!hostRel) {
                hostRel = await stageHostRelease(cfg, {
                    skipBuild: Boolean(flags['skip-build']),
                    stageFrom: flags['stage-host-from'],
                });
                releases = recordActiveRelease(cfg, 'host', hostRel.releaseId);
            }
            const hostLogFile = path.join(cfg.hostLogDir, 'service.log');
            const hostPid = spawnDetachedService({
                command: process.execPath,
                args: [path.join(hostRel.dir, 'dist', 'session', 'host.js')],
                cwd: hostRel.dir,
                env: buildRoleEnv(cfg, 'host', hostRel),
                logFile: hostLogFile,
                pidFile: cfg.hostPidPath,
            });
            activeHost = await withProgress('等待会话宿主就绪', () => waitForHostReady(cfg, hostPid));
        }

        const latestBackend = await probeBackend(cfg);
        if (latestBackend.state === 'ready') {
            console.log(`Already running: session-host pid=${activeHost.pid} (${activeHost.hostInstanceId}), backend pid=${latestBackend.pid} (${latestBackend.backendInstanceId})`);
            return;
        }
        if (latestBackend.state === 'starting') {
            await waitForBackendReady(cfg, latestBackend.pid, activeHost);
            console.log(`Backend finished startup; session-host pid=${activeHost.pid} (${activeHost.hostInstanceId})`);
            return;
        }

        let webRel = resolveReleaseDir(cfg.webReleasesDir, releases.web?.active);
        if (!webRel) {
            const stagedWeb = await stageWebRelease(cfg, {
                skipBuild: Boolean(flags['skip-build']),
                stageFrom: flags['stage-web-from'],
            });
            switchWebRelease(cfg, stagedWeb);
            webRel = stagedWeb;
            releases = readActiveReleases(cfg);
        } else if (!fs.existsSync(cfg.activeWebPath)) {
            writeJsonAtomic(cfg.activeWebPath, { releaseId: webRel.releaseId, webRoot: webRel.dir, fallbackRoots: [], updatedAt: Date.now() });
        }

        let backendRel = resolveReleaseDir(cfg.backendReleasesDir, releases.backend?.active);
        if (!backendRel) {
            backendRel = await stageBackendRelease(cfg, {
                skipBuild: Boolean(flags['skip-build']),
                stageFrom: flags['stage-backend-from'],
            });
            releases = recordActiveRelease(cfg, 'backend', backendRel.releaseId);
        }

        const backendLogFile = path.join(cfg.backendLogDir, 'service.log');
        const backendPid = spawnDetachedService({
            command: process.execPath,
            args: [path.join(backendRel.dir, 'client.js')],
            cwd: backendRel.dir,
            env: buildRoleEnv(cfg, 'backend', backendRel),
            logFile: backendLogFile,
            pidFile: cfg.backendPidPath,
        });
        try {
            const startedBackend = await waitForBackendReady(cfg, backendPid, activeHost);
            console.log(`已启动：会话宿主 pid=${activeHost.pid} (${activeHost.hostInstanceId})，后端 pid=${startedBackend.pid} (${startedBackend.backendInstanceId})`);
        } catch (err) {
            // Only clean up the backend we spawned; never stop session-host.
            if (isProcessAlive(backendPid)) {
                try { process.kill(backendPid, 'SIGTERM'); } catch {}
                await stopBackendProcess(cfg).catch(() => {});
            }
            throw err;
        }
    });

    if (flags.follow) {
        await followLogs(cfg);
    }
    return 0;
}

async function cmdStatus(cfg, flags) {
    const host = await probeHost(cfg);
    const backend = await probeBackend(cfg);
    const releases = readActiveReleases(cfg);
    const webInfo = resolveWebRootInfo(cfg.runtimeDir, path.join(REPO_ROOT, 'web', 'dist'), cfg.env);
    const payload = {
        ok: host.state !== 'conflict' && backend.state !== 'conflict',
        host: {
            state: host.state,
            pid: host.pid || 0,
            hostInstanceId: host.hostInstanceId || '',
            releaseId: host.releaseId || '',
            ipcVersion: host.ipcVersion || 0,
            reason: host.reason || '',
        },
        backend: {
            state: backend.state,
            pid: backend.pid || 0,
            backendInstanceId: backend.backendInstanceId || '',
            releaseId: backend.releaseId || '',
            hostConnected: Boolean(backend.hostConnected),
            aliveChildrenCount: backend.aliveChildren?.length || 0,
            reason: backend.reason || '',
        },
        sessions: host.sessions || [],
        releases,
        web: webInfo,
        locks: {
            deploy: readLockMetadata(cfg.deployLockPath),
            host: readLockMetadata(cfg.hostLockPath),
            backend: readLockMetadata(cfg.backendLockPath),
        },
    };
    if (flags.json) {
        console.log(JSON.stringify(payload, null, 2));
    } else {
        console.log(`session-host : ${payload.host.state} (pid=${payload.host.pid || '-'}, instance=${payload.host.hostInstanceId || '-'}, release=${payload.host.releaseId || '-'})`);
        console.log(`backend      : ${payload.backend.state} (pid=${payload.backend.pid || '-'}, instance=${payload.backend.backendInstanceId || '-'}, release=${payload.backend.releaseId || '-'}, hostConnected=${payload.backend.hostConnected})`);
        console.log(`webRoot      : ${webInfo.webRoot} (release=${webInfo.releaseId || '-'}, source=${webInfo.source})`);
        console.log(`sessions     : ${payload.sessions.length} (${payload.sessions.map(s => `${s.accountId}:${s.lifecycle}/${s.businessState}`).join(', ') || 'none'})`);
    }
    return 0;
}

async function swapBackendToRelease(cfg, targetRel, expectedHost) {
    const hostState = await probeHost(cfg);
    if (hostState.state !== 'ready' || hostState.hostInstanceId !== expectedHost.hostInstanceId) {
        throw new Error('构建期间会话宿主已改变，请重新执行更新。');
    }
    const releasesBefore = readActiveReleases(cfg);
    const prevReleaseId = releasesBefore.backend?.active && releasesBefore.backend.active !== targetRel.releaseId
        ? releasesBefore.backend.active
        : null;
    const prevRel = prevReleaseId ? resolveReleaseDir(cfg.backendReleasesDir, prevReleaseId) : null;

    if (hostState.ipcVersion && hostState.ipcVersion !== SESSION_IPC_VERSION) {
        throw new Error(`Incompatible host IPC version ${hostState.ipcVersion} (expected ${SESSION_IPC_VERSION})`);
    }

    await withProgress('等待旧后端退出', () => stopBackendProcess(cfg));

    const backendLogFile = path.join(cfg.backendLogDir, 'service.log');
    let newPid = 0;
    try {
        newPid = spawnDetachedService({
            command: process.execPath,
            args: [path.join(targetRel.dir, 'client.js')],
            cwd: targetRel.dir,
            env: buildRoleEnv(cfg, 'backend', targetRel),
            logFile: backendLogFile,
            pidFile: cfg.backendPidPath,
        });
        const ready = await waitForBackendReady(cfg, newPid, hostState);
        const updatedReleases = recordActiveRelease(cfg, 'backend', targetRel.releaseId);
        pruneOldReleases(cfg.backendReleasesDir, updatedReleases.backend);
        return ready;
    } catch (err) {
        await stopBackendProcess(cfg, newPid);
        if (prevRel) {
            console.error(`Candidate backend ${targetRel.releaseId} failed readiness (${err.message}); rolling back to ${prevRel.releaseId}...`);
            const rbPid = spawnDetachedService({
                command: process.execPath,
                args: [path.join(prevRel.dir, 'client.js')],
                cwd: prevRel.dir,
                env: buildRoleEnv(cfg, 'backend', prevRel),
                logFile: backendLogFile,
                pidFile: cfg.backendPidPath,
            });
            await waitForBackendReady(cfg, rbPid, hostState);
        }
        throw err;
    }
}

async function cmdUpdate(cfg, positional, flags) {
    const target = (positional[0] || 'all').toLowerCase();
    if (!['all', 'backend', 'web'].includes(target)) {
        throw new Error(`Unsupported update target: ${target}. Use all, backend, or web.`);
    }

    return withDeployLock(cfg, async () => {
        if (target === 'web') {
            const stagedWeb = await stageWebRelease(cfg, {
                skipBuild: Boolean(flags['skip-build']),
                stageFrom: flags['stage-web-from'],
            });
            switchWebRelease(cfg, stagedWeb);
            const updated = readActiveReleases(cfg);
            pruneOldReleases(cfg.webReleasesDir, updated.web);
            console.log(`前端已更新至 ${stagedWeb.releaseId}，后端与会话宿主未重启。`);
            return 0;
        }

        const host = await probeHost(cfg);
        if (host.state === 'conflict') throw new Error(`Host conflict: ${host.reason}`);
        if (host.state !== 'ready') {
            throw new Error(`session-host is ${host.state}; run 'start' first (update never restarts session-host).`);
        }

        const stagedWeb = target === 'all' ? await stageWebRelease(cfg, {
            skipBuild: Boolean(flags['skip-build']),
            stageFrom: flags['stage-web-from'],
        }) : null;

        // Build & validate candidate BEFORE stopping running backend so failed builds/isolation keep backend untouched.
        const candidateBackend = await stageBackendRelease(cfg, {
            skipBuild: Boolean(flags['skip-build']),
            stageFrom: flags['stage-backend-from'],
        });
        const beforeSwap = await probeHost(cfg);
        if (beforeSwap.state !== 'ready' || beforeSwap.hostInstanceId !== host.hostInstanceId) {
            throw new Error('Session host changed while staging the update');
        }
        const ready = await swapBackendToRelease(cfg, candidateBackend, beforeSwap);
        if (stagedWeb) {
            switchWebRelease(cfg, stagedWeb);
            pruneOldReleases(cfg.webReleasesDir, readActiveReleases(cfg).web);
            console.log(`前后端已更新：后端 ${candidateBackend.releaseId} (pid=${ready.pid})，前端 ${stagedWeb.releaseId}，会话宿主 ${host.hostInstanceId} 保持在线。`);
        } else {
            console.log(`后端已更新至 ${candidateBackend.releaseId} (pid=${ready.pid})，会话宿主 ${host.hostInstanceId} 保持在线。`);
        }
        return 0;
    });
}

async function cmdStop(cfg, positional) {
    const target = (positional[0] || '').toLowerCase();
    if (!target || !['backend', 'host', 'all'].includes(target)) {
        console.error('Usage: bash ./stop.sh <backend|host|all>');
        console.error('为避免误断游戏连接，请指定要停止的服务：');
        console.error('  bash ./stop.sh backend  只停后端，游戏挂机保持在线');
        console.error('  bash ./stop.sh all      全部停止（后端 + 会话宿主，会断开游戏）');
        console.error('  bash ./stop.sh host     只停会话宿主（会断开游戏）');
        return 1;
    }

    await withDeployLock(cfg, async () => {
        if (target === 'backend' || target === 'all') {
            await withProgress('停止后端', () => stopBackendProcess(cfg));
        }
        if (target === 'host' || target === 'all') {
            await withProgress('停止会话宿主', () => stopHostProcess(cfg));
        }
    });
    if (target === 'backend') {
        console.log('后端已停止，游戏连接仍在会话宿主中保持在线。');
    } else if (target === 'host') {
        console.log('会话宿主已停止，在线游戏连接已断开。');
    } else {
        console.log('全部服务已停止，在线游戏连接已断开。');
    }
    return 0;
}

async function cmdRollback(cfg, positional, flags) {
    const target = (positional[0] || 'backend').toLowerCase();
    if (!['backend', 'web'].includes(target)) {
        throw new Error(`Unsupported rollback target: ${target}. Use backend or web.`);
    }
    return withDeployLock(cfg, async () => {
        const releases = readActiveReleases(cfg);
        const slot = releases[target] || {};
        const targetId = typeof flags.release === 'string' && flags.release ? flags.release : slot.previous;
        if (!targetId) {
            throw new Error(`No previous ${target} release recorded to roll back to (pass --release <id>).`);
        }
        if (target === 'web') {
            const dir = path.join(cfg.webReleasesDir, targetId);
            if (!fs.existsSync(path.join(dir, 'index.html'))) {
                throw new Error(`Target web release missing: ${dir}`);
            }
            const webInfo = resolveWebRootInfo(cfg.runtimeDir, path.join(REPO_ROOT, 'web', 'dist'), cfg.env);
            switchWebRelease(cfg, {
                releaseId: targetId,
                dir,
                previousDir: webInfo.webRoot && fs.existsSync(webInfo.webRoot) ? webInfo.webRoot : null,
            });
            console.log(`Rolled back web to ${targetId}.`);
            return 0;
        }
        const host = await probeHost(cfg);
        if (host.state !== 'ready') throw new Error(`session-host is ${host.state}; cannot attach rolled-back backend.`);
        const rel = resolveReleaseDir(cfg.backendReleasesDir, targetId);
        if (!rel) throw new Error(`Target backend release missing: ${targetId}`);
        await runCommand(process.execPath, ['--check', path.join(rel.dir, 'client.js')]);
        const ready = await swapBackendToRelease(cfg, rel, host);
        console.log(`Rolled back backend to ${targetId} (pid=${ready.pid}, hostInstanceId=${host.hostInstanceId} preserved).`);
        return 0;
    });
}

async function cmdHostHealthcheck(cfg) {
    const host = await probeHost(cfg);
    console.log(JSON.stringify({
        ok: host.state === 'ready',
        state: host.state,
        pid: host.pid || 0,
        hostInstanceId: host.hostInstanceId || '',
        reason: host.reason || '',
    }));
    return host.state === 'ready' ? 0 : 1;
}

async function main() {
    const argv = process.argv.slice(2);
    const subcommand = argv[0];
    if (!subcommand || subcommand === '-h' || subcommand === '--help') {
        console.log('Usage: service-control.mjs <start|status|update|stop|rollback|host-healthcheck> [options] [--verbose]');
        process.exit(0);
    }

    const { positional, flags } = parseFlags(argv.slice(1));
    if (flags.help || flags.h) {
        console.log('Usage: service-control.mjs <start|status|update|stop|rollback|host-healthcheck> [options] [--verbose]');
        process.exit(0);
    }

    const cfg = getControlConfig(process.env);
    let exitCode = 0;
    switch (subcommand) {
        case 'start':
            exitCode = await cmdStart(cfg, flags);
            break;
        case 'status':
            exitCode = await cmdStatus(cfg, flags);
            break;
        case 'update':
            exitCode = await cmdUpdate(cfg, positional, flags);
            break;
        case 'stop':
            exitCode = await cmdStop(cfg, positional);
            break;
        case 'rollback':
            exitCode = await cmdRollback(cfg, positional, flags);
            break;
        case 'host-healthcheck':
            exitCode = await cmdHostHealthcheck(cfg);
            break;
        default:
            console.error(`Unknown subcommand: ${subcommand}`);
            exitCode = 1;
    }
    process.exit(exitCode);
}

function exitWithError(err) {
    if (!VERBOSE_OUTPUT && err?.commandOutput && !err._outputPrinted) {
        console.error(err.commandOutput);
        err._outputPrinted = true;
    }
    console.error(`[service-control] ${err?.message || err}`);
    process.exit(1);
}

main().catch(exitWithError);
