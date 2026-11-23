import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ResolveRuntimePathsOptions {
    env?: NodeJS.ProcessEnv;
    isPackaged?: boolean;
    execPath?: string;
    appRoot?: string;
    defaultDataDir?: string;
    defaultRuntimeDir?: string;
    defaultResourceRoot?: string;
    defaultWebRoot?: string;
    defaultShareFilePath?: string;
    platform?: NodeJS.Platform;
}

export interface WebRootInfo {
    webRoot: string;
    fallbackRoots: string[];
    source: 'pointer' | 'env' | 'default';
    pointerFile: string;
    releaseId?: string;
}

export interface RuntimePaths {
    isPackaged: boolean;
    appRoot: string;
    dataDir: string;
    runtimeDir: string;
    resourceRoot: string;
    webRoot: string;
    fallbackWebRoots: string[];
    webRootPointerFile: string;
    sessionSocketConfigured: string;
    sessionSocketEndpoint: string;
    hostDataDir: string;
    hostLogDir: string;
    backendLogDir: string;
    shareFilePath: string;
}

function nonEmpty(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function resolveSessionSocketEndpoint(
    rawSocketPath: string,
    platform: NodeJS.Platform = process.platform,
): { configured: string; endpoint: string } {
    const trimmed = nonEmpty(rawSocketPath);
    if (platform === 'win32') {
        if (/^\\\\\.\\pipe\\/i.test(trimmed)) {
            return { configured: trimmed, endpoint: trimmed };
        }
        const resolved = path.resolve(trimmed || 'session-host.sock');
        const hash = crypto.createHash('sha256').update(resolved.toLowerCase()).digest('hex').slice(0, 20);
        return {
            configured: resolved,
            endpoint: `\\\\.\\pipe\\qq-farm-session-${hash}`,
        };
    }

    const resolved = path.resolve(trimmed || 'session-host.sock');
    if (Buffer.byteLength(resolved, 'utf8') <= 96) {
        return { configured: resolved, endpoint: resolved };
    }
    const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 12);
    return {
        configured: resolved,
        endpoint: path.join(os.tmpdir(), `qq-farm-${process.getuid?.() ?? 'user'}`, `sh-${hash}.sock`),
    };
}

export function resolveWebRootInfo(
    runtimeDir: string,
    defaultWebRoot: string,
    env: NodeJS.ProcessEnv = process.env,
): WebRootInfo {
    const pointerEnv = nonEmpty(env.FARM_WEB_ROOT_POINTER);
    const pointerFile = pointerEnv ? path.resolve(pointerEnv) : path.join(runtimeDir, 'active-web.json');
    const envFallbacks = nonEmpty(env.FARM_WEB_FALLBACK_ROOTS)
        .split(path.delimiter)
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => path.resolve(item));

    if (fs.existsSync(pointerFile)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
            const candidate = nonEmpty(parsed?.webRoot);
            if (candidate) {
                const resolvedRoot = path.resolve(candidate);
                const pointerFallbacks = Array.isArray(parsed?.fallbackRoots)
                    ? parsed.fallbackRoots.map((entry: unknown) => nonEmpty(entry)).filter(Boolean).map((entry: string) => path.resolve(entry))
                    : [];
                const mergedFallbacks = Array.from(new Set([...pointerFallbacks, ...envFallbacks, path.resolve(defaultWebRoot)]))
                    .filter(item => item !== resolvedRoot);
                return {
                    webRoot: resolvedRoot,
                    fallbackRoots: mergedFallbacks,
                    source: 'pointer',
                    pointerFile,
                    releaseId: nonEmpty(parsed?.releaseId) || undefined,
                };
            }
        } catch {
            // Fall through to env/default if pointer file is unreadable.
        }
    }

    const envRoot = nonEmpty(env.FARM_WEB_ROOT);
    if (envRoot) {
        const resolvedRoot = path.resolve(envRoot);
        const mergedFallbacks = Array.from(new Set([...envFallbacks, path.resolve(defaultWebRoot)]))
            .filter(item => item !== resolvedRoot);
        return {
            webRoot: resolvedRoot,
            fallbackRoots: mergedFallbacks,
            source: 'env',
            pointerFile,
        };
    }

    const resolvedDefault = path.resolve(defaultWebRoot);
    return {
        webRoot: resolvedDefault,
        fallbackRoots: envFallbacks.filter(item => item !== resolvedDefault),
        source: 'default',
        pointerFile,
    };
}

