const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
    acquireExclusiveLock,
    readLockMetadata,
    resolveWebRootInfo,
} = require('@qq-farm-bot/session-contract');
const { readJsonFileStrict, writeJsonFileAtomic } = require('./json-db');
const { compareReleaseVersions, pairedWebReleases, readReleaseMeta, readReleaseVersions } = require('./release-compat');

const BACKEND_RELEASE_ID_RE = /^backend-[\w.-]+$/;
const WEB_RELEASE_ID_RE = /^web-[\w.-]+$/;
const HOST_RELEASE_ID_RE = /^host-[\w.-]+$/;

export interface ReleaseCompatInfo {
    compatible: boolean;
    outdated: boolean;
    reasons: string[];
}

export interface RollbackReleaseItem {
    releaseId: string;
    createdAt: number;
    commit: string;
    shortCommit: string;
    commitSubject: string;
    pairedWebReleaseId: string;
    sizeBytes: number;
    isActive: boolean;
    isPrevious: boolean;
    canRollback: boolean;
    canDelete: boolean;
    compat: ReleaseCompatInfo;
}

export interface ReleasesSummary {
    totalCount: number;
    compatibleCount: number;
    outdatedCount: number;
    totalSizeBytes: number;
    outdatedSizeBytes: number;
    orphanHostCount: number;
    orphanWebCount: number;
    orphanSizeBytes: number;
}

export interface ReleaseManagerOptions {
    repoRoot: string | null;
    runtimeDir: string;
    releasesDir?: string | null;
    appRoot: string;
    applySupported: boolean;
    deployBusy: boolean;
    execGit?: (cwd: string, args: string[]) => Promise<string>;
}

export interface DeleteReleasesOptions {
    runtimeDir: string;
    releasesDir: string;
    releaseIds?: unknown;
    cleanOrphans?: boolean;
    appRoot: string;
}

export interface DeleteReleasesResult {
    deletedReleaseIds: string[];
    deletedWebIds: string[];
    deletedHostIds: string[];
    freedBytes: number;
}

interface ActiveSlotState {
    active: string | null;
    previous: string | null;
    history: string[];
    restoredBackup?: boolean;
    updatedAt?: number;
}

const dirSizeCache = new Map<string, { mtimeMs: number; sizeBytes: number }>();
const commitSubjectCache = new Map<string, string>();

function createEmptySummary(): ReleasesSummary {
    return {
        totalCount: 0,
        compatibleCount: 0,
        outdatedCount: 0,
        totalSizeBytes: 0,
        outdatedSizeBytes: 0,
        orphanHostCount: 0,
        orphanWebCount: 0,
        orphanSizeBytes: 0,
    };
}

function createReleaseManagerError(message: string, statusCode = 400, code = 'RELEASE_MANAGER_ERROR'): Error {
    return Object.assign(new Error(message), { statusCode, code });
}

function parseReleaseTimestamp(releaseId: string): number {
    const match = /^(?:backend|web|host)-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(String(releaseId || ''));
    if (!match) return 0;
    const [, y, m, d, hh, mm, ss] = match;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
}

function parseReleaseShortSha(releaseId: string): string {
    return /^backend-\d{14}-([\da-f]+)-/.exec(releaseId)?.[1] || '';
}

function resolveReleasesDir(repoRoot: string | null | undefined, explicitReleasesDir?: string | null): string {
    if (explicitReleasesDir) return path.resolve(explicitReleasesDir);
    if (process.env.FARM_RELEASES_DIR) return path.resolve(process.env.FARM_RELEASES_DIR);
    if (repoRoot) return path.join(path.resolve(repoRoot), 'releases');
    return '';
}

function validateBackendReleaseId(id: unknown): string {
    const value = typeof id === 'string' ? id.trim() : '';
    if (!BACKEND_RELEASE_ID_RE.test(value)) {
        throw createReleaseManagerError(`无效的版本目录名称：${String(id || '')}`, 400, 'INVALID_RELEASE_ID');
    }
    return value;
}

async function computeDirSizeBytes(dir: string): Promise<number> {
    try {
        const { mtimeMs } = await fs.promises.lstat(dir);
        const cached = dirSizeCache.get(dir);
        if (cached?.mtimeMs === mtimeMs) return cached.sizeBytes;

        let sizeBytes = 0;
        const pending = [dir];
        while (pending.length) {
            const parent = pending.pop()!;
            for (const entry of await fs.promises.readdir(parent, { withFileTypes: true })) {
                const child = path.join(parent, entry.name);
                if (entry.isDirectory()) pending.push(child);
                else if (entry.isFile()) sizeBytes += (await fs.promises.lstat(child)).size;
            }
        }
        dirSizeCache.set(dir, { mtimeMs, sizeBytes });
        return sizeBytes;
    } catch (err) {
        if (err.code === 'ENOENT') return 0; // A deployment can prune a release while it is being listed.
        throw err;
    }
}

