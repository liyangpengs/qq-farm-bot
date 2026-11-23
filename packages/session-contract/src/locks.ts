import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface LockHolderMetadata {
    pid: number;
    processStart?: string;
    role: 'session-host' | 'backend' | 'deploy' | string;
    instanceId: string;
    nonce: string;
    releaseId?: string;
    startedAt: number;
}

export interface AcquireLockOptions {
    childRegistryPath?: string;
    staleWriteGraceMs?: number;
}

export interface ExclusiveLockHandle {
    lockPath: string;
    metadata: LockHolderMetadata;
    release: () => boolean;
}

export interface BackendChildEntry {
    pid: number;
    processStart?: string;
    kind: string;
    id?: string;
    startedAt: number;
}

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms: number): void {
    Atomics.wait(SLEEP_BUFFER, 0, 0, Math.max(1, Math.min(ms, 5000)));
}

function processStartToken(pid: number): string | undefined {
    if (process.platform !== 'linux') return undefined;
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        return `${fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${startTicks}`;
    } catch {
        return undefined;
    }
}

export function isProcessAlive(pid: number, processStart?: string): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        const actual = processStart && processStartToken(pid);
        return !actual || actual === processStart;
    } catch (error: any) {
        return error?.code === 'EPERM';
    }
}

export function readLockMetadata(lockPath: string): LockHolderMetadata | null {
    try {
        if (!fs.existsSync(lockPath)) return null;
        const raw = fs.readFileSync(lockPath, 'utf8').trim();
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !Number.isSafeInteger(Number(parsed.pid))) {
            return null;
        }
        return {
            pid: Number(parsed.pid),
            processStart: parsed.processStart,
            role: String(parsed.role || 'unknown'),
            instanceId: String(parsed.instanceId || ''),
            nonce: String(parsed.nonce || ''),
            releaseId: parsed.releaseId ? String(parsed.releaseId) : undefined,
            startedAt: Number(parsed.startedAt) || 0,
        };
    } catch {
        return null;
    }
}

export function readChildRegistry(registryPath: string): BackendChildEntry[] {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (error: any) {
        if (error?.code === 'ENOENT') return [];
        throw lockError('CHILD_REGISTRY_UNREADABLE', `Cannot read backend child registry: ${registryPath}`, { cause: error });
    }
    if (!Array.isArray(parsed?.children) || !parsed.children.every((entry: any) => Number.isSafeInteger(Number(entry?.pid)) && Number(entry.pid) > 0)) {
        throw lockError('CHILD_REGISTRY_UNREADABLE', `Invalid backend child registry: ${registryPath}`);
    }
    return parsed.children.map((entry: any) => ({
        pid: Number(entry.pid),
        processStart: entry.processStart,
        kind: String(entry.kind || 'child'),
        id: entry.id ? String(entry.id) : undefined,
        startedAt: Number(entry.startedAt) || 0,
    }));
}

export function writeChildRegistryAtomic(registryPath: string, children: BackendChildEntry[]): void {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const tmpPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify({ children }, null, 2), 'utf8');
        fs.renameSync(tmpPath, registryPath);
    } finally {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
            // ignore temp cleanup failure
        }
    }
}

export function listAliveBackendChildren(registryPath: string): BackendChildEntry[] {
    return readChildRegistry(registryPath).filter(entry => isProcessAlive(entry.pid, entry.processStart));
}

export class BackendChildTracker {
    private readonly registryPath: string;
    private readonly children = new Map<number, BackendChildEntry>();

    constructor(registryPath: string) {
        this.registryPath = path.resolve(registryPath);
    }

    register(pid: number, kind: string, id?: string): void {
        if (!Number.isSafeInteger(pid) || pid <= 0) return;
        const existing = listAliveBackendChildren(this.registryPath);
        for (const entry of existing) {
            if (!this.children.has(entry.pid)) this.children.set(entry.pid, entry);
        }
        this.children.set(pid, { pid, processStart: processStartToken(pid), kind, id, startedAt: Date.now() });
        this.flush();
    }

    unregister(pid: number): void {
        if (!Number.isSafeInteger(pid) || pid <= 0) return;
        this.children.delete(pid);
        const disk = listAliveBackendChildren(this.registryPath).filter(entry => entry.pid !== pid);
        for (const entry of disk) {
            if (!this.children.has(entry.pid)) this.children.set(entry.pid, entry);
        }
        this.flush();
    }

    clear(): void {
        this.children.clear();
        try {
            if (fs.existsSync(this.registryPath)) fs.unlinkSync(this.registryPath);
        } catch {
            // ignore
        }
    }

    private flush(): void {
        const alive = [...this.children.values()].filter(entry => isProcessAlive(entry.pid, entry.processStart));
        this.children.clear();
        for (const entry of alive) this.children.set(entry.pid, entry);
        writeChildRegistryAtomic(this.registryPath, alive);
    }
}

