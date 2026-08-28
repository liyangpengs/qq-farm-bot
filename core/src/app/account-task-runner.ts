import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
    AccountTaskMetric,
    AccountTaskMetricObserver,
    AccountTaskMetricSource,
    AccountTaskPriority,
} from './account-task-metrics';

export {};

const { createAccountTaskMetric } = require('./account-task-metrics');

interface AccountTaskOptions {
    priority?: AccountTaskPriority;
    dedupeKey?: string;
    requestId?: string;
}

interface AccountTaskRunnerOptions {
    now?: () => number;
    agingIntervalMs?: number;
    onMetric?: AccountTaskMetricObserver;
}

interface QueuedTask<T> {
    taskId: string;
    name: string;
    priority: AccountTaskPriority;
    requestId: string;
    parentTaskId: string;
    parentTaskName: string;
    blockedByTaskId: string;
    blockedByTaskName: string;
    dedupeKey: string;
    queuedAt: number;
    startedAt: number;
    sequence: number;
    queueDepthAtSubmit: number;
    queueDepthAtStart: number;
    dedupeHits: number;
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
    private onMetric: AccountTaskMetricObserver | null;
    private activeTask: QueuedTask<any> | null = null;
    private sequence = 0;
    private drainScheduled = false;
    private closedReason = '';

    constructor(options: AccountTaskRunnerOptions = {}) {
        this.now = options.now || Date.now;
        this.agingIntervalMs = Math.max(1, Number(options.agingIntervalMs) || DEFAULT_AGING_INTERVAL_MS);
        this.onMetric = typeof options.onMetric === 'function' ? options.onMetric : null;
    }

    setMetricObserver(observer: AccountTaskMetricObserver | null): void {
        this.onMetric = typeof observer === 'function' ? observer : null;
    }

    close(reason = '账号任务已停止'): number {
        const closedReason = String(reason || '账号任务已停止');
        this.closedReason = closedReason;
        return this.clearPending(closedReason);
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
            return this.runInline(
                taskName,
                run,
                options.priority || this.activeTask?.priority || 'scheduled',
                String(options.requestId || this.activeTask?.requestId || ''),
            );
        }

        const dedupeKey = String(options.dedupeKey || '').trim();
        if (dedupeKey) {
            const queued = this.queuedByDedupeKey.get(dedupeKey);
            if (queued) {
                const priority = options.priority || 'scheduled';
                if (PRIORITY_RANK[priority] < PRIORITY_RANK[queued.priority]) {
                    queued.priority = priority;
                }
                queued.dedupeHits += 1;
                return queued.promise as Promise<T>;
            }
        }

        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: any) => void;
        const promise = new Promise<T>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        const blockedByTask = this.activeTask;
        const task: QueuedTask<T> = {
            taskId: randomUUID(),
            name: taskName,
            priority: options.priority || 'scheduled',
            requestId: String(options.requestId || ''),
            parentTaskId: '',
            parentTaskName: '',
            blockedByTaskId: blockedByTask?.taskId || '',
            blockedByTaskName: blockedByTask?.name || '',
            dedupeKey,
            queuedAt: this.now(),
            startedAt: 0,
            sequence: this.sequence++,
            queueDepthAtSubmit: this.queue.length + 1,
            queueDepthAtStart: 0,
            dedupeHits: 0,
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

        const parentTask = this.executionContext.getStore();
        if (!parentTask || parentTask !== this.activeTask) return Promise.resolve().then(run);
        return this.runInline(taskName, run, parentTask.priority, parentTask.requestId);
    }

    clearPending(reason = '账号任务已停止'): number {
        const pending = this.queue.splice(0);
        this.queuedByDedupeKey.clear();
        const finishedAt = this.now();
        for (const task of pending) {
            this.emitMetric(task, 'cancelled', finishedAt, finishedAt);
            task.reject(new Error(reason));
        }
        return pending.length;
    }

    getSnapshot(): any {
        return {
            closed: this.closedReason !== '',
            running: this.activeTask
                ? {
                    taskId: this.activeTask.taskId,
                    name: this.activeTask.name,
                    priority: this.activeTask.priority,
                    requestId: this.activeTask.requestId,
                    queuedAt: this.activeTask.queuedAt,
                    startedAt: this.activeTask.startedAt,
                }
                : null,
            queued: this.queue.map(task => ({
                taskId: task.taskId,
                name: task.name,
                priority: task.priority,
                requestId: task.requestId,
                blockedByTaskId: task.blockedByTaskId,
                blockedByTaskName: task.blockedByTaskName,
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
        task.startedAt = this.now();
        task.queueDepthAtStart = this.queue.length;
        if (task.dedupeKey && this.queuedByDedupeKey.get(task.dedupeKey) === task) {
            this.queuedByDedupeKey.delete(task.dedupeKey);
        }

        let outcome: AccountTaskMetric['outcome'] = 'success';
        try {
            const result = await this.executionContext.run(task, task.run);
            task.resolve(result);
        } catch (error) {
            outcome = 'error';
            task.reject(error);
        } finally {
            this.emitMetric(task, outcome, task.startedAt, this.now());
            this.activeTask = null;
            this.scheduleDrain();
        }
    }

    private runInline<T>(
        name: string,
        run: () => Promise<T> | T,
        priority: AccountTaskPriority,
        requestId: string,
    ): Promise<T> {
        const parentTask = this.activeTask;
        const startedAt = this.now();
        const source: AccountTaskMetricSource = {
            taskId: randomUUID(),
            name,
            priority,
            requestId,
            parentTaskId: parentTask?.taskId || '',
            parentTaskName: parentTask?.name || '',
            queuedAt: startedAt,
            queueDepthAtSubmit: this.queue.length,
            queueDepthAtStart: this.queue.length,
            dedupeHits: 0,
        };
        return Promise.resolve()
            .then(run)
            .then((result) => {
                const finishedAt = this.now();
                this.emitMetric(source, 'success', startedAt, finishedAt, true);
                return result;
            }, (error) => {
                const finishedAt = this.now();
                this.emitMetric(source, 'error', startedAt, finishedAt, true);
                throw error;
            });
    }

    private emitMetric(
        task: AccountTaskMetricSource,
        outcome: AccountTaskMetric['outcome'],
        startedAt: number,
        finishedAt: number,
        inline = false,
    ): void {
        if (!this.onMetric) return;
        try {
            this.onMetric(createAccountTaskMetric(task, outcome, startedAt, finishedAt, inline));
        } catch {}
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

function setAccountTaskMetricObserver(observer: AccountTaskMetricObserver | null): void {
    accountTaskRunner.setMetricObserver(observer);
}

module.exports = {
    AccountTaskRunner,
    clearPendingAccountTasks,
    closeAccountTaskQueue,
    getAccountTaskRunnerSnapshot,
    openAccountTaskQueue,
    runAccountTaskStep,
    setAccountTaskMetricObserver,
    submitAccountTask,
};
