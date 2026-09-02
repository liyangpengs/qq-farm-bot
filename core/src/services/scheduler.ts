export {};
const { createModuleLogger } = require('./logger');
const { classForSchedulerNamespace, runWithRequestClass } = require('../utils/request-context');

const schedulerLogger = createModuleLogger('scheduler');

interface TaskMeta {
    kind: 'timeout' | 'interval';
    delayMs: number;
    createdAt: number;
    nextRunAt: number;
    lastRunAt: number;
    runCount: number;
    running: boolean;
    preventOverlap: boolean;
    handle: any;
}

interface NamespaceStore {
    namespace: string;
    createdAt: number;
    timers: Map<string, TaskMeta>;
}

const schedulerRegistry = new Map<string, NamespaceStore>();

function toDelayMs(value: any, fallbackMs = 0): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return Math.max(0, fallbackMs | 0);
    return Math.max(0, Math.floor(n));
}

function ensureNamespaceStore(namespace: string): NamespaceStore {
    const key = String(namespace || 'default');
    const existed = schedulerRegistry.get(key);
    if (existed) return existed;
    const created: NamespaceStore = {
        namespace: key,
        createdAt: Date.now(),
        timers: new Map(),
    };
    schedulerRegistry.set(key, created);
    return created;
}

interface TaskSnapshot {
    name: string;
    kind: string;
    delayMs: number;
    createdAt: number;
    nextRunAt: number;
    lastRunAt: number;
    runCount: number;
    running: boolean;
    preventOverlap: boolean;
}

function normalizeTaskSnapshot(taskName: string, meta: TaskMeta): TaskSnapshot {
    const item = meta || ({} as TaskMeta);
    return {
        name: String(taskName || ''),
        kind: item.kind || 'timeout',
        delayMs: Math.max(0, Number(item.delayMs) || 0),
        createdAt: Number(item.createdAt) || 0,
        nextRunAt: Number(item.nextRunAt) || 0,
        lastRunAt: Number(item.lastRunAt) || 0,
        runCount: Number(item.runCount) || 0,
        running: !!item.running,
        preventOverlap: item.preventOverlap !== false,
    };
}

interface SchedulerSnapshot {
    namespace: string;
    createdAt: number;
    taskCount: number;
    tasks: TaskSnapshot[];
}

interface RegistrySnapshot {
    generatedAt: number;
    schedulerCount: number;
    schedulers: SchedulerSnapshot[];
}

function getSchedulerRegistrySnapshot(namespace = ''): RegistrySnapshot {
    const ns = String(namespace || '').trim();
    const list: SchedulerSnapshot[] = [];
    for (const [name, store] of schedulerRegistry.entries()) {
        if (ns && name !== ns) continue;
        const tasks: TaskSnapshot[] = [];
        for (const [taskName, meta] of store.timers.entries()) {
            tasks.push(normalizeTaskSnapshot(taskName, meta));
        }
        tasks.sort((a, b) => a.name.localeCompare(b.name));
        list.push({
            namespace: name,
            createdAt: Number(store.createdAt) || 0,
            taskCount: tasks.length,
            tasks,
        });
    }
    list.sort((a, b) => a.namespace.localeCompare(b.namespace));
    return {
        generatedAt: Date.now(),
        schedulerCount: list.length,
        schedulers: list,
    };
}

interface Scheduler {
    setTimeoutTask: (taskName: string, delayMs: number, taskFn: () => Promise<void> | void) => any;
    setIntervalTask: (taskName: string, intervalMs: number, taskFn: () => Promise<void> | void, options?: any) => any;
    clear: (taskName: string) => boolean;
    clearAll: () => void;
    has: (taskName: string) => boolean;
    getTaskNames: () => string[];
    getSnapshot: () => SchedulerSnapshot;
}

