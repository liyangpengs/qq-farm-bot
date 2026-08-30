const assert = require('node:assert/strict');
const test = require('node:test');

const { executeWorkerApiCall } = require('../dist/app/worker-api-dispatcher');

function definition(handle, options = {}) {
    return {
        execution: options.execution || 'queued',
        allowOffline: options.allowOffline === true,
        handle,
    };
}

test('unknown worker methods preserve the existing error response', async () => {
    const response = await executeWorkerApiCall('missing', [], new Map(), {
        isAccountReady: () => true,
        submitTask: async () => null,
    });

    assert.deepEqual(response, { result: null, error: 'Unknown method' });
});

test('connected queued methods use the interactive account queue', async () => {
    const submissions = [];
    const registry = new Map([
        ['getLands', definition(([value]) => value * 2)],
    ]);

    const response = await executeWorkerApiCall('getLands', [21], registry, {
        isAccountReady: () => true,
        submitTask: async (name, run, options) => {
            submissions.push({ name, options });
            return run();
        },
    });

    assert.deepEqual(response, { result: 42, error: null });
    assert.deepEqual(submissions, [{
        name: 'api:getLands',
        options: { priority: 'interactive' },
    }]);
});

test('queued methods announce started only when their handler begins', async () => {
    let queuedRun;
    let started = 0;
    const registry = new Map([
        ['getLands', definition(() => 42)],
    ]);

    const responsePromise = executeWorkerApiCall('getLands', [], registry, {
        isAccountReady: () => true,
        submitTask: (_name, run) => new Promise((resolve, reject) => {
            queuedRun = () => Promise.resolve()
                .then(run)
                .then(resolve, reject);
        }),
        onStarted: () => {
            started += 1;
        },
    });

    await new Promise(setImmediate);
    assert.equal(started, 0);

    await queuedRun();
    assert.deepEqual(await responsePromise, { result: 42, error: null });
    assert.equal(started, 1);
});

test('direct methods bypass the account queue but still require a connected account', async () => {
    let submitted = false;
    const registry = new Map([
        ['getCache', definition(() => ({ cached: true }), { execution: 'direct' })],
    ]);
    const options = {
        isAccountReady: () => true,
        submitTask: async () => {
            submitted = true;
        },
    };

    assert.deepEqual(
        await executeWorkerApiCall('getCache', [], registry, options),
        { result: { cached: true }, error: null },
    );
    assert.equal(submitted, false);

    options.isAccountReady = () => false;
    assert.deepEqual(
        await executeWorkerApiCall('getCache', [], registry, options),
        {
            result: null,
            error: { message: '账号未连接', code: undefined, name: 'Error' },
        },
    );
});

test('self-queued methods do not acquire a second account queue slot', async () => {
    let submitted = false;
    const registry = new Map([
        ['scanBatch', definition(async () => ['first', 'second'], { execution: 'self-queued' })],
    ]);

    const response = await executeWorkerApiCall('scanBatch', [], registry, {
        isAccountReady: () => true,
        submitTask: async () => {
            submitted = true;
        },
    });

    assert.deepEqual(response, { result: ['first', 'second'], error: null });
    assert.equal(submitted, false);
});

test('fresh read methods bypass the mutation queue while retaining connection checks', async () => {
    let submitted = false;
    const registry = new Map([
        ['getBag', definition(async () => ({ items: [] }), { execution: 'read-fresh' })],
    ]);

    const response = await executeWorkerApiCall('getBag', [], registry, {
        isAccountReady: () => true,
        submitTask: async () => {
            submitted = true;
        },
    });

    assert.deepEqual(response, { result: { items: [] }, error: null });
    assert.equal(submitted, false);
});

test('offline methods can apply runtime configuration without entering the queue', async () => {
    let submitted = false;
    const registry = new Map([
        ['applyRuntimeConfigSnapshot', definition(([revision]) => ({ appliedRevision: revision }), {
            execution: 'direct',
            allowOffline: true,
        })],
    ]);

    const response = await executeWorkerApiCall('applyRuntimeConfigSnapshot', [7], registry, {
        isAccountReady: () => false,
        submitTask: async () => {
            submitted = true;
        },
    });

    assert.deepEqual(response, { result: { appliedRevision: 7 }, error: null });
    assert.equal(submitted, false);
});
