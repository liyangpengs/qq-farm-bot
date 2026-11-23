export {};

const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isProcessAlive, readLockMetadata } = require('@qq-farm-bot/session-contract');
const { getRuntimePaths, isPackaged } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');

export interface IncomingCommitInfo {
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    timestampMs: number;
}

export interface PanelUpdateJobState {
    id: string;
    pid?: number;
    status: 'running' | 'succeeded' | 'failed';
    phase: string;
    detail?: string;
    startedAt: number;
    updatedAt: number;
    finishedAt?: number;
    exitCode?: number | null;
    error?: string;
    fromCommit?: string;
    targetCommit?: string;
    recentLines: string[];
}

export interface SystemUpdateStatus {
    mode: 'source' | 'docker' | 'binary' | 'unknown';
    gitSupported: boolean;
    unsupportedReason: string;
    applySupported: boolean;
    applyUnsupportedReason: string;
    branch: string;
    detached: boolean;
    commit: string;
    shortCommit: string;
    commitSubject: string;
    startupCommit: string;
    needsApply: boolean;
    upstream: string;
    remote: string;
    remoteBranch: string;
    behindCount: number;
    aheadCount: number;
    dirtyFiles: string[];
    incomingCommits: IncomingCommitInfo[];
    canCheck: boolean;
    canPull: boolean;
    canApply: boolean;
    deployBusy: boolean;
    lastCheckedAt: number | null;
    lastCheckError: string;
    lastPulledAt: number | null;
    job: PanelUpdateJobState | null;
}

export interface SystemUpdateServiceOptions {
    repoRoot?: string | null;
    runtimeDir?: string;
    isPackaged?: boolean;
    isDocker?: boolean;
    invocationId?: string;
    controlManaged?: boolean;
    spawnRunner?: typeof spawn;
    execGit?: (cwd: string, args: string[]) => Promise<string>;
    now?: () => number;
}

function createUpdateError(message: string, statusCode = 400, code = 'SYSTEM_UPDATE_ERROR'): Error {
    return Object.assign(new Error(message), { statusCode, code });
}

function defaultExecGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, {
            cwd,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                LC_ALL: 'C',
            },
            timeout: 25000,
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true,
        }, (err: any, stdout: string, stderr: string) => {
            if (!err) {
                resolve(String(stdout || ''));
                return;
            }
            const detail = String(stderr || stdout || err.message || 'Git 执行失败').trim();
            reject(Object.assign(new Error(detail), { code: err.code || 'GIT_EXEC_FAILED' }));
        });
    });
}

function resolveSourceRepoRoot(appRoot: string, explicitRoot?: string | null): string | null {
    const candidates: string[] = [];
    if (explicitRoot) candidates.push(path.resolve(explicitRoot));
    if (process.env.FARM_REPO_ROOT) candidates.push(path.resolve(process.env.FARM_REPO_ROOT));
    candidates.push(path.resolve(appRoot, '..'));
    candidates.push(path.resolve(appRoot, '..', '..', '..'));

    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            if (fs.existsSync(path.join(candidate, '.git'))) {
                return candidate;
            }
        } catch {
            // ignore inaccessible candidates
        }
    }
    return null;
}

