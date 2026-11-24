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
const { RELEASE_META_FILENAME, compareReleaseVersions, pairedWebReleases, readBackupEnabled, readReleaseIpcVersion, readReleaseMeta, readReleaseVersions } = require('../core/src/services/release-compat.js');
const { buildEnv, compareComponents, hostMaintenanceMessage, inspectInstallation, runningComponents, targetFingerprints, turboArgs } = require('../core/src/services/update-plan.js');

const VERBOSE_OUTPUT = process.argv.includes('--verbose')
    || process.argv.includes('-v')
    || process.env.FARM_DEPLOY_VERBOSE === '1';

const RELEASE_HISTORY_LIMIT = Math.max(3, Number.parseInt(process.env.FARM_MAX_RELEASES, 10) || 10);
const PREVIOUS_WEB_ASSETS = '.previous-web';
const UPDATE_JOB_FILE = process.env.FARM_UPDATE_JOB_FILE ? path.resolve(process.env.FARM_UPDATE_JOB_FILE) : '';
delete process.env.FARM_UPDATE_JOB_FILE;
const updateJobRecentLines = [];

function writeUpdateJobPatch(patch = {}, logLine = '') {
    if (!UPDATE_JOB_FILE) return;
    try {
        if (logLine) {
            for (const part of String(logLine).split(/\r?\n/)) {
                const line = part.trim();
                if (!line) continue;
                updateJobRecentLines.push(line);
                if (updateJobRecentLines.length > 30) updateJobRecentLines.shift();
            }
        }
        const existing = readJsonSafe(UPDATE_JOB_FILE) || {};
        const next = {
            ...existing,
            ...patch,
            updatedAt: Date.now(),
            recentLines: updateJobRecentLines.length > 0 ? [...updateJobRecentLines] : (existing.recentLines || []),
        };
        writeJsonAtomic(UPDATE_JOB_FILE, next);
    } catch {}
}

if (UPDATE_JOB_FILE) writeUpdateJobPatch({ pid: process.pid });

let workspaceInstall;
let coreBuild;
let pnpmInvocation;
let contractEntry = path.join(REPO_ROOT, 'packages/session-contract/dist/index.js');
if (!fs.existsSync(contractEntry)) {
    // The controller can still use the installed host's contract after workspace outputs are cleaned.
    const runtime = process.env.FARM_RUNTIME_DIR || path.join(REPO_ROOT, 'runtime');
    const hostId = readJsonSafe(path.join(runtime, 'session-host.lock'))?.releaseId;
    if (typeof hostId === 'string' && /^host-[\w.-]+$/.test(hostId)) {
        const releases = process.env.FARM_RELEASES_DIR || path.join(REPO_ROOT, 'releases');
        const installed = path.resolve(releases, 'host', hostId, 'node_modules/@qq-farm-bot/session-contract/dist/index.js');
        if (fs.existsSync(installed)) contractEntry = installed;
    }
}
if (['start', 'update'].includes(process.argv[2]) && !fs.existsSync(contractEntry)) {
    try {
        await buildComponents(['contract'], '准备基础组件');
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
        contract,
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
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, filePath);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
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
    const raw = fs.existsSync(cfg.activeReleasesPath) ? JSON.parse(fs.readFileSync(cfg.activeReleasesPath, 'utf8')) : {};
    return {
        host: raw.host || { active: null, previous: null, history: [] },
        backend: raw.backend || { active: null, previous: null, history: [] },
        web: raw.web || { active: null, previous: null, history: [] },
    };
}

function nextReleaseSlot(slot, releaseId, keepBackups = true, discardedId = null, restoring = false) {
    const history = [releaseId, ...(slot.history || []).filter(id => id !== releaseId && id !== discardedId)];
    const previous = keepBackups && slot.active && slot.active !== releaseId ? slot.active : history[1] || null;
    return {
        active: releaseId, previous, history: keepBackups ? history.slice(0, RELEASE_HISTORY_LIMIT) : history,
        restoredBackup: !keepBackups && (releaseId === slot.active ? slot.restoredBackup : restoring) || undefined,
        updatedAt: Date.now(),
    };
}

