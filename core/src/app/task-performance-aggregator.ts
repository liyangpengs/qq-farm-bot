export {};

interface TaskPerformanceAggregatorOptions {
    now?: () => number;
}

interface LatencyHistogram {
    count: number;
    sum: number;
    max: number;
    buckets: number[];
}

interface TaskGroup {
    name: string;
    priority: string;
    inline: boolean;
    outcomes: {
        success: number;
        error: number;
        cancelled: number;
    };
    dedupeHits: number;
    maxQueueDepth: number;
    waitMs: LatencyHistogram;
    runMs: LatencyHistogram;
    totalMs: LatencyHistogram;
}

interface SlowTaskSample {
    name: string;
    priority: string;
    outcome: string;
    inline: boolean;
    taskId?: string;
    requestId?: string;
    parentTaskId?: string;
    parentTaskName?: string;
    blockedByTaskId?: string;
    blockedByTaskName?: string;
    queuedAt: number;
    startedAt: number;
    finishedAt: number;
    waitMs: number;
    runMs: number;
    totalMs: number;
    queueDepthAtSubmit: number;
    queueDepthAtStart: number;
}

const LATENCY_BUCKETS_MS = [
    1, 2, 5, 10, 20, 50, 100, 200, 500,
    1000, 2000, 5000, 10000, 20000, 30000,
    60000, 120000, 300000,
];
const MAX_SLOW_TASK_SAMPLES = 50;
const MAX_FRIEND_ROUND_SAMPLES = 64;
const SLOW_WAIT_MS = 1000;
const SLOW_RUN_MS = 2000;
const SLOW_HTTP_MS = 1000;

function createHistogram(): LatencyHistogram {
    return {
        count: 0,
        sum: 0,
        max: 0,
        buckets: Array.from({ length: LATENCY_BUCKETS_MS.length + 1 }, () => 0),
    };
}

function recordHistogram(histogram: LatencyHistogram, input: unknown): void {
    const value = Math.max(0, Number(input) || 0);
    histogram.count += 1;
    histogram.sum += value;
    histogram.max = Math.max(histogram.max, value);
    const index = LATENCY_BUCKETS_MS.findIndex(limit => value <= limit);
    histogram.buckets[index < 0 ? LATENCY_BUCKETS_MS.length : index] += 1;
}

function normalizeTaskName(input: unknown): string {
    const name = String(input || '').trim() || 'unknown';
    return name.replace(/:\d{4,}(?=$|:)/g, ':*');
}

function toNonNegativeNumber(input: unknown): number {
    return Math.max(0, Number(input) || 0);
}

function toNonNegativeInteger(input: unknown): number {
    return Math.floor(toNonNegativeNumber(input));
}

function normalizeOperationCounts(input: any): { steal: number; help: number; bad: number } {
    return {
        steal: toNonNegativeInteger(input?.steal),
        help: toNonNegativeInteger(input?.help),
        bad: toNonNegativeInteger(input?.bad),
    };
}

class TaskPerformanceAggregator {
    private readonly now: () => number;
    private readonly groups = new Map<string, TaskGroup>();
    private windowStartedAt: number;
    private taskCount = 0;
    private maxQueueDepth = 0;
    private slowTasks: SlowTaskSample[] = [];
    private friendRoundCount = 0;
    private friendRounds: any[] = [];

    constructor(options: TaskPerformanceAggregatorOptions = {}) {
        this.now = options.now || Date.now;
        this.windowStartedAt = this.now();
    }

    record(metric: any): void {
        if (!metric || typeof metric !== 'object') return;
        const name = normalizeTaskName(metric.name);
        const priority = String(metric.priority || 'scheduled');
        const inline = metric.inline === true;
        const key = `${name}\u0000${priority}\u0000${inline ? '1' : '0'}`;
        let group = this.groups.get(key);
        if (!group) {
            group = {
                name,
                priority,
                inline,
                outcomes: { success: 0, error: 0, cancelled: 0 },
                dedupeHits: 0,
                maxQueueDepth: 0,
                waitMs: createHistogram(),
                runMs: createHistogram(),
                totalMs: createHistogram(),
            };
            this.groups.set(key, group);
        }

        const outcome = metric.outcome === 'error' || metric.outcome === 'cancelled'
            ? metric.outcome
            : 'success';
        group.outcomes[outcome] += 1;
        group.dedupeHits += Math.max(0, Number(metric.dedupeHits) || 0);
        const queueDepth = Math.max(
            0,
            Number(metric.queueDepthAtSubmit) || 0,
            Number(metric.queueDepthAtStart) || 0,
        );
        group.maxQueueDepth = Math.max(group.maxQueueDepth, queueDepth);
        this.maxQueueDepth = Math.max(this.maxQueueDepth, queueDepth);
        recordHistogram(group.waitMs, metric.waitMs);
        recordHistogram(group.runMs, metric.runMs);
        recordHistogram(group.totalMs, metric.totalMs);
        this.recordSlowTask(metric, name, priority, outcome, inline);
        this.taskCount += 1;
    }

