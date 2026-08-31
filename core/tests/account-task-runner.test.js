const assert = require('node:assert/strict');
const test = require('node:test');

const { AccountTaskRunner } = require('../dist/app/account-task-runner');
const { getAmbientRequestClass, runWithRequestClass } = require('../dist/utils/request-context');

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

test('task steps run directly without creating a queue when no parent task exists', async () => {
    const runner = new AccountTaskRunner();

    assert.equal(await runner.runStep('friend.phase.enter', () => 'entered'), 'entered');
    assert.equal(runner.getSnapshot().running, null);
    assert.deepEqual(runner.getSnapshot().queued, []);
});

test('queued account tasks retain the request class captured when submitted', async () => {
    const runner = new AccountTaskRunner();
    const gate = deferred();
    const active = runner.submit('active', () => gate.promise);
    await new Promise(setImmediate);

    const friend = runWithRequestClass('friend', () => runner.submit(
        'friend.visit',
        () => getAmbientRequestClass(),
        { priority: 'scheduled' },
    ));
    const farm = runWithRequestClass('farm', () => runner.submit(
        'farm.check',
        () => getAmbientRequestClass(),
        { priority: 'scheduled' },
    ));

    gate.resolve();
    await active;
    assert.deepEqual(await Promise.all([friend, farm]), ['friend', 'farm']);
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