export function resolveRuntimePaths(options: ResolveRuntimePathsOptions = {}): RuntimePaths {
    const env = options.env || process.env;
    const isPackaged = options.isPackaged ?? Boolean((process as any).pkg);
    const execPath = options.execPath || process.execPath;
    const platform = options.platform || process.platform;
    const appRoot = options.appRoot
        ? path.resolve(options.appRoot)
        : (isPackaged ? path.dirname(execPath) : path.resolve(process.cwd()));

    const envDataDir = nonEmpty(env.FARM_DATA_DIR);
    const dataDir = envDataDir
        ? path.resolve(envDataDir)
        : (options.defaultDataDir
            ? path.resolve(options.defaultDataDir)
            : (isPackaged ? path.join(path.dirname(execPath), 'data') : path.join(appRoot, 'data')));

    const envRuntimeDir = nonEmpty(env.FARM_RUNTIME_DIR);
    const runtimeDir = envRuntimeDir
        ? path.resolve(envRuntimeDir)
        : (options.defaultRuntimeDir
            ? path.resolve(options.defaultRuntimeDir)
            : path.join(appRoot, 'runtime'));

    const envResourceRoot = nonEmpty(env.FARM_RESOURCE_ROOT);
    const resourceRoot = envResourceRoot
        ? path.resolve(envResourceRoot)
        : path.resolve(options.defaultResourceRoot || path.join(appRoot, 'src'));

    const defaultWebRoot = options.defaultWebRoot
        ? path.resolve(options.defaultWebRoot)
        : path.resolve(appRoot, '..', 'web', 'dist');
    const webInfo = resolveWebRootInfo(runtimeDir, defaultWebRoot, env);

    const rawSocket = nonEmpty(env.FARM_SESSION_SOCKET) || path.join(runtimeDir, 'session-host.sock');
    const socketEndpoint = resolveSessionSocketEndpoint(rawSocket, platform);

    const envHostDataDir = nonEmpty(env.FARM_HOST_DATA_DIR);
    const hostDataDir = envHostDataDir
        ? path.resolve(envHostDataDir)
        : path.join(dataDir, 'session-host');

    const envHostLogDir = nonEmpty(env.FARM_HOST_LOG_DIR);
    const hostLogDir = envHostLogDir
        ? path.resolve(envHostLogDir)
        : path.join(hostDataDir, 'logs');

    const envBackendLogDir = nonEmpty(env.FARM_BACKEND_LOG_DIR);
    const backendLogDir = envBackendLogDir
        ? path.resolve(envBackendLogDir)
        : path.join(dataDir, 'logs');

    const envShareFile = nonEmpty(env.FARM_SHARE_FILE);
    const dataShareFile = path.join(dataDir, 'share.txt');
    const fallbackShareFile = options.defaultShareFilePath
        ? path.resolve(options.defaultShareFilePath)
        : path.join(appRoot, 'share.txt');
    const shareFilePath = envShareFile
        ? path.resolve(envShareFile)
        : (fs.existsSync(dataShareFile) ? dataShareFile : fallbackShareFile);

    return {
        isPackaged,
        appRoot,
        dataDir,
        runtimeDir,
        resourceRoot,
        webRoot: webInfo.webRoot,
        fallbackWebRoots: webInfo.fallbackRoots,
        webRootPointerFile: webInfo.pointerFile,
        sessionSocketConfigured: socketEndpoint.configured,
        sessionSocketEndpoint: socketEndpoint.endpoint,
        hostDataDir,
        hostLogDir,
        backendLogDir,
        shareFilePath,
    };
}
