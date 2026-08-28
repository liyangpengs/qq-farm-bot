const assert = require('node:assert/strict');
const test = require('node:test');

const { TaskPerformanceAggregator } = require('../dist/app/task-performance-aggregator');
const { createScheduledTaskMetric } = require('../dist/app/account-task-metrics');

test('task performance metrics are grouped without high-cardinality numeric suffixes', () => {
    let now = 1000;
    const aggregator = new TaskPerformanceAggregator({ now: () => now });

    aggregator.record({
        name: 'friend.help:123456',
        priority: 'scheduled',
        outcome: 'success',
        waitMs: 12,
        runMs: 80,
        totalMs: 92,
        queueDepthAtSubmit: 3,
        queueDepthAtStart: 1,
        dedupeHits: 2,
        inline: false,
    });
    aggregator.record({
        name: 'friend.help:987654',
        priority: 'scheduled',
        outcome: 'error',
        waitMs: 30,
        runMs: 120,
        totalMs: 150,
        queueDepthAtSubmit: 5,
        queueDepthAtStart: 2,
        dedupeHits: 0,
        inline: false,
    });

    now = 2000;
    const snapshot = aggregator.drain();
    assert.equal(snapshot.taskCount, 2);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].name, 'friend.help:*');
    assert.deepEqual(snapshot.tasks[0].outcomes, { success: 1, error: 1, cancelled: 0 });
    assert.equal(snapshot.tasks[0].waitMs.sum, 42);
    assert.equal(snapshot.tasks[0].runMs.max, 120);
    assert.equal(snapshot.tasks[0].totalMs.count, 2);
    assert.equal(snapshot.tasks[0].dedupeHits, 2);
    assert.equal(snapshot.maxQueueDepth, 5);
    assert.equal(snapshot.windowStartedAt, 1000);
    assert.equal(snapshot.windowEndedAt, 2000);
    assert.equal(aggregator.drain(), null);
});

test('scheduled task metrics separate scheduler lag from execution time', () => {
    const metric = createScheduledTaskMetric({
        name: 'scheduler.friend-round',
        priority: 'scheduled',
        outcome: 'success',
        dueAt: 1000,
        startedAt: 1450,
        finishedAt: 3450,
    });

    assert.equal(metric.waitMs, 450);
    assert.equal(metric.runMs, 2000);
    assert.equal(metric.totalMs, 2450);
    assert.equal(metric.inline, true);
    assert.equal(metric.queueDepthAtSubmit, 0);
});

test('cancelled scheduled task metrics retain time already spent running', () => {
    const metric = createScheduledTaskMetric({
        name: 'scheduler.friend-round',
        priority: 'scheduled',
        outcome: 'cancelled',
        dueAt: 1000,
        startedAt: 1450,
        finishedAt: 3450,
    });

    assert.equal(metric.waitMs, 450);
    assert.equal(metric.runMs, 2000);
    assert.equal(metric.totalMs, 2450);
});

test('slow task samples keep bounded causal identifiers without exposing numeric task suffixes', () => {
    const aggregator = new TaskPerformanceAggregator({ now: () => 5000 });
    aggregator.record({
        name: 'friend.bad:123456',
        priority: 'scheduled',
        outcome: 'success',
        taskId: 'task-child',
        requestId: 'request-1',
        blockedByTaskId: 'task-parent',
        blockedByTaskName: 'farm.check',
        queuedAt: 1000,
        startedAt: 2500,
        finishedAt: 3000,
        waitMs: 1500,
        runMs: 500,
        totalMs: 2000,
        queueDepthAtSubmit: 2,
        queueDepthAtStart: 1,
        dedupeHits: 0,
        inline: false,
    });

    const snapshot = aggregator.snapshot();
    assert.equal(snapshot.slowTasks.length, 1);
    assert.deepEqual(snapshot.slowTasks[0], {
        name: 'friend.bad:*',
        priority: 'scheduled',
        outcome: 'success',
        inline: false,
        taskId: 'task-child',
        requestId: 'request-1',
        blockedByTaskId: 'task-parent',
        blockedByTaskName: 'farm.check',
        queuedAt: 1000,
        startedAt: 2500,
        finishedAt: 3000,
        waitMs: 1500,
        runMs: 500,
        totalMs: 2000,
        queueDepthAtSubmit: 2,
        queueDepthAtStart: 1,
    });
});

test('friend round summaries are exported even without task histogram samples', () => {
    const aggregator = new TaskPerformanceAggregator({ now: () => 9000 });
    aggregator.recordFriendRound({
        startedAt: 1000,
        finishedAt: 8000,
        outcome: 'cancelled',
        friendCount: 300,
        candidateCount: 300,
        processedCount: 2,
        deferredCount: 298,
        candidates: { steal: 300, help: 0, bad: 0 },
        processed: { steal: 2, help: 0, bad: 0 },
    });

    const snapshot = aggregator.drain();
    assert.equal(snapshot.taskCount, 0);
    assert.equal(snapshot.friendRoundCount, 1);
    assert.deepEqual(snapshot.friendRounds[0], {
        startedAt: 1000,
        finishedAt: 8000,
        durationMs: 7000,
        outcome: 'cancelled',
        friendCount: 300,
        candidateCount: 300,
        processedCount: 2,
        deferredCount: 298,
        candidates: { steal: 300, help: 0, bad: 0 },
        processed: { steal: 2, help: 0, bad: 0 },
    });
});
