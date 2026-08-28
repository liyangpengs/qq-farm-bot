const assert = require('node:assert/strict');
const test = require('node:test');

const { AccountTaskRunner } = require('../dist/app/account-task-runner');

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test('account tasks run one at a time', async () => {
    const runner = new AccountTaskRunner();
    const gate = deferred();
    const events = [];

    const first = runner.submit('first', async () => {
        events.push('first:start');
        await gate.promise;
        events.push('first:end');
    });
    const second = runner.submit('second', async () => {
        events.push('second:start');
        events.push('second:end');
    });

    await new Promise(setImmediate);
    assert.deepEqual(events, ['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('separate account runners do not block each other', async () => {
    const firstAccount = new AccountTaskRunner();
    const secondAccount = new AccountTaskRunner();
    const gate = deferred();
    const started = [];

    const first = firstAccount.submit('first-account', async () => {
        started.push('first');
        await gate.promise;
    });
    const second = secondAccount.submit('second-account', async () => {
        started.push('second');
        await gate.promise;
    });

    await new Promise(setImmediate);
    assert.deepEqual(started.sort(), ['first', 'second']);

    gate.resolve();
    await Promise.all([first, second]);
});

test('nested submissions on the same runner execute without deadlocking', { timeout: 250 }, async () => {
    const runner = new AccountTaskRunner();
    const events = [];

    const outer = runner.submit('outer', async () => {
        events.push('outer:start');
        const value = await runner.submit('inner', async () => {
            events.push('inner');
            return 'ok';
        });
        events.push('outer:end');
        return value;
    });
    const queued = runner.submit('queued', () => events.push('queued'));

    assert.equal(await outer, 'ok');
    await queued;
    assert.deepEqual(events, ['outer:start', 'inner', 'outer:end', 'queued']);
});

test('interactive work runs before queued background work', async () => {
    const runner = new AccountTaskRunner();
    const gate = deferred();
    const events = [];

    const active = runner.submit('active', async () => {
        events.push('active');
        await gate.promise;
    });
    await new Promise(setImmediate);

    const background = runner.submit('background', () => events.push('background'), { priority: 'scheduled' });
    const interactive = runner.submit('interactive', () => events.push('interactive'), { priority: 'interactive' });

    gate.resolve();
    await Promise.all([active, background, interactive]);
    assert.deepEqual(events, ['active', 'interactive', 'background']);
});

test('aged background work runs before newly queued interactive work', async () => {
    let now = 0;
    const runner = new AccountTaskRunner({
        now: () => now,
        agingIntervalMs: 100,
    });
    const gate = deferred();
    const events = [];

    const active = runner.submit('active', () => gate.promise);
    await new Promise(setImmediate);
    const maintenance = runner.submit('maintenance', () => events.push('maintenance'), {
        priority: 'maintenance',
    });

    now = 300;
    const interactive = runner.submit('interactive', () => events.push('interactive'), {
        priority: 'interactive',
    });

    gate.resolve();
    await Promise.all([active, maintenance, interactive]);
    assert.deepEqual(events, ['maintenance', 'interactive']);
});

test('queued tasks with the same dedupe key share one execution', async () => {
    const runner = new AccountTaskRunner();
    const gate = deferred();
    let executions = 0;

    const active = runner.submit('active', () => gate.promise);
    await new Promise(setImmediate);

    const first = runner.submit('farm.check', () => {
        executions += 1;
        return 42;
    }, { dedupeKey: 'farm.check' });
    const second = runner.submit('farm.check', () => {
        executions += 1;
        return 99;
    }, { dedupeKey: 'farm.check' });

    gate.resolve();
    await active;
    assert.deepEqual(await Promise.all([first, second]), [42, 42]);
    assert.equal(executions, 1);
});

test('triggers during an active task coalesce into one trailing execution', async () => {
    const runner = new AccountTaskRunner();
    const gate = deferred();
    let executions = 0;

    const active = runner.submit('farm.check', async () => {
        executions += 1;
        await gate.promise;
        return executions;
    }, { dedupeKey: 'farm.check' });
    await new Promise(setImmediate);

    const trailing = runner.submit('farm.check', () => {
        executions += 1;
        return executions;
    }, { dedupeKey: 'farm.check' });
    const duplicate = runner.submit('farm.check', () => {
        executions += 1;
        return executions;
    }, { dedupeKey: 'farm.check' });

    assert.notEqual(active, trailing);
    assert.equal(trailing, duplicate);
    gate.resolve();
    assert.deepEqual(await Promise.all([active, trailing, duplicate]), [1, 2, 2]);
    assert.equal(executions, 2);
});

test('a higher-priority duplicate promotes the queued task', async () => {
    const runner = new AccountTaskRunner();
    const gate = deferred();
    const events = [];

    const active = runner.submit('active', () => gate.promise);
    await new Promise(setImmediate);
    const farm = runner.submit('farm.check', () => events.push('farm'), {
        priority: 'scheduled',
        dedupeKey: 'farm.check',
    });
    const event = runner.submit('event', () => events.push('event'), {
        priority: 'event',
    });
    const promoted = runner.submit('farm.check', () => events.push('duplicate'), {
        priority: 'event',
        dedupeKey: 'farm.check',
    });

    assert.equal(promoted, farm);
    gate.resolve();
    await Promise.all([active, farm, event]);
    assert.deepEqual(events, ['farm', 'event']);
});

test('clearing the queue rejects waiting work without interrupting the active task', async () => {
    const runner = new AccountTaskRunner();
    const gate = deferred();

    const active = runner.submit('active', () => gate.promise);
    await new Promise(setImmediate);
    const waiting = runner.submit('waiting', () => true);

    assert.equal(runner.clearPending('账号已停止'), 1);
    await assert.rejects(waiting, /账号已停止/);

    gate.resolve();
    await active;
});

test('snapshot reports the active task and queued work', async () => {
    const runner = new AccountTaskRunner();
    const gate = deferred();

    const active = runner.submit('active', () => gate.promise, { priority: 'event' });
    await new Promise(setImmediate);
    const waiting = runner.submit('waiting', () => true, { priority: 'maintenance' });

    const snapshot = runner.getSnapshot();
    assert.equal(snapshot.running.name, 'active');
    assert.equal(snapshot.running.priority, 'event');
    assert.equal(typeof snapshot.running.queuedAt, 'number');
    assert.equal(snapshot.queued.length, 1);
    assert.equal(snapshot.queued[0].name, 'waiting');
    assert.equal(snapshot.queued[0].priority, 'maintenance');
    assert.equal(typeof snapshot.queued[0].queuedAt, 'number');

    gate.resolve();
    await Promise.all([active, waiting]);
});

test('task metrics report queue, execution, and dedupe timings', async () => {
    let now = 100;
    const metrics = [];
    const runner = new AccountTaskRunner({
        now: () => now,
        onMetric: metric => metrics.push(metric),
    });
    const gate = deferred();

    const active = runner.submit('active', async () => {
        now = 130;
        await gate.promise;
    });
    await new Promise(setImmediate);

    const queued = runner.submit('friend.help:123456', () => {
        now = 230;
        return 'done';
    }, { priority: 'scheduled', dedupeKey: 'friend.help:123456' });
    const duplicate = runner.submit('friend.help:123456', () => 'duplicate', {
        priority: 'event',
        dedupeKey: 'friend.help:123456',
    });

    now = 190;
    gate.resolve();
    await active;
    assert.equal(await queued, 'done');
    assert.equal(await duplicate, 'done');

    const metric = metrics.find(item => item.name === 'friend.help:123456');
    assert.equal(metric.priority, 'event');
    assert.equal(metric.outcome, 'success');
    assert.equal(metric.waitMs, 60);
    assert.equal(metric.runMs, 40);
    assert.equal(metric.totalMs, 100);
    assert.equal(metric.dedupeHits, 1);
    assert.equal(metric.queueDepthAtSubmit, 1);
});

test('queued task metrics identify the active blocker and originating request', async () => {
    const metrics = [];
    const runner = new AccountTaskRunner({ onMetric: metric => metrics.push(metric) });
    const gate = deferred();

    const active = runner.submit('farm.check', () => gate.promise);
    await new Promise(setImmediate);
    const queued = runner.submit('api:getBag', () => 'bag', {
        priority: 'interactive',
        requestId: 'request-42',
    });

    const snapshot = runner.getSnapshot();
    assert.equal(typeof snapshot.running.taskId, 'string');
    assert.equal(snapshot.queued[0].requestId, 'request-42');
    assert.equal(snapshot.queued[0].blockedByTaskId, snapshot.running.taskId);
    assert.equal(snapshot.queued[0].blockedByTaskName, 'farm.check');

    gate.resolve();
    await active;
    assert.equal(await queued, 'bag');

    const activeMetric = metrics.find(item => item.name === 'farm.check');
    const queuedMetric = metrics.find(item => item.name === 'api:getBag');
    assert.equal(queuedMetric.requestId, 'request-42');
    assert.equal(queuedMetric.blockedByTaskId, activeMetric.taskId);
    assert.equal(queuedMetric.blockedByTaskName, 'farm.check');
});

test('inline task metrics retain their parent task relationship', async () => {
    const metrics = [];
    const runner = new AccountTaskRunner({ onMetric: metric => metrics.push(metric) });

    await runner.submit('farm.check', () => runner.submit('farm.phase.get-lands', () => true));

    const parent = metrics.find(item => item.name === 'farm.check');
    const phase = metrics.find(item => item.name === 'farm.phase.get-lands');
    assert.equal(phase.inline, true);
    assert.equal(phase.parentTaskId, parent.taskId);
    assert.equal(phase.parentTaskName, 'farm.check');
});

test('task steps run directly without creating a queue when no parent task exists', async () => {
    const metrics = [];
    const runner = new AccountTaskRunner({ onMetric: metric => metrics.push(metric) });

    assert.equal(await runner.runStep('friend.phase.enter', () => 'entered'), 'entered');
    assert.deepEqual(metrics, []);
    assert.equal(runner.getSnapshot().running, null);
    assert.deepEqual(runner.getSnapshot().queued, []);
});

test('cleared tasks emit cancelled metrics', async () => {
    let now = 10;
    const metrics = [];
    const runner = new AccountTaskRunner({
        now: () => now,
        onMetric: metric => metrics.push(metric),
    });
    const gate = deferred();
    const active = runner.submit('active', () => gate.promise);
    await new Promise(setImmediate);
    const waiting = runner.submit('waiting', () => true);

    now = 45;
    runner.clearPending('stopped');
    await assert.rejects(waiting, /stopped/);

    const metric = metrics.find(item => item.name === 'waiting');
    assert.equal(metric.outcome, 'cancelled');
    assert.equal(metric.waitMs, 35);
    assert.equal(metric.runMs, 0);

    gate.resolve();
    await active;
});

test('closing the queue lets the active slice finish and rejects the next submission', async () => {
    const runner = new AccountTaskRunner();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const visited = [];

    const round = (async () => {
        for (const gid of [1, 2, 3]) {
            await runner.submit(`friend.visit:${gid}`, async () => {
                visited.push(gid);
                if (gid === 1) {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                }
            });
        }
    })();

    await firstStarted.promise;
    assert.equal(runner.close('账号已停止'), 0);
    releaseFirst.resolve();

    await assert.rejects(round, /账号已停止/);
    await assert.rejects(runner.submit('late', () => visited.push('late')), /账号已停止/);
    assert.deepEqual(visited, [1]);
    assert.equal(runner.getSnapshot().closed, true);

    runner.open();
    assert.equal(await runner.submit('after-open', () => 'ok'), 'ok');
    assert.equal(runner.getSnapshot().closed, false);
});