    recordFriendRound(input: any): void {
        if (!input || typeof input !== 'object') return;
        const startedAt = toNonNegativeNumber(input.startedAt);
        const finishedAt = Math.max(startedAt, toNonNegativeNumber(input.finishedAt));
        const candidates = normalizeOperationCounts(input.candidates);
        const processed = normalizeOperationCounts(input.processed);
        const candidateCount = toNonNegativeInteger(input.candidateCount);
        const processedCount = toNonNegativeInteger(input.processedCount);
        this.friendRoundCount += 1;
        this.friendRounds.push({
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            outcome: input.outcome === 'error' || input.outcome === 'cancelled'
                ? input.outcome
                : 'success',
            friendCount: toNonNegativeInteger(input.friendCount),
            candidateCount,
            processedCount,
            deferredCount: Math.max(0, toNonNegativeInteger(input.deferredCount)),
            candidates,
            processed,
        });
        if (this.friendRounds.length > MAX_FRIEND_ROUND_SAMPLES) this.friendRounds.shift();
    }

    snapshot(): any {
        return this.buildSnapshot(this.now());
    }

    drain(): any {
        const endedAt = this.now();
        const snapshot = this.buildSnapshot(endedAt);
        if (!snapshot) return null;
        this.groups.clear();
        this.taskCount = 0;
        this.maxQueueDepth = 0;
        this.slowTasks = [];
        this.friendRoundCount = 0;
        this.friendRounds = [];
        this.windowStartedAt = endedAt;
        return snapshot;
    }

    private buildSnapshot(endedAt: number): any {
        if (this.taskCount === 0 && this.friendRoundCount === 0) return null;
        return {
            windowStartedAt: this.windowStartedAt,
            windowEndedAt: endedAt,
            taskCount: this.taskCount,
            maxQueueDepth: this.maxQueueDepth,
            latencyBucketBoundsMs: [...LATENCY_BUCKETS_MS],
            ...(this.slowTasks.length > 0 ? { slowTasks: this.slowTasks.map(sample => ({ ...sample })) } : {}),
            ...(this.friendRoundCount > 0
                ? {
                        friendRoundCount: this.friendRoundCount,
                        friendRounds: this.friendRounds.map(round => ({
                            ...round,
                            candidates: { ...round.candidates },
                            processed: { ...round.processed },
                        })),
                    }
                : {}),
            tasks: [...this.groups.values()]
                .map(group => ({
                    ...group,
                    outcomes: { ...group.outcomes },
                    waitMs: { ...group.waitMs, buckets: [...group.waitMs.buckets] },
                    runMs: { ...group.runMs, buckets: [...group.runMs.buckets] },
                    totalMs: { ...group.totalMs, buckets: [...group.totalMs.buckets] },
                }))
                .sort((left, right) => left.name.localeCompare(right.name)
                    || left.priority.localeCompare(right.priority)),
        };
    }

    private recordSlowTask(metric: any, name: string, priority: string, outcome: string, inline: boolean): void {
        if (name.startsWith('scheduler.')) return;
        const waitMs = toNonNegativeNumber(metric.waitMs);
        const runMs = toNonNegativeNumber(metric.runMs);
        const totalMs = toNonNegativeNumber(metric.totalMs);
        const isSlow = waitMs >= SLOW_WAIT_MS
            || runMs >= SLOW_RUN_MS
            || (name.startsWith('http:') && totalMs >= SLOW_HTTP_MS);
        if (!isSlow) return;

        const sample: SlowTaskSample = {
            name,
            priority,
            outcome,
            inline,
            ...(metric.taskId ? { taskId: String(metric.taskId) } : {}),
            ...(metric.requestId ? { requestId: String(metric.requestId) } : {}),
            ...(metric.parentTaskId ? { parentTaskId: String(metric.parentTaskId) } : {}),
            ...(metric.parentTaskName ? { parentTaskName: normalizeTaskName(metric.parentTaskName) } : {}),
            ...(metric.blockedByTaskId ? { blockedByTaskId: String(metric.blockedByTaskId) } : {}),
            ...(metric.blockedByTaskName ? { blockedByTaskName: normalizeTaskName(metric.blockedByTaskName) } : {}),
            queuedAt: toNonNegativeNumber(metric.queuedAt),
            startedAt: toNonNegativeNumber(metric.startedAt),
            finishedAt: toNonNegativeNumber(metric.finishedAt),
            waitMs,
            runMs,
            totalMs,
            queueDepthAtSubmit: toNonNegativeInteger(metric.queueDepthAtSubmit),
            queueDepthAtStart: toNonNegativeInteger(metric.queueDepthAtStart),
        };
        this.slowTasks.push(sample);
        this.slowTasks.sort((left, right) => (
            Math.max(right.waitMs, right.runMs, right.totalMs)
            - Math.max(left.waitMs, left.runMs, left.totalMs)
        ));
        if (this.slowTasks.length > MAX_SLOW_TASK_SAMPLES) this.slowTasks.length = MAX_SLOW_TASK_SAMPLES;
    }
}

module.exports = {
    LATENCY_BUCKETS_MS,
    TaskPerformanceAggregator,
    normalizeTaskName,
};