function recordActiveRelease(cfg, kind, releaseId) {
    const state = readActiveReleases(cfg);
    state[kind] = nextReleaseSlot(state[kind], releaseId);
    writeJsonAtomic(cfg.activeReleasesPath, state);
    return state;
}

function writeBackendReleaseMeta(backendRel, pairedWebReleaseId) {
    const git = spawnSync('git', ['log', '-1', '--format=%H%n%h%n%s'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
    const [commit = '', shortCommit = '', commitSubject = ''] = git.status === 0 ? git.stdout.trim().split(/\r?\n/) : [];
    writeJsonAtomic(path.join(backendRel.dir, RELEASE_META_FILENAME), {
        releaseId: backendRel.releaseId,
        createdAt: Date.now(),
        commit,
        shortCommit,
        commitSubject,
        pairedWebReleaseId,
    });
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
                    ipcVersion: (lockAlive && lock.releaseId && readReleaseIpcVersion(path.join(cfg.hostReleasesDir, lock.releaseId))) || SESSION_IPC_VERSION,
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
    if (/transforming\.{0,3}/i.test(line)) return '正在编译页面';
    if ((match = line.match(/(\d+)\s+modules transformed/i))) return `已编译 ${match[1]} 个页面文件`;
    if (/rendering chunks/i.test(line)) return '正在打包页面文件';
    if (/computing gzip size/i.test(line)) return '正在整理发布文件';
    if ((match = line.match(/built in\s+([0-9.]+(?:ms|s))/i))) return `页面打包完成（${match[1]}）`;
    if (/cache hit/i.test(line)) return '已复用上次的编译结果';
    if (/qq-farm-bot:build:.*tsc/i.test(line)) return '正在编译服务端代码';
    if ((match = line.match(/Progress:\s*resolved\s+(\d+),\s*reused\s+(\d+),\s*downloaded\s+(\d+),\s*added\s+(\d+)/i))) {
        return `已检查 ${match[1]} 项依赖，已复用 ${match[2]} 项，已下载 ${match[3]} 项`;
    }
    if ((match = line.match(/Packages:\s*\+(\d+)/i)) || (match = line.match(/\|\s*\+(\d+)\s*\++/i))) {
        return `正在安装 ${match[1]} 项依赖`;
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
        writeUpdateJobPatch({ status: 'running', phase: label, detail }, `${label}：${detail}（${elapsed()} 秒）`);
        if (VERBOSE_OUTPUT) return;
        if (isTty) {
            renderTty();
            return;
        }
        lastLoggedAt = performance.now();
        console.error(`[发布] ${label} · ${detail}（已用时 ${elapsed()} 秒）`);
    };

    writeUpdateJobPatch({ status: 'running', phase: label, detail: '' }, `开始${label}…`);

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
        writeUpdateJobPatch({ status: 'running', phase: label, detail }, `已完成「${label}」（${elapsed()} 秒）`);
        if (isTty) {
            process.stderr.write(`\r\x1b[2K[发布] ✓ ${label} (${elapsed()}s)\n`);
        } else {
            console.error(`[发布] 已完成「${label}」，用时 ${elapsed()} 秒`);
        }
        return result;
    } catch (err) {
        clearInterval(timer);
        writeUpdateJobPatch({ status: 'running', phase: label, detail }, `「${label}」失败（${elapsed()} 秒）`);
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
            env: options.env || process.env,
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
    return workspaceInstall ??= (async () => {
        const install = inspectInstallation(REPO_ROOT);
        if (!install.needed) return;
        await withProgress('安装所需依赖', progress => runPnpm(['install', '--frozen-lockfile', '--prod=false', '--prefer-offline'], { onProgress: progress.updateDetail }));
        const installed = inspectInstallation(REPO_ROOT);
        if (!installed.valid) throw new Error('依赖安装完成后仍缺少必要组件，请检查网络或手动执行 pnpm install。');
        fs.mkdirSync(path.dirname(install.file), { recursive: true });
        fs.writeFileSync(install.file, installed.fingerprint);
    })();
}

async function buildComponents(components, label) {
    await ensureBuildDependencies();
    const pnpm = await (pnpmInvocation ??= resolvePnpmInvocation());
    const env = buildEnv(pnpm.cmd);
    const args = turboArgs(REPO_ROOT, components);
    if (!VERBOSE_OUTPUT) args.push('--output-logs=new-only');
    return withProgress(label, progress => runCommand(process.execPath, args, { env, onProgress: progress.updateDetail }));
}

function buildCore() {
    return coreBuild ??= buildComponents(['backend'], '编译服务端和游戏连接服务');
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

function removeRelease(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        return true;
    } catch (err) {
        logUpdate(`清理 ${dir} 失败：${err.message}`);
        return false;
    }
}

async function stageRelease(releasesDir, releaseId, populate) {
    const dir = createReleaseDirectory(releasesDir, releaseId);
    try {
        await populate(dir);
        return { releaseId, dir };
    } catch (err) {
        removeRelease(dir);
        throw err;
    }
}

async function stageHostRelease(cfg, options = {}) {
    const releaseId = options.releaseId || createReleaseId('host');
    const candidateDir = createReleaseDirectory(cfg.hostReleasesDir, releaseId);
    if (options.stageFrom) {
        const src = path.resolve(options.stageFrom);
        if (!fs.existsSync(src)) throw new Error(`Host staging source does not exist: ${src}`);
        await withProgress('复制游戏连接服务', () => fs.promises.cp(src, candidateDir, { recursive: true, dereference: true }));
    } else {
        if (!options.skipBuild) {
            await buildCore();
        }
        await withProgress('打包游戏连接服务', progress => deployPnpmPackage('qq-farm-bot', candidateDir, progress.updateDetail));
        assertPathIsolatedFromWorkspace(candidateDir, ['dist/session/host.js', 'dist/session/gateway-worker.js'], ['@qq-farm-bot/session-contract']);
    }
    await runCommand(process.execPath, ['--check', path.join(candidateDir, 'dist/session/host.js')]);
    return { releaseId, dir: candidateDir };
}

async function stageWebRelease(cfg, options = {}) {
    if (!options.skipBuild && !options.stageFrom) {
        await buildComponents(['web'], '编译网页端');
    }
    const sourceDir = options.stageFrom ? path.resolve(options.stageFrom) : path.join(REPO_ROOT, 'web', 'dist');
    if (!fs.existsSync(path.join(sourceDir, 'index.html'))) {
        throw new Error(`Built web output missing index.html at ${sourceDir}`);
    }
    const releaseId = options.releaseId || createReleaseId('web');
    const previousDir = runningComponents(cfg).web.dir;
    const staged = await stageRelease(cfg.webReleasesDir, releaseId, dir =>
        withProgress('保存网页端文件', () => fs.promises.cp(sourceDir, dir, {
            recursive: true, dereference: true, filter: file => file !== path.join(sourceDir, PREVIOUS_WEB_ASSETS),
        })));
    return { ...staged, previousDir };
}

function webFallbackRoots(web, removingPrevious) {
    if (!web.previousDir || web.previousDir === web.dir) return [];
    if (!removingPrevious) return [web.previousDir];
    // Open tabs may request lazy chunks after the switch. Keep only missing assets from one generation.
    const oldAssets = path.join(web.previousDir, 'assets');
    if (!fs.existsSync(oldAssets)) return [];
    const fallback = path.join(web.dir, PREVIOUS_WEB_ASSETS);
    // A rollback can select a release that previously supplied its own fallback.
    fs.rmSync(fallback, { recursive: true, force: true });
    fs.cpSync(oldAssets, path.join(fallback, 'assets'), {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
        filter: file => fs.statSync(file).isDirectory() || !fs.existsSync(path.join(web.dir, 'assets', path.relative(oldAssets, file))),
    });
    return [fallback];
}

function activateReleases(cfg, { backend, web, previousBackend, keepBackups = true, restoring = false }) {
    const previous = readActiveReleases(cfg);
    const next = { ...previous };
    const savedBackend = previous.backend.restoredBackup && previous.backend.active;
    const discardedBackend = previousBackend && !keepBackups && previousBackend.releaseId !== savedBackend && previousBackend.releaseId !== backend.releaseId
        ? previousBackend : null;
    if (backend) next.backend = nextReleaseSlot(previous.backend, backend.releaseId, keepBackups, discardedBackend?.releaseId, restoring);

    let discardedWeb = null;
    let pair = null;
    let pointer;
    if (web) {
        const id = web.previousDir && path.relative(cfg.webReleasesDir, web.previousDir);
        const savedWeb = previous.web.restoredBackup && previous.web.active;
        if (!keepBackups && id !== web.releaseId && /^web-[\w.-]+$/.test(id)) {
            if (!backend) {
                const activeId = runningComponents(cfg).backend?.id || previous.backend.active;
                const active = resolveReleaseDir(cfg.backendReleasesDir, activeId);
                const meta = active && readReleaseMeta(active.dir);
                if (meta && activeId !== savedBackend && (!meta.pairedWebReleaseId || meta.pairedWebReleaseId === id)) {
                    pair = { id: activeId, file: path.join(active.dir, RELEASE_META_FILENAME), meta };
                }
            }
            const refs = backendWebReferences(cfg, [discardedBackend?.releaseId, pair?.id]);
            if (id !== savedWeb && !refs.includes(id)) discardedWeb = id;
        }
        next.web = nextReleaseSlot(previous.web, web.releaseId, keepBackups, discardedWeb, restoring);
        pointer = { releaseId: web.releaseId, webRoot: web.dir, fallbackRoots: webFallbackRoots(web, Boolean(discardedWeb)), updatedAt: Date.now() };
    }

    // Publish the web pointer last. Both old packages remain usable if any write fails.
    let stateWritten = false;
    let pairWritten = false;
    try {
        if (pair) {
            writeJsonAtomic(pair.file, { ...pair.meta, pairedWebReleaseId: web.releaseId });
            pairWritten = true;
        }
        writeJsonAtomic(cfg.activeReleasesPath, next);
        stateWritten = true;
        if (web) writeJsonAtomic(cfg.activeWebPath, pointer);
    } catch (err) {
        if (stateWritten) writeJsonAtomic(cfg.activeReleasesPath, previous);
        if (pairWritten) writeJsonAtomic(pair.file, pair.meta);
        throw err;
    }
    const backendRemoved = !discardedBackend || removeRelease(discardedBackend.dir);
    if (discardedWeb && backendRemoved) removeRelease(web.previousDir);
}

async function stageBackendRelease(cfg, options = {}) {
    const releaseId = options.releaseId || createReleaseId('backend');
    return stageRelease(cfg.backendReleasesDir, releaseId, async candidateDir => {
        if (options.stageFrom) {
            const src = path.resolve(options.stageFrom);
            if (!fs.existsSync(src)) throw new Error(`Backend staging source does not exist: ${src}`);
            await withProgress('复制服务端文件', () => fs.promises.cp(src, candidateDir, { recursive: true, dereference: true }));
        } else {
            if (!options.skipBuild) await buildCore();
            await withProgress('打包服务端', progress => deployPnpmPackage('qq-farm-bot', candidateDir, progress.updateDetail));
            assertPathIsolatedFromWorkspace(candidateDir, ['client.js', 'dist/core/worker.js'], ['@qq-farm-bot/session-contract']);
        }
        const entryJs = path.join(candidateDir, 'client.js');
        if (!fs.existsSync(entryJs)) {
            throw new Error(`Candidate backend missing client.js: ${entryJs}`);
        }
        await runCommand(process.execPath, ['--check', entryJs]);
    });
}

function resolveReleaseDir(baseDir, releaseId) {
    if (typeof releaseId !== 'string' || !releaseId.startsWith(path.basename(baseDir) + '-') || !/^[\w.-]+$/.test(releaseId)) return null;
    const dir = path.join(baseDir, releaseId);
    return fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() ? { releaseId, dir } : null;
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
        base.FARM_REPO_ROOT = cfg.repoRoot;
        base.FARM_RELEASES_DIR = cfg.releasesDir;
        base.FARM_CONTROL_MANAGED = '1';
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
        ? `恢复 ${expectedOnlineSessionIds.length} 个在线账号`
        : '等待服务端就绪';
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

function pruneOldReleases(releasesDir, slotState, keepCount = RELEASE_HISTORY_LIMIT, references = []) {
    if (!fs.existsSync(releasesDir)) return;
    const pinned = new Set([slotState?.active, slotState?.previous, ...references]);
    for (const id of (slotState?.history || []).slice(0, keepCount)) pinned.add(id);
    for (const entry of fs.readdirSync(releasesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (pinned.has(entry.name)) continue;
        try { fs.rmSync(path.join(releasesDir, entry.name), { recursive: true, force: true }); } catch {}
    }
}

function backendWebReferences(cfg, exclude = []) {
    const backends = fs.existsSync(cfg.backendReleasesDir)
        ? fs.readdirSync(cfg.backendReleasesDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name.startsWith('backend-') && !exclude.includes(entry.name))
            .map(entry => entry.name)
        : [];
    return pairedWebReleases(cfg.backendReleasesDir, backends);
}

function pruneWebReleases(cfg) {
    const refs = backendWebReferences(cfg);
    const web = resolveWebRootInfo(cfg.runtimeDir, path.join(REPO_ROOT, 'web/dist'), cfg.env);
    for (const dir of [web.webRoot, ...web.fallbackRoots]) refs.push(path.relative(cfg.webReleasesDir, dir));
    pruneOldReleases(cfg.webReleasesDir, readActiveReleases(cfg).web, RELEASE_HISTORY_LIMIT, refs);
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
        if (['release', 'web-release', 'stage-host-from', 'stage-backend-from', 'stage-web-from'].includes(key) && next && !next.startsWith('-')) {
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
                pruneOldReleases(cfg.hostReleasesDir, releases.host, 2);
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
            activeHost = await withProgress('启动游戏连接服务', () => waitForHostReady(cfg, hostPid));
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
            activateReleases(cfg, { web: stagedWeb });
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
            writeBackendReleaseMeta(backendRel, runningComponents(cfg).web.id);
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

async function swapBackendToRelease(cfg, targetRel, expectedHost, options = {}) {
    const hostState = await probeHost(cfg);
    if (hostState.state !== 'ready' || hostState.hostInstanceId !== expectedHost.hostInstanceId) {
        throw new Error('构建期间会话宿主已改变，请重新执行更新。');
    }
    const prevRunningId = runningComponents(cfg).backend?.id;
    const prevRel = resolveReleaseDir(cfg.backendReleasesDir, prevRunningId || readActiveReleases(cfg).backend.active);

    assertBackendIpc(targetRel.dir, hostState);

    await withProgress('停止旧版服务', () => stopBackendProcess(cfg));

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
        await waitForBackendReady(cfg, newPid, hostState);
        activateReleases(cfg, { backend: targetRel, previousBackend: prevRel, ...options });
    } catch (err) {
        await stopBackendProcess(cfg, newPid);
        if (prevRunningId && prevRel) {
            logUpdate(`切换失败，正在恢复原服务端：${err.message}`);
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

function assertBackendIpc(dir, host) {
    const ipc = readReleaseIpcVersion(dir);
    if (ipc !== host.ipcVersion) {
        throw new Error(`服务端与在线的游戏连接服务不兼容（所需协议版本 ${ipc || '未知'}，在线版本 ${host.ipcVersion}），已取消切换。`);
    }
}

async function cmdUpdate(cfg, positional, flags) {
    const target = (positional[0] || 'all').toLowerCase();
    if (!['all', 'backend', 'web'].includes(target)) {
        throw new Error(`Unsupported update target: ${target}. Use all, backend, or web.`);
    }

    return withDeployLock(cfg, async () => {
        const keepBackups = readBackupEnabled(cfg.runtimeDir);
        const requested = target === 'all' ? ['web', 'backend'] : [target];
        const fromSource = requested.filter(key => !flags['skip-build'] && !flags[`stage-${key}-from`]);
        let selected = requested;
        if (fromSource.length) {
            await ensureBuildDependencies();
            const plan = compareComponents(await targetFingerprints(REPO_ROOT), runningComponents(cfg));
            selected = requested.filter(key => !fromSource.includes(key) || plan[key]);
            const maintenance = hostMaintenanceMessage(plan.host);
            if (maintenance) logUpdate(maintenance);
        }
        if (!selected.length) {
            const components = target === 'all' ? '网页端和服务端' : target === 'web' ? '网页端' : '服务端';
            logUpdate(`${components}无需更新。`);
            return 0;
        }
        const host = selected.includes('backend') ? await probeHost(cfg) : null;
        if (host && host.state !== 'ready') {
            throw new Error(`无法更新服务端：游戏连接服务当前未就绪（${host.reason || '请先执行 bash ./start.sh 启动服务'}）。`);
        }
        const build = selected.filter(key => fromSource.includes(key));
        if (build.length) {
            await buildComponents(
                build,
                build.length === 2 ? '编译网页端和服务端' : build[0] === 'web' ? '编译网页端' : '编译服务端',
            );
        }
        if (host) assertBackendIpc(path.resolve(flags['stage-backend-from'] || path.join(REPO_ROOT, 'core')), host);
        let web;
        let backend;
        try {
            if (selected.includes('web')) web = await stageWebRelease(cfg, { skipBuild: true, stageFrom: flags['stage-web-from'] });
            if (host) {
                backend = await stageBackendRelease(cfg, { skipBuild: true, stageFrom: flags['stage-backend-from'] });
                writeBackendReleaseMeta(backend, web?.releaseId || runningComponents(cfg).web.id);
                const beforeSwap = await probeHost(cfg);
                if (beforeSwap.state !== 'ready' || beforeSwap.hostInstanceId !== host.hostInstanceId) {
                    throw new Error('准备新版期间，游戏连接服务发生了变化，已取消切换。');
                }
                await swapBackendToRelease(cfg, backend, beforeSwap, { web, keepBackups });
            } else {
                activateReleases(cfg, { web, keepBackups });
            }
        } catch (err) {
            // A failed stop may leave the candidate backend running with its paired web files.
            const recorded = readActiveReleases(cfg);
            if (!backend || (readLockMetadata(cfg.backendLockPath)?.releaseId !== backend.releaseId && recorded.backend.active !== backend.releaseId)) {
                if (backend) removeRelease(backend.dir);
                if (web && web.releaseId !== recorded.web.active) removeRelease(web.dir);
            }
            throw err;
        }
        if (keepBackups) {
            if (backend) pruneOldReleases(cfg.backendReleasesDir, readActiveReleases(cfg).backend);
            if (web) pruneWebReleases(cfg);
        }
        if (backend) logUpdate('服务端已切换至新版，游戏连接保持在线。');
        if (web) logUpdate('网页端已切换至新版。');
        if (!keepBackups) logUpdate('已关闭备份，本次更新不新增历史版本。');
        return 0;
    });
}

function logUpdate(message) {
    console.log(message);
    writeUpdateJobPatch({}, message);
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
            await withProgress('停止面板服务', () => stopBackendProcess(cfg));
        }
        if (target === 'host' || target === 'all') {
            await withProgress('停止游戏连接服务', () => stopHostProcess(cfg));
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

function getRollbackWebRelease(cfg, releaseId) {
    if (typeof releaseId !== 'string' || !/^web-[\w.-]+$/.test(releaseId)) {
        throw new Error('缺少对应的前端版本。可单独回滚后端，或使用 --web-release 指定前端版本。');
    }
    const dir = path.join(cfg.webReleasesDir, releaseId);
    if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`Target web release missing: ${releaseId}`);
    return { releaseId, dir, previousDir: runningComponents(cfg).web.dir };
}

async function cmdRollback(cfg, positional, flags) {
    const target = (positional[0] || 'backend').toLowerCase();
    if (!['all', 'backend', 'web'].includes(target)) {
        throw new Error(`Unsupported rollback target: ${target}. Use all, backend, or web.`);
    }
    return withDeployLock(cfg, async () => {
        const keepBackups = readBackupEnabled(cfg.runtimeDir);
        const releases = readActiveReleases(cfg);
        const slot = target === 'web' ? (releases.web || {}) : (releases.backend || {});
        const targetId = typeof flags.release === 'string' && flags.release ? flags.release : slot.previous;
        if (!targetId) {
            throw new Error(`No previous ${target === 'all' ? 'backend' : target} release recorded to roll back to (pass --release <id>).`);
        }
        if (target === 'web') {
            activateReleases(cfg, { web: getRollbackWebRelease(cfg, targetId), keepBackups, restoring: true });
            console.log(`Rolled back web to ${targetId}.`);
            return 0;
        }
        if (typeof targetId !== 'string' || !/^backend-[\w.-]+$/.test(targetId)) {
            throw new Error('无效的后端发布目录名称');
        }
        const host = await probeHost(cfg);
        if (host.state !== 'ready') throw new Error(`session-host is ${host.state}; cannot attach rolled-back backend.`);
        const rel = resolveReleaseDir(cfg.backendReleasesDir, targetId);
        if (!rel) throw new Error(`Target backend release missing: ${targetId}`);

        const activeId = readLockMetadata(cfg.backendLockPath)?.releaseId || releases.backend?.active;
        const currentDir = activeId ? resolveReleaseDir(cfg.backendReleasesDir, activeId)?.dir : path.join(REPO_ROOT, 'core');
        const compat = compareReleaseVersions(readReleaseVersions(rel.dir), readReleaseVersions(currentDir), host.ipcVersion);
        if (!compat.compatible) throw new Error(`拒绝回滚至不兼容版本：${compat.reasons.join('；')}`);

        const web = target === 'all'
            ? getRollbackWebRelease(cfg, flags['web-release'] || readReleaseMeta(rel.dir)?.pairedWebReleaseId)
            : null;
        await runCommand(process.execPath, ['--check', path.join(rel.dir, 'client.js')]);
        await swapBackendToRelease(cfg, rel, host, { web, keepBackups, restoring: true });
        if (web) {
            logUpdate(`已回滚网页端和服务端（${targetId.split('-')[2] || targetId}），挂机中的游戏连接保持在线。`);
            return 0;
        }
        logUpdate(`已回滚服务端（${targetId.split('-')[2] || targetId}），挂机中的游戏连接保持在线。`);
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
    let exitCode = 0;
    if (flags.help || flags.h) {
        console.log('Usage: service-control.mjs <start|status|update|stop|rollback|host-healthcheck> [options] [--verbose]');
    } else {
        const cfg = getControlConfig(process.env);
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
    }
    if (exitCode === 0) {
        const donePhase = subcommand === 'rollback' ? '回滚已完成' : subcommand === 'update' ? '更新已完成' : '已完成';
        writeUpdateJobPatch({ status: 'succeeded', phase: donePhase, detail: '', finishedAt: Date.now(), exitCode: 0, error: '' });
    } else {
        writeUpdateJobPatch({ status: 'failed', finishedAt: Date.now(), exitCode, error: `操作退出码 ${exitCode}` });
    }
    process.exit(exitCode);
}

function exitWithError(err) {
    if (!VERBOSE_OUTPUT && err?.commandOutput && !err._outputPrinted) {
        console.error(err.commandOutput);
        err._outputPrinted = true;
    }
    writeUpdateJobPatch(
        { status: 'failed', finishedAt: Date.now(), exitCode: 1, error: String(err?.message || err) },
        err?.commandOutput ? String(err.commandOutput).split(/\r?\n/).slice(-8).join('\n') : '',
    );
    console.error(`[service-control] ${err?.message || err}`);
    process.exit(1);
}

main().catch(exitWithError);