function listSubdirsMatching(baseDir: string, pattern: RegExp): string[] {
    try {
        return fs.readdirSync(baseDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && pattern.test(entry.name))
            .map(entry => entry.name);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

function readSlotState(raw: any): ActiveSlotState {
    return {
        active: typeof raw?.active === 'string' && raw.active ? raw.active : null,
        previous: typeof raw?.previous === 'string' && raw.previous ? raw.previous : null,
        history: Array.isArray(raw?.history) ? raw.history.map((v: unknown) => String(v)).filter(Boolean) : [],
        restoredBackup: raw?.restoredBackup === true || undefined,
        updatedAt: Number(raw?.updatedAt) || undefined,
    };
}

function readRuntimeState(runtimeDir: string, appRoot: string, releasesDir: string) {
    const activeReleasesPath = path.join(runtimeDir, 'active-releases.json');
    const raw = readJsonFileStrict(activeReleasesPath, () => ({}));
    const slots = {
        host: readSlotState(raw.host),
        backend: readSlotState(raw.backend),
        web: readSlotState(raw.web),
    };
    const hostLock = readLockMetadata(path.join(runtimeDir, 'session-host.lock'));
    const backendLock = readLockMetadata(path.join(runtimeDir, 'backend-writer.lock'));
    const backendDir = path.join(releasesDir, 'backend');
    const runningDirId = path.relative(backendDir, appRoot);
    const backendIds = [process.env.FARM_RELEASE_ID, runningDirId, backendLock?.releaseId, slots.backend.active]
        .filter((id): id is string => typeof id === 'string' && BACKEND_RELEASE_ID_RE.test(id));
    const webInfo = resolveWebRootInfo(runtimeDir, path.resolve(appRoot, '../web/dist'));
    const webDir = path.join(releasesDir, 'web');
    // The static server can still load lazy chunks from the previous web release.
    const servingWebIds = [webInfo.webRoot, ...webInfo.fallbackRoots].map(root => path.relative(webDir, root));
    return {
        activeReleasesPath,
        slots,
        activeBackendId: backendIds[0] || '',
        activeBackendIds: new Set(backendIds),
        activeHostIds: new Set([slots.host.active, hostLock?.releaseId]),
        activeWebIds: new Set([slots.web.active, webInfo.releaseId, ...servingWebIds]),
    };
}

async function resolveCommitSubject(
    repoRoot: string | null,
    shortCommit: string,
    existingSubject: string,
    execGit?: (cwd: string, args: string[]) => Promise<string>,
): Promise<string> {
    if (existingSubject) return existingSubject;
    if (!repoRoot || !execGit || !shortCommit || shortCommit === 'local') return '';
    const cacheKey = `${path.resolve(repoRoot)}:${shortCommit}`;
    if (commitSubjectCache.has(cacheKey)) {
        return commitSubjectCache.get(cacheKey)!;
    }
    try {
        const subject = (await execGit(repoRoot, ['log', '-1', '--format=%s', shortCommit])).trim();
        if (subject) commitSubjectCache.set(cacheKey, subject);
        return subject;
    } catch {
        commitSubjectCache.set(cacheKey, '');
        return '';
    }
}

async function listReleases(options: ReleaseManagerOptions): Promise<{
    releases: RollbackReleaseItem[];
    summary: ReleasesSummary;
}> {
    const releasesDir = resolveReleasesDir(options.repoRoot, options.releasesDir);
    if (!releasesDir || !fs.existsSync(releasesDir)) {
        return { releases: [], summary: createEmptySummary() };
    }

    const state = readRuntimeState(options.runtimeDir, options.appRoot, releasesDir);
    const backendBaseDir = path.join(releasesDir, 'backend');
    const webBaseDir = path.join(releasesDir, 'web');
    const hostBaseDir = path.join(releasesDir, 'host');

    const backendIds = listSubdirsMatching(backendBaseDir, BACKEND_RELEASE_ID_RE);
    const webIds = listSubdirsMatching(webBaseDir, WEB_RELEASE_ID_RE);
    const webIdSet = new Set(webIds);
    const hostIds = listSubdirsMatching(hostBaseDir, HOST_RELEASE_ID_RE);

    const activeBackendDir = state.activeBackendId ? path.join(backendBaseDir, state.activeBackendId) : options.appRoot;
    const baseline = readReleaseVersions(activeBackendDir);

    const rawEntries = backendIds.map((releaseId) => {
        const dirPath = path.join(backendBaseDir, releaseId);
        const meta = readReleaseMeta(dirPath);
        const createdAt = Number(meta?.createdAt) || parseReleaseTimestamp(releaseId) || (() => {
            try { return Math.round(fs.statSync(dirPath).mtimeMs); } catch { return 0; }
        })();
        const shortCommit = String(meta?.shortCommit || parseReleaseShortSha(releaseId) || '');
        const explicitWebId = typeof meta?.pairedWebReleaseId === 'string' && webIdSet.has(meta.pairedWebReleaseId)
            ? meta.pairedWebReleaseId
            : '';
        return { releaseId, dirPath, meta, createdAt, shortCommit, pairedWebReleaseId: explicitWebId };
    });

    const pairedWebRefCount = new Map<string, number>();
    for (const { pairedWebReleaseId } of rawEntries) {
        if (pairedWebReleaseId) {
            pairedWebRefCount.set(pairedWebReleaseId, (pairedWebRefCount.get(pairedWebReleaseId) || 0) + 1);
        }
    }

    const [backendSizes, webSizes, hostSizes] = await Promise.all([
        Promise.all(backendIds.map(async id => [id, await computeDirSizeBytes(path.join(backendBaseDir, id))] as const)),
        Promise.all(webIds.map(async id => [id, await computeDirSizeBytes(path.join(webBaseDir, id))] as const)),
        Promise.all(hostIds.map(async id => [id, await computeDirSizeBytes(path.join(hostBaseDir, id))] as const)),
    ]);
    const backendSizeMap = new Map(backendSizes);
    const webSizeMap = new Map(webSizes);
    const hostSizeMap = new Map(hostSizes);

    const items: RollbackReleaseItem[] = await Promise.all(rawEntries.map(async (entry) => {
        const isActive = entry.releaseId === state.activeBackendId;
        const isPrevious = entry.releaseId === state.slots.backend.previous;
        const { pairedWebReleaseId } = entry;
        const pairedWebSize = pairedWebReleaseId
            && !state.activeWebIds.has(pairedWebReleaseId)
            && (pairedWebRefCount.get(pairedWebReleaseId) || 0) === 1
            ? (webSizeMap.get(pairedWebReleaseId) || 0)
            : 0;
        const sizeBytes = (backendSizeMap.get(entry.releaseId) || 0) + pairedWebSize;

        const compatResult = isActive
            ? { compatible: true, outdated: false, reasons: [] as string[] }
            : compareReleaseVersions(readReleaseVersions(entry.dirPath), baseline);

        const commitSubject = await resolveCommitSubject(
            options.repoRoot,
            entry.shortCommit,
            String(entry.meta?.commitSubject || ''),
            options.execGit,
        );

        return {
            releaseId: entry.releaseId,
            createdAt: entry.createdAt,
            commit: String(entry.meta?.commit || ''),
            shortCommit: entry.shortCommit,
            commitSubject,
            pairedWebReleaseId,
            sizeBytes,
            isActive,
            isPrevious,
            canRollback: Boolean(!isActive && options.applySupported && !options.deployBusy && compatResult.compatible),
            canDelete: !state.activeBackendIds.has(entry.releaseId) && !options.deployBusy,
            compat: compatResult,
        };
    }));

    items.sort((a, b) => (b.createdAt - a.createdAt) || b.releaseId.localeCompare(a.releaseId));

    const orphanHostIds = hostIds.filter(id => !state.activeHostIds.has(id));
    const orphanWebIds = webIds.filter(id => !state.activeWebIds.has(id) && !pairedWebRefCount.has(id));
    const orphanSizeBytes = orphanHostIds.reduce((sum, id) => sum + (hostSizeMap.get(id) || 0), 0)
        + orphanWebIds.reduce((sum, id) => sum + (webSizeMap.get(id) || 0), 0);

    let totalSizeBytes = 0;
    for (const size of backendSizeMap.values()) totalSizeBytes += size;
    for (const size of webSizeMap.values()) totalSizeBytes += size;
    for (const size of hostSizeMap.values()) totalSizeBytes += size;

    const compatibleCount = items.filter(item => !item.isActive && item.compat.compatible).length;
    const outdatedItems = items.filter(item => !item.isActive && item.compat.outdated);

    return {
        releases: items,
        summary: {
            totalCount: items.length,
            compatibleCount,
            outdatedCount: outdatedItems.length,
            totalSizeBytes,
            outdatedSizeBytes: outdatedItems.reduce((sum, item) => sum + item.sizeBytes, 0),
            orphanHostCount: orphanHostIds.length,
            orphanWebCount: orphanWebIds.length,
            orphanSizeBytes,
        },
    };
}

function pruneSlotHistory(slot: ActiveSlotState, removedSet: Set<string>): ActiveSlotState {
    const history = slot.history.filter(id => !removedSet.has(id));
    let previous = slot.previous;
    if (previous && removedSet.has(previous)) {
        previous = history.find(id => id !== slot.active) || null;
    }
    return {
        ...slot,
        previous,
        history,
        updatedAt: Date.now(),
    };
}

async function deleteReleases(options: DeleteReleasesOptions): Promise<DeleteReleasesResult> {
    const releasesDir = path.resolve(options.releasesDir);
    const runtimeDir = path.resolve(options.runtimeDir);
    const { cleanOrphans } = options;
    const rawIds = Array.isArray(options.releaseIds) ? options.releaseIds : [];
    const targetBackendIds = [...new Set(rawIds.map(validateBackendReleaseId))];

    if (targetBackendIds.length === 0 && !cleanOrphans) {
        throw createReleaseManagerError('请至少选择一个需要删除的历史版本', 400, 'NO_RELEASES_SELECTED');
    }

    const deployLockPath = path.join(runtimeDir, 'deploy-operation.lock');
    let lockHandle: any;
    try {
        lockHandle = acquireExclusiveLock(deployLockPath, {
            role: 'deploy',
            instanceId: `release_delete_${process.pid}`,
            nonce: crypto.randomUUID(),
        });
    } catch (err: any) {
        if (err?.code === 'LOCK_ALREADY_HELD' || err?.code === 'LOCK_CONTENTION') {
            throw createReleaseManagerError('当前已有部署或更新任务正在运行，请稍候完成后再试', 409, 'UPDATE_BUSY');
        }
        throw err;
    }

    try {
        const state = readRuntimeState(runtimeDir, options.appRoot, releasesDir);
        for (const id of targetBackendIds) {
            if (state.activeBackendIds.has(id)) {
                throw createReleaseManagerError(`不能删除当前正在运行的版本：${id}`, 409, 'CANNOT_DELETE_ACTIVE_RELEASE');
            }
        }

        const backendBaseDir = path.join(releasesDir, 'backend');
        const webBaseDir = path.join(releasesDir, 'web');
        const hostBaseDir = path.join(releasesDir, 'host');

        const allBackendIds = listSubdirsMatching(backendBaseDir, BACKEND_RELEASE_ID_RE);
        const allWebIds = listSubdirsMatching(webBaseDir, WEB_RELEASE_ID_RE);
        const allHostIds = listSubdirsMatching(hostBaseDir, HOST_RELEASE_ID_RE);

        const selected = new Set(targetBackendIds);
        const deletedReleaseIds = allBackendIds.filter(id => selected.has(id));
        const selectedWeb = new Set(pairedWebReleases(backendBaseDir, deletedReleaseIds));
        const keepWeb = new Set([...state.activeWebIds, ...pairedWebReleases(backendBaseDir, allBackendIds.filter(id => !selected.has(id)))]);
        const deletedWebIds = allWebIds.filter(id => !keepWeb.has(id) && (cleanOrphans || selectedWeb.has(id)));
        const deletedHostIds = cleanOrphans ? allHostIds.filter(id => !state.activeHostIds.has(id)) : [];
        const dirs = [
            ...deletedReleaseIds.map(id => path.join(backendBaseDir, id)),
            ...deletedWebIds.map(id => path.join(webBaseDir, id)),
            ...deletedHostIds.map(id => path.join(hostBaseDir, id)),
        ];
        const sizes = await Promise.all(dirs.map(computeDirSizeBytes));

        // Unlink historical pointers first. If removal fails, remaining directories are still listed for retry.
        if (dirs.length && fs.existsSync(state.activeReleasesPath)) {
            const nextReleases = {
                backend: pruneSlotHistory(state.slots.backend, new Set(deletedReleaseIds)),
                web: pruneSlotHistory(state.slots.web, new Set(deletedWebIds)),
                host: pruneSlotHistory(state.slots.host, new Set(deletedHostIds)),
            };
            writeJsonFileAtomic(state.activeReleasesPath, nextReleases);
        }

        for (const dir of dirs) {
            await fs.promises.rm(dir, { recursive: true, force: true });
            dirSizeCache.delete(dir);
        }

        return {
            deletedReleaseIds,
            deletedWebIds,
            deletedHostIds,
            freedBytes: sizes.reduce((total, size) => total + size, 0),
        };
    } finally {
        lockHandle.release();
    }
}

module.exports = {
    createEmptySummary,
    resolveReleasesDir,
    listReleases,
    deleteReleases,
};
