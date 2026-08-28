export {};

const { TaskPerformanceAggregator } = require('../app/task-performance-aggregator');
const { PerformanceMetricsStore, boundedInteger } = require('./performance-metrics-store');

const performanceStore = new PerformanceMetricsStore();
const HTTP_WINDOW_MS = boundedInteger(process.env.FARM_PERF_WINDOW_MS, 5 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
const httpAggregators = new Map<string, any>();
let flushTimer: NodeJS.Timeout | null = null;

function recordAccountTaskMetrics(accountId: unknown, snapshot: any): void {
    if (!snapshot || (Number(snapshot.taskCount) <= 0 && Number(snapshot.friendRoundCount) <= 0)) return;
    performanceStore.append({
        kind: 'account_tasks',
        accountId: String(accountId || ''),
        ...snapshot,
    });
}

function recordHttpRequest(input: any): void {
    if (!input || typeof input !== 'object') return;
    const accountId = String(input.accountId || 'unscoped');
    let aggregator = httpAggregators.get(accountId);
    if (!aggregator) {
        aggregator = new TaskPerformanceAggregator();
        httpAggregators.set(accountId, aggregator);
    }
    const durationMs = Math.max(0, Number(input.durationMs) || 0);
    aggregator.record({
        name: `http:${String(input.method || 'GET').toUpperCase()} ${String(input.route || '/api/unknown')}`,
        priority: 'interactive',
        outcome: Number(input.statusCode) >= 400 ? 'error' : 'success',
        requestId: String(input.requestId || ''),
        queuedAt: Math.max(0, Number(input.startedAt) || 0),
        startedAt: Math.max(0, Number(input.startedAt) || 0),
        finishedAt: Math.max(0, Number(input.finishedAt) || 0),
        waitMs: 0,
        runMs: durationMs,
        totalMs: durationMs,
        queueDepthAtSubmit: 0,
        queueDepthAtStart: 0,
        dedupeHits: 0,
        inline: true,
    });
    ensureFlushTimer();
}

function flushHttpMetrics(): void {
    for (const [accountId, aggregator] of httpAggregators.entries()) {
        const snapshot = aggregator.drain();
        if (!snapshot) continue;
        performanceStore.append({
            kind: 'http',
            accountId,
            ...snapshot,
        });
    }
}

function ensureFlushTimer(): void {
    if (flushTimer) return;
    flushTimer = setInterval(flushHttpMetrics, HTTP_WINDOW_MS);
    flushTimer.unref?.();
}

function getPerformanceStatus(): any {
    return {
        ...performanceStore.getStatus(),
        windowMs: HTTP_WINDOW_MS,
        currentHttpScopes: httpAggregators.size,
    };
}

function preparePerformanceExport(days: unknown): { days: number; files: string[] } {
    const normalizedDays = boundedInteger(days, 1, 1, 30);
    flushHttpMetrics();
    return {
        days: normalizedDays,
        files: performanceStore.listExportFiles(normalizedDays),
    };
}

module.exports = {
    HTTP_WINDOW_MS,
    flushHttpMetrics,
    getPerformanceStatus,
    preparePerformanceExport,
    recordAccountTaskMetrics,
    recordHttpRequest,
};