function createScheduler(namespace = 'default'): Scheduler {
    const name = String(namespace || 'default');
    const store = ensureNamespaceStore(name);
    const timers = store.timers;
    // 定时任务默认属于哪个请求班次：任务体内部发的所有 Gateway 请求都会继承它，
    // 这样后台定时任务不会伪装成用户前台操作去抢连接。
    const defaultRequestClass = classForSchedulerNamespace(name);

    function runTask(taskFn: () => Promise<void> | void): Promise<void> | void {
        return runWithRequestClass(defaultRequestClass, taskFn);
    }

    function clear(taskName: string): boolean {
        const key = String(taskName || '');
        const entry = timers.get(key);
        if (!entry) return false;
        timers.delete(key);
        if (entry.kind === 'interval') {
            clearInterval(entry.handle);
        } else {
            clearTimeout(entry.handle);
        }
        return true;
    }

    function clearAll(): void {
        const keys = Array.from(timers.keys());
        for (const key of keys) clear(key);
    }

    function setTimeoutTask(taskName: string, delayMs: number, taskFn: () => Promise<void> | void): any {
        const key = String(taskName || '');
        if (!key) throw new Error('taskName 不能为空');
        if (typeof taskFn !== 'function') throw new Error(`timeout 任务 ${key} 缺少回调函数`);
        clear(key);
        const delay = toDelayMs(delayMs, 0);
        const entry: TaskMeta = {
            kind: 'timeout',
            delayMs: delay,
            createdAt: Date.now(),
            nextRunAt: Date.now() + delay,
            lastRunAt: 0,
            runCount: 0,
            running: false,
            preventOverlap: true,
            handle: null,
        };
        const handle = setTimeout(async () => {
            const current = timers.get(key);
            if (!current || current.handle !== handle) return;
            current.running = true;
            current.lastRunAt = Date.now();
            current.runCount += 1;
            try {
                await runTask(taskFn);
            } catch (e: any) {
                schedulerLogger.warn(`[${name}] timeout 任务执行失败: ${key}`, {
                    module: 'scheduler',
                    scope: name,
                    task: key,
                    error: e && e.message ? e.message : String(e),
                });
            } finally {
                const after = timers.get(key);
                if (after && after.handle === handle) {
                    timers.delete(key);
                }
            }
        }, delay);
        entry.handle = handle;
        timers.set(key, entry);
        return handle;
    }

    function setIntervalTask(taskName: string, intervalMs: number, taskFn: () => Promise<void> | void, options: any = {}): any {
        const key = String(taskName || '');
        if (!key) throw new Error('taskName 不能为空');
        if (typeof taskFn !== 'function') throw new Error(`interval 任务 ${key} 缺少回调函数`);
        clear(key);

        const delay = Math.max(1, toDelayMs(intervalMs, 1000));
        const preventOverlap = options.preventOverlap !== false;
        const runImmediately = !!options.runImmediately;
        const entry: TaskMeta = {
            kind: 'interval',
            delayMs: delay,
            createdAt: Date.now(),
            nextRunAt: Date.now() + delay,
            lastRunAt: 0,
            runCount: 0,
            running: false,
            preventOverlap,
            handle: null,
        };

        const runner = async () => {
            const current = timers.get(key);
            if (!current) return;
            if (preventOverlap && current.running) return;
            current.running = true;
            current.lastRunAt = Date.now();
            current.runCount += 1;
            try {
                await runTask(taskFn);
            } catch (e: any) {
                schedulerLogger.warn(`[${name}] interval 任务执行失败: ${key}`, {
                    module: 'scheduler',
                    scope: name,
                    task: key,
                    error: e && e.message ? e.message : String(e),
                });
            } finally {
                const updated = timers.get(key);
                if (updated) {
                    updated.running = false;
                    updated.nextRunAt = Date.now() + delay;
                }
            }
        };

        if (runImmediately) {
            Promise.resolve().then(runner).catch(() => null);
        }

        const handle = setInterval(runner, delay);
        entry.handle = handle;
        timers.set(key, entry);
        return handle;
    }

    function has(taskName: string): boolean {
        return timers.has(String(taskName || ''));
    }

    function getTaskNames(): string[] {
        return Array.from(timers.keys());
    }

    function getSnapshot(): SchedulerSnapshot {
        const one = getSchedulerRegistrySnapshot(name);
        return one.schedulers[0] || { namespace: name, createdAt: Date.now(), taskCount: 0, tasks: [] };
    }

    return {
        setTimeoutTask,
        setIntervalTask,
        clear,
        clearAll,
        has,
        getTaskNames,
        getSnapshot,
    };
}

module.exports = {
    createScheduler,
    getSchedulerRegistrySnapshot,
};