function createSystemUpdateService(options: SystemUpdateServiceOptions = {}) {
    const now = options.now || Date.now;
    const execGit = options.execGit || defaultExecGit;
    const spawnRunner = options.spawnRunner || spawn;

    let lastCheckedAt: number | null = null;
    let lastCheckError = '';
    let lastPulledAt: number | null = null;
    let startupCommit = '';
    let startupCommitInit: Promise<void> | null = null;
    let operationLock: Promise<any> = Promise.resolve();

    const withOpMutex = async <T>(fn: () => Promise<T>): Promise<T> => {
        const previous = operationLock;
        let release!: () => void;
        operationLock = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous.catch(() => {});
        try {
            return await fn();
        } finally {
            release();
        }
    };

    const getPaths = () => {
        const paths = getRuntimePaths();
        const runtimeDir = options.runtimeDir ? path.resolve(options.runtimeDir) : paths.runtimeDir;
        return { ...paths, runtimeDir };
    };

    const detectEnv = async () => {
        const paths = getPaths();
        const packaged = options.isPackaged ?? isPackaged;
        const docker = options.isDocker ?? (process.env.FARM_RELEASE_ID === 'docker' || fs.existsSync('/.dockerenv'));
        const repoRoot = packaged || docker ? null : resolveSourceRepoRoot(paths.appRoot, options.repoRoot);

        if (packaged) {
            return {
                paths,
                mode: 'binary' as const,
                repoRoot: null,
                gitSupported: false,
                unsupportedReason: '当前以独立可执行文件运行，不支持在网页内检查或拉取 Git 更新。',
                applySupported: false,
                applyUnsupportedReason: '独立可执行文件不支持网页内在线更新。',
            };
        }
        if (docker) {
            return {
                paths,
                mode: 'docker' as const,
                repoRoot: null,
                gitSupported: false,
                unsupportedReason: '当前运行在 Docker 容器中，请重建镜像或执行 docker compose up -d --build --no-deps qq-farm-bot 更新。',
                applySupported: false,
                applyUnsupportedReason: 'Docker 容器请通过镜像重建更新，不支持容器内自更新。',
            };
        }
        if (!repoRoot) {
            return {
                paths,
                mode: 'unknown' as const,
                repoRoot: null,
                gitSupported: false,
                unsupportedReason: '未找到 Git 仓库根目录（.git），当前运行方式不支持检查更新。',
                applySupported: false,
                applyUnsupportedReason: '未找到 Git 仓库根目录，无法执行在线更新。',
            };
        }

        let gitReady = true;
        try {
            await execGit(repoRoot, ['--version']);
        } catch {
            gitReady = false;
        }
        if (!gitReady) {
            return {
                paths,
                mode: 'source' as const,
                repoRoot,
                gitSupported: false,
                unsupportedReason: '运行环境中未安装 git 或不可执行，无法检查更新。',
                applySupported: false,
                applyUnsupportedReason: '运行环境中未找到 git 命令。',
            };
        }

        const serviceControlPath = path.join(repoRoot, 'tools', 'service-control.mjs');
        const hasControlScript = fs.existsSync(serviceControlPath);
        const invocationId = options.invocationId ?? process.env.INVOCATION_ID ?? '';
        const controlManaged = options.controlManaged ?? (process.env.FARM_CONTROL_MANAGED === '1');

        let applySupported = false;
        let applyUnsupportedReason = '';
        if (!hasControlScript) {
            applyUnsupportedReason = '缺少 tools/service-control.mjs，拉取代码后请手动重启服务。';
        } else if (invocationId) {
            applyUnsupportedReason = '当前服务由 systemd 托管，可先在网页拉取代码，再到终端执行更新或重启。';
        } else if (!controlManaged) {
            applyUnsupportedReason = '仅通过 start.sh 启动的后台托管模式支持网页一键更新；当前可先拉取代码，再执行 bash ./update.sh all 或重启生效。';
        } else {
            applySupported = true;
        }

        return {
            paths,
            mode: 'source' as const,
            repoRoot,
            gitSupported: true,
            unsupportedReason: '',
            applySupported,
            applyUnsupportedReason,
        };
    };

    const ensureStartupCommit = async (): Promise<void> => {
        if (startupCommit) return;
        if (!startupCommitInit) {
            startupCommitInit = (async () => {
                try {
                    const envInfo = await detectEnv();
                    if (envInfo.gitSupported && envInfo.repoRoot) {
                        // Immutable backend releases keep their source revision when restarted or rolled back.
                        const releaseCommit = /^backend-\d{14}-([\da-f]+)-[\da-f]{4}$/.exec(process.env.FARM_RELEASE_ID || '')?.[1];
                        startupCommit = releaseCommit
                            || (await execGit(envInfo.repoRoot, ['rev-parse', 'HEAD'])).trim();
                    }
                } catch {
                    // ignore initial read failures
                }
            })();
        }
        await startupCommitInit;
    };

    void ensureStartupCommit();

    const getJobFilePath = (runtimeDir: string) => path.join(runtimeDir, 'panel-update-job.json');
    const getJobLogPath = (runtimeDir: string) => path.join(runtimeDir, 'panel-update-job.log');

    const isDeployLockAlive = (runtimeDir: string): boolean => {
        const lock = readLockMetadata(path.join(runtimeDir, 'deploy-operation.lock'));
        return Boolean(lock && isProcessAlive(lock.pid, lock.processStart));
    };

    const readJobState = (runtimeDir: string): PanelUpdateJobState | null => {
        const jobFile = getJobFilePath(runtimeDir);
        try {
            if (!fs.existsSync(jobFile)) return null;
            const parsed = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || !parsed.status) return null;
            const job: PanelUpdateJobState = {
                id: String(parsed.id || ''),
                pid: Number(parsed.pid) || undefined,
                status: parsed.status === 'succeeded' || parsed.status === 'failed' ? parsed.status : 'running',
                phase: String(parsed.phase || ''),
                detail: parsed.detail ? String(parsed.detail) : undefined,
                startedAt: Number(parsed.startedAt) || 0,
                updatedAt: Number(parsed.updatedAt) || 0,
                finishedAt: Number(parsed.finishedAt) || undefined,
                exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined,
                error: parsed.error ? String(parsed.error) : undefined,
                fromCommit: parsed.fromCommit ? String(parsed.fromCommit) : undefined,
                targetCommit: parsed.targetCommit ? String(parsed.targetCommit) : undefined,
                recentLines: Array.isArray(parsed.recentLines) ? parsed.recentLines.map((l: unknown) => String(l)).slice(-30) : [],
            };
            if (job.status === 'running') {
                const pidAlive = Boolean(job.pid && isProcessAlive(job.pid));
                const lockAlive = isDeployLockAlive(runtimeDir);
                const ageMs = now() - (job.startedAt || 0);
                if (!pidAlive && !lockAlive && ageMs > 3000) {
                    const failedJob: PanelUpdateJobState = {
                        ...job,
                        status: 'failed',
                        finishedAt: now(),
                        error: job.error || '更新进程意外退出，请查看 runtime/panel-update-job.log',
                    };
                    try {
                        writeJsonFileAtomic(jobFile, failedJob);
                    } catch {
                        // ignore write error during status read
                    }
                    return failedJob;
                }
            }
            return job;
        } catch {
            return null;
        }
    };

    const inspectRepoLocal = async (repoRoot: string) => {
        const branchRaw = (await execGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        const detached = !branchRaw || branchRaw === 'HEAD';
        const branch = detached ? '' : branchRaw;
        const commit = (await execGit(repoRoot, ['rev-parse', 'HEAD'])).trim();
        const shortCommit = (await execGit(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
        const commitSubject = (await execGit(repoRoot, ['log', '-1', '--format=%s', 'HEAD']).catch(() => '')).trim();
        const upstream = detached
            ? ''
            : (await execGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();

        let remote = '';
        let remoteBranch = '';
        if (upstream) {
            const cfgRemote = (await execGit(repoRoot, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim();
            if (cfgRemote && upstream.startsWith(`${cfgRemote}/`)) {
                remote = cfgRemote;
                remoteBranch = upstream.slice(cfgRemote.length + 1);
            } else {
                const slash = upstream.indexOf('/');
                remote = slash > 0 ? upstream.slice(0, slash) : '';
                remoteBranch = slash > 0 ? upstream.slice(slash + 1) : '';
            }
        }

        const dirtyRaw = await execGit(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
        const dirtyFiles = dirtyRaw
            .split(/\r?\n/)
            .map(line => line.trimEnd())
            .filter(Boolean)
            .slice(0, 50);

        let aheadCount = 0;
        let behindCount = 0;
        let incomingCommits: IncomingCommitInfo[] = [];
        if (upstream) {
            const countsRaw = (await execGit(repoRoot, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim();
            const [aheadStr = '0', behindStr = '0'] = countsRaw.split(/\s+/);
            aheadCount = Math.max(0, Number(aheadStr) || 0);
            behindCount = Math.max(0, Number(behindStr) || 0);
            if (behindCount > 0) {
                const logRaw = await execGit(repoRoot, [
                    'log',
                    '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct',
                    '-n',
                    '10',
                    'HEAD..@{u}',
                ]).catch(() => '');
                incomingCommits = logRaw
                    .split(/\r?\n/)
                    .filter(Boolean)
                    .map((line) => {
                        const [hash = '', shortHash = '', subject = '', author = '', secStr = '0'] = line.split('\x1F');
                        return {
                            hash,
                            shortHash,
                            subject,
                            author,
                            timestampMs: (Number(secStr) || 0) * 1000,
                        };
                    });
            }
        }

        return {
            branch,
            detached,
            commit,
            shortCommit,
            commitSubject,
            upstream,
            remote,
            remoteBranch,
            aheadCount,
            behindCount,
            dirtyFiles,
            incomingCommits,
        };
    };

    const assertUpdatableBranch = (repo: Pick<SystemUpdateStatus, 'detached' | 'upstream' | 'remote' | 'remoteBranch' | 'dirtyFiles' | 'aheadCount'>): void => {
        if (repo.detached || !repo.upstream || !repo.remote || !repo.remoteBranch) {
            throw createUpdateError('当前分支未关联远程跟踪分支，或处于游离 HEAD 状态', 400, 'NO_UPSTREAM');
        }
        if (repo.dirtyFiles.length > 0) {
            throw createUpdateError(`工作区存在未提交的本地修改（${repo.dirtyFiles[0]}），已阻止自动拉取`, 409, 'DIRTY_WORKTREE');
        }
        if (repo.aheadCount > 0) {
            throw createUpdateError('当前分支包含未推送的本地提交，无法执行快进拉取（--ff-only）', 409, 'BRANCH_DIVERGED');
        }
    };

    const getStatus = async (): Promise<SystemUpdateStatus> => {
        await ensureStartupCommit();
        const envInfo = await detectEnv();
        const job = readJobState(envInfo.paths.runtimeDir);
        const deployBusy = job?.status === 'running' || isDeployLockAlive(envInfo.paths.runtimeDir);

        if (!envInfo.gitSupported || !envInfo.repoRoot) {
            return {
                mode: envInfo.mode,
                gitSupported: false,
                unsupportedReason: envInfo.unsupportedReason,
                applySupported: false,
                applyUnsupportedReason: envInfo.applyUnsupportedReason,
                branch: '',
                detached: false,
                commit: '',
                shortCommit: '',
                commitSubject: '',
                startupCommit: '',
                needsApply: false,
                upstream: '',
                remote: '',
                remoteBranch: '',
                behindCount: 0,
                aheadCount: 0,
                dirtyFiles: [],
                incomingCommits: [],
                canCheck: false,
                canPull: false,
                canApply: false,
                deployBusy,
                lastCheckedAt,
                lastCheckError,
                lastPulledAt,
                job,
            };
        }

        const repo = await inspectRepoLocal(envInfo.repoRoot);
        const needsApply = Boolean(startupCommit && repo.commit && !repo.commit.startsWith(startupCommit));
        const canCheck = Boolean(!repo.detached && repo.upstream);
        const canPull = Boolean(
            canCheck
            && !deployBusy
            && repo.behindCount > 0
            && repo.aheadCount === 0
            && repo.dirtyFiles.length === 0,
        );
        const canApply = Boolean(
            envInfo.applySupported
            && !deployBusy
            && canCheck
            && !repo.aheadCount
            && !repo.dirtyFiles.length
            && (needsApply || canPull),
        );

        return {
            mode: envInfo.mode,
            gitSupported: true,
            unsupportedReason: '',
            applySupported: envInfo.applySupported,
            applyUnsupportedReason: envInfo.applyUnsupportedReason,
            branch: repo.branch,
            detached: repo.detached,
            commit: repo.commit,
            shortCommit: repo.shortCommit,
            commitSubject: repo.commitSubject,
            startupCommit,
            needsApply,
            upstream: repo.upstream,
            remote: repo.remote,
            remoteBranch: repo.remoteBranch,
            behindCount: repo.behindCount,
            aheadCount: repo.aheadCount,
            dirtyFiles: repo.dirtyFiles,
            incomingCommits: repo.incomingCommits,
            canCheck,
            canPull,
            canApply,
            deployBusy,
            lastCheckedAt,
            lastCheckError,
            lastPulledAt,
            job,
        };
    };

    const runCheckUnlocked = async (): Promise<SystemUpdateStatus> => {
        await ensureStartupCommit();
        const envInfo = await detectEnv();
        if (!envInfo.gitSupported || !envInfo.repoRoot) {
            throw createUpdateError(envInfo.unsupportedReason || '当前运行方式不支持检查更新', 400, 'UNSUPPORTED_ENVIRONMENT');
        }
        const repo = await inspectRepoLocal(envInfo.repoRoot);
        if (repo.detached || !repo.upstream || !repo.remote) {
            throw createUpdateError('当前分支未关联远程跟踪分支，或处于游离 HEAD 状态', 400, 'NO_UPSTREAM');
        }
        try {
            await execGit(envInfo.repoRoot, ['fetch', '--prune', repo.remote]);
            lastCheckedAt = now();
            lastCheckError = '';
        } catch (err: any) {
            lastCheckedAt = now();
            lastCheckError = err?.message || '检查远程更新失败';
            throw createUpdateError(`检查远程更新失败：${lastCheckError}`, 400, 'GIT_FETCH_FAILED');
        }
        return getStatus();
    };

    const runPullUnlocked = async (): Promise<{
        pulled: boolean;
        fromCommit: string;
        toCommit: string;
        status: SystemUpdateStatus;
    }> => {
        await ensureStartupCommit();
        const envInfo = await detectEnv();
        if (!envInfo.gitSupported || !envInfo.repoRoot) {
            throw createUpdateError(envInfo.unsupportedReason || '当前运行方式不支持拉取更新', 400, 'UNSUPPORTED_ENVIRONMENT');
        }
        const currentJob = readJobState(envInfo.paths.runtimeDir);
        if (currentJob?.status === 'running' || isDeployLockAlive(envInfo.paths.runtimeDir)) {
            throw createUpdateError('当前已有部署或更新任务正在运行，请稍候完成后再试', 409, 'UPDATE_BUSY');
        }
        const repo = await inspectRepoLocal(envInfo.repoRoot);
        assertUpdatableBranch(repo);
        if (repo.behindCount === 0) {
            return {
                pulled: false,
                fromCommit: repo.shortCommit,
                toCommit: repo.shortCommit,
                status: await getStatus(),
            };
        }

        const fromCommit = repo.shortCommit;
        try {
            await execGit(envInfo.repoRoot, ['pull', '--ff-only', repo.remote, repo.remoteBranch]);
            lastPulledAt = now();
        } catch (err: any) {
            throw createUpdateError(`拉取代码失败：${err?.message || 'git pull 执行失败'}`, 400, 'GIT_PULL_FAILED');
        }
        const nextStatus = await getStatus();
        return {
            pulled: nextStatus.shortCommit !== fromCommit,
            fromCommit,
            toCommit: nextStatus.shortCommit,
            status: nextStatus,
        };
    };

    const checkForUpdates = () => withOpMutex(runCheckUnlocked);
    const pullUpdates = () => withOpMutex(runPullUnlocked);

    const applyUpdate = (applyOptions: { pullFirst?: boolean } = {}) => withOpMutex(async () => {
        await ensureStartupCommit();
        const envInfo = await detectEnv();
        if (!envInfo.gitSupported || !envInfo.repoRoot) {
            throw createUpdateError(envInfo.unsupportedReason || '当前运行方式不支持更新', 400, 'UNSUPPORTED_ENVIRONMENT');
        }
        if (!envInfo.applySupported) {
            throw createUpdateError(envInfo.applyUnsupportedReason || '当前运行方式不支持网页内一键在线更新', 400, 'APPLY_UNSUPPORTED');
        }
        const currentJob = readJobState(envInfo.paths.runtimeDir);
        if (currentJob?.status === 'running' || isDeployLockAlive(envInfo.paths.runtimeDir)) {
            throw createUpdateError('已有部署或更新任务正在运行，请稍候查看进度', 409, 'UPDATE_BUSY');
        }

        if (applyOptions.pullFirst !== false) {
            const checked = await runCheckUnlocked();
            if (checked.behindCount > 0) await runPullUnlocked();
        }

        const statusNow = await getStatus();
        assertUpdatableBranch(statusNow);
        if (statusNow.deployBusy) {
            throw createUpdateError('已有部署或更新任务正在运行，请稍候查看进度', 409, 'UPDATE_BUSY');
        }
        if (!statusNow.needsApply) {
            throw createUpdateError('当前代码已是最新版本且已在运行中，无需重复更新', 400, 'NOTHING_TO_APPLY');
        }

        const runtimeDir = envInfo.paths.runtimeDir;
        fs.mkdirSync(runtimeDir, { recursive: true });
        const jobFile = getJobFilePath(runtimeDir);
        const logFile = getJobLogPath(runtimeDir);
        const startedAt = now();
        const initialJob: PanelUpdateJobState = {
            id: `upd_${crypto.randomUUID().slice(0, 8)}`,
            status: 'running',
            phase: '正在后台启动更新流程',
            detail: '',
            startedAt,
            updatedAt: startedAt,
            fromCommit: startupCommit ? startupCommit.slice(0, 7) : statusNow.shortCommit,
            targetCommit: statusNow.shortCommit,
            recentLines: ['[发布] 正在启动后台更新进程…'],
        };
        const controlScript = path.join(envInfo.repoRoot, 'tools', 'service-control.mjs');
        const outFd = fs.openSync(logFile, 'w');
        try {
            writeJsonFileAtomic(jobFile, initialJob);
            const childEnv: NodeJS.ProcessEnv = {
                ...process.env,
                NODE_ENV: process.env.NODE_ENV || 'production',
                FARM_DATA_DIR: envInfo.paths.dataDir,
                FARM_RUNTIME_DIR: runtimeDir,
                FARM_HOST_DATA_DIR: envInfo.paths.hostDataDir,
                FARM_HOST_LOG_DIR: envInfo.paths.hostLogDir,
                FARM_BACKEND_LOG_DIR: envInfo.paths.backendLogDir,
                FARM_SESSION_SOCKET: envInfo.paths.sessionSocketConfigured,
                FARM_UPDATE_JOB_FILE: jobFile,
            };
            if (process.env.FARM_RELEASES_DIR) {
                childEnv.FARM_RELEASES_DIR = process.env.FARM_RELEASES_DIR;
            }
            const child = spawnRunner(process.execPath, [controlScript, 'update', 'all'], {
                cwd: envInfo.repoRoot,
                env: childEnv,
                detached: true,
                stdio: ['ignore', outFd, outFd],
                windowsHide: true,
            });
            await new Promise<void>((resolve, reject) => {
                child.once('error', reject);
                child.once('spawn', resolve);
            });
            initialJob.pid = child.pid;
            child.unref();
        } catch (err: any) {
            const failedJob: PanelUpdateJobState = {
                ...initialJob,
                status: 'failed',
                finishedAt: now(),
                error: err?.message || '无法启动更新进程',
            };
            writeJsonFileAtomic(jobFile, failedJob);
            throw createUpdateError(`启动更新进程失败：${err?.message || err}`, 500, 'SPAWN_UPDATE_FAILED');
        } finally {
            fs.closeSync(outFd);
        }

        return {
            job: initialJob,
            status: await getStatus(),
        };
    });

    return {
        getStatus,
        checkForUpdates,
        pullUpdates,
        applyUpdate,
    };
}

const defaultSystemUpdateService = createSystemUpdateService();

module.exports = {
    createSystemUpdateService,
    getSystemUpdateStatus: () => defaultSystemUpdateService.getStatus(),
    checkSystemUpdates: () => defaultSystemUpdateService.checkForUpdates(),
    pullSystemUpdates: () => defaultSystemUpdateService.pullUpdates(),
    applySystemUpdate: (options?: { pullFirst?: boolean }) => defaultSystemUpdateService.applyUpdate(options),
};