function lockError(code: string, message: string, extra: Record<string, any> = {}): Error {
    return Object.assign(new Error(message), { code, ...extra });
}

export function removeStaleLock(lockPath: string, graceMs = 500): boolean {
    if (!fs.existsSync(lockPath)) return false;
    const holder = readLockMetadata(lockPath);
    if (holder && isProcessAlive(holder.pid, holder.processStart)) return false;
    // Only one contender may check and remove an abandoned lock. Otherwise a
    // second contender could unlink the new owner's lock after the first wins.
    const guard = acquireExclusiveLock(`${lockPath}.recovery`, {
        role: 'recovery', instanceId: String(process.pid), nonce: randomUUID(),
    }, { staleWriteGraceMs: graceMs });
    try {
        const current = readLockMetadata(lockPath);
        if (current ? isProcessAlive(current.pid, current.processStart) : Date.now() - fs.statSync(lockPath).mtimeMs < graceMs) {
            return false;
        }
        fs.unlinkSync(lockPath);
        return true;
    } catch (error: any) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    } finally {
        guard.release();
    }
}

export function acquireExclusiveLock(
    lockPath: string,
    metadata: Omit<LockHolderMetadata, 'pid' | 'startedAt'> & { pid?: number; startedAt?: number },
    options: AcquireLockOptions = {},
): ExclusiveLockHandle {
    const resolvedPath = path.resolve(lockPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const fullMeta: LockHolderMetadata = {
        pid: metadata.pid ?? process.pid,
        processStart: processStartToken(metadata.pid ?? process.pid),
        role: metadata.role,
        instanceId: metadata.instanceId,
        nonce: metadata.nonce,
        releaseId: metadata.releaseId,
        startedAt: metadata.startedAt ?? Date.now(),
    };
    const staleWriteGraceMs = options.staleWriteGraceMs ?? 500;

    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            const fd = fs.openSync(resolvedPath, 'wx', 0o600);
            try {
                fs.writeFileSync(fd, JSON.stringify(fullMeta, null, 2), 'utf8');
                try { fs.fsyncSync(fd); } catch { /* ignore fsync unsupported */ }
            } finally {
                fs.closeSync(fd);
            }
            if (options.childRegistryPath) {
                try {
                    const children = listAliveBackendChildren(options.childRegistryPath);
                    if (children.length) throw lockError('BACKEND_CHILDREN_STILL_ALIVE', 'Previous backend workers are still alive', { aliveChildren: children });
                } catch (error) {
                    fs.unlinkSync(resolvedPath);
                    throw error;
                }
            }

            let released = false;
            return {
                lockPath: resolvedPath,
                metadata: fullMeta,
                release: () => {
                    if (released) return false;
                    released = true;
                    const current = readLockMetadata(resolvedPath);
                    if (!current || current.instanceId !== fullMeta.instanceId || current.nonce !== fullMeta.nonce) {
                        return false;
                    }
                    try {
                        fs.unlinkSync(resolvedPath);
                        return true;
                    } catch (err: any) {
                        if (err?.code === 'ENOENT') return false;
                        throw err;
                    }
                },
            };
        } catch (error: any) {
            if (error?.code !== 'EEXIST') throw error;

            const holder = readLockMetadata(resolvedPath);
            if (!holder) {
                try {
                    const stat = fs.statSync(resolvedPath);
                    if (Date.now() - stat.mtimeMs < staleWriteGraceMs) {
                        sleepSyncMs(staleWriteGraceMs - (Date.now() - stat.mtimeMs));
                        continue;
                    }
                } catch {
                    continue;
                }
            }

            if (holder && isProcessAlive(holder.pid, holder.processStart)) {
                throw lockError(
                    'LOCK_ALREADY_HELD',
                    `Lock ${path.basename(resolvedPath)} is already held by pid=${holder.pid} (${holder.role}:${holder.instanceId})`,
                    { lockPath: resolvedPath, holder },
                );
            }

            if (options.childRegistryPath) {
                const aliveChildren = listAliveBackendChildren(options.childRegistryPath);
                if (aliveChildren.length > 0) {
                    throw lockError(
                        'BACKEND_CHILDREN_STILL_ALIVE',
                        `Previous backend child processes are still alive: ${aliveChildren.map(c => `${c.kind}:${c.pid}`).join(', ')}`,
                        { lockPath: resolvedPath, holder, aliveChildren },
                    );
                }
            }

            removeStaleLock(resolvedPath, staleWriteGraceMs);
        }
    }

    throw lockError('LOCK_CONTENTION', `Failed to acquire lock ${path.basename(resolvedPath)} after retries`, {
        lockPath: resolvedPath,
    });
}
