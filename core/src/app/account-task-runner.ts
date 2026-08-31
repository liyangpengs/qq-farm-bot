import { AsyncLocalStorage } from 'node:async_hooks';

export {};

const { getAmbientRequestClass, runWithRequestClass } = require('../utils/request-context');

type AccountTaskPriority = 'interactive' | 'event' | 'scheduled' | 'maintenance';

interface AccountTaskOptions {
    priority?: AccountTaskPriority;
    dedupeKey?: string;
    requestClass?: 'critical' | 'foreground' | 'farm' | 'friend' | 'background';
}

interface AccountTaskRunnerOptions {
    now?: () => number;
    agingIntervalMs?: number;
}

interface QueuedTask<T> {
    name: string;
    priority: AccountTaskPriority;
    dedupeKey: string;
    requestClass: string | null;
    queuedAt: number;
    sequence: number;
    run: () => Promise<T> | T;
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: any) => void;
}

const PRIORITY_RANK: Record<AccountTaskPriority, number> = {
    interactive: 0,
    event: 1,
    scheduled: 2,
    maintenance: 3,
};

const DEFAULT_AGING_INTERVAL_MS = 30000;

class AccountTaskRunner {
    private readonly queue: QueuedTask<any>[] = [];
    private readonly queuedByDedupeKey = new Map<string, QueuedTask<any>>();
    private readonly executionContext = new AsyncLocalStorage<QueuedTask<any>>();
    private readonly now: () => number;
    private readonly agingIntervalMs: number;
    private activeTask: QueuedTask<any> | null = null;
    private sequence = 0;
    private drainScheduled = false;
    private closedReason = '';

    constructor(options: AccountTaskRunnerOptions = {}) {
        this.now = options.now || Date.now;
        this.agingIntervalMs = Math.max(1, Number(options.agingIntervalMs) || DEFAULT_AGING_INTERVAL_MS);
    }

    close(reason = '账号任务已停止'): number {
        this.closedReason = String(reason || '账号任务已停止');
        return this.clearPending(this.closedReason);
    }

    open(): void {
        this.closedReason = '';
    }

    submit<T>(name: string, run: () => Promise<T> | T, options: AccountTaskOptions = {}): Promise<T> {
        const taskName = String(name || '').trim();
        if (!taskName) throw new Error('账号任务名称不能为空');
        if (typeof run !== 'function') throw new Error(`账号任务 ${taskName} 缺少执行函数`);
        if (this.closedReason) return Promise.reject(new Error(this.closedReason));

        if (this.executionContext.getStore() === this.activeTask) {
            return Promise.resolve().then(run);
        }

        const priority = options.priority || 'scheduled';
        const requestClass = options.requestClass
            || getAmbientRequestClass()
            || (priority === 'interactive' ? 'foreground' : null);
        const dedupeKey = String(options.dedupeKey || '').trim();
        if (dedupeKey) {
            const queued = this.queuedByDedupeKey.get(dedupeKey);
            if (queued) {
                if (PRIORITY_RANK[priority] < PRIORITY_RANK[queued.priority]) {
                    queued.priority = priority;
                    queued.requestClass = requestClass;
                }
                return queued.promise as Promise<T>;
            }
        }

        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: any) => void;
        const promise = new Promise<T>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        const task: QueuedTask<T> = {
            name: taskName,
            priority,
            dedupeKey,
            requestClass,
            queuedAt: this.now(),
            sequence: this.sequence++,
            run,
            promise,
            resolve,
            reject,
        };

        this.queue.push(task);
        if (dedupeKey) this.queuedByDedupeKey.set(dedupeKey, task);
        this.scheduleDrain();
        return promise;
    }

    runStep<T>(name: string, run: () => Promise<T> | T): Promise<T> {
        const taskName = String(name || '').trim();
        if (!taskName) throw new Error('账号任务步骤名称不能为空');
        if (typeof run !== 'function') throw new Error(`账号任务步骤 ${taskName} 缺少执行函数`);
        return Promise.resolve().then(run);
    }

    clearPending(reason = '账号任务已停止'): number {
        const pending = this.queue.splice(0);
        this.queuedByDedupeKey.clear();
        for (const task of pending) task.reject(new Error(reason));
        return pending.length;
    }

    getSnapshot(): any {
        return {
            closed: this.closedReason !== '',
            running: this.activeTask
                ? {
                    name: this.activeTask.name,
                    priority: this.activeTask.priority,
                    queuedAt: this.activeTask.queuedAt,
                }
                : null,
            queued: this.queue.map(task => ({
                name: task.name,
                priority: task.priority,
                queuedAt: task.queuedAt,
            })),
        };
    }

    private scheduleDrain(): void {
        if (this.drainScheduled || this.activeTask) return;
        this.drainScheduled = true;
        queueMicrotask(() => {
            this.drainScheduled = false;
            void this.drain();
        });
    }

    private takeNext(): QueuedTask<any> | null {
        if (this.queue.length === 0) return null;
        const now = this.now();
        let selectedIndex = 0;
        for (let index = 1; index < this.queue.length; index++) {
            const candidate = this.queue[index];
            const selected = this.queue[selectedIndex];
            const candidateRank = this.getEffectiveRank(candidate, now);
            const selectedRank = this.getEffectiveRank(selected, now);
            if (candidateRank < selectedRank
                || (candidateRank === selectedRank && candidate.sequence < selected.sequence)) {
                selectedIndex = index;
            }
        }
        return this.queue.splice(selectedIndex, 1)[0];
    }

    private getEffectiveRank(task: QueuedTask<any>, now: number): number {
        const agingSteps = Math.floor(Math.max(0, now - task.queuedAt) / this.agingIntervalMs);
        return Math.max(PRIORITY_RANK.interactive, PRIORITY_RANK[task.priority] - agingSteps);
    }

    private async drain(): Promise<void> {
        if (this.activeTask) return;
        const task = this.takeNext();
        if (!task) return;

        this.activeTask = task;
        if (task.dedupeKey && this.queuedByDedupeKey.get(task.dedupeKey) === task) {
            this.queuedByDedupeKey.delete(task.dedupeKey);
        }

        try {
            task.resolve(await runWithRequestClass(
                task.requestClass,
                () => this.executionContext.run(task, task.run),
            ));
        } catch (error) {
            task.reject(error);
        } finally {
            this.activeTask = null;
            this.scheduleDrain();
        }
    }
}

const accountTaskRunner = new AccountTaskRunner();

function submitAccountTask<T>(
    name: string,
    run: () => Promise<T> | T,
    options: AccountTaskOptions = {},
): Promise<T> {
    return accountTaskRunner.submit(name, run, options);
}

function clearPendingAccountTasks(reason?: string): number {
    return accountTaskRunner.clearPending(reason);
}

function runAccountTaskStep<T>(name: string, run: () => Promise<T> | T): Promise<T> {
    return accountTaskRunner.runStep(name, run);
}

function closeAccountTaskQueue(reason?: string): number {
    return accountTaskRunner.close(reason);
}

function openAccountTaskQueue(): void {
    accountTaskRunner.open();
}

function getAccountTaskRunnerSnapshot(): any {
    return accountTaskRunner.getSnapshot();
}

module.exports = {
    AccountTaskRunner,
    clearPendingAccountTasks,
    closeAccountTaskQueue,
    getAccountTaskRunnerSnapshot,
    openAccountTaskQueue,
    runAccountTaskStep,
    submitAccountTask,
};
