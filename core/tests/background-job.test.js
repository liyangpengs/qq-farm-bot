const assert = require('node:assert/strict');
const test = require('node:test');

const { BackgroundJob } = require('../dist/app/background-job');

test('background job starts without waiting and prevents overlapping runs', async () => {
    const events = [];
    let finish;
    const pending = new Promise(resolve => {
        finish = resolve;
    });
    const job = new BackgroundJob();

    assert.equal(job.start(async () => {
        events.push('started');
        await pending;
        events.push('finished');
        return 42;
    }, {
        onSuccess: value => events.push(`success:${value}`),
        onSettled: () => events.push('settled'),
    }), true);
    assert.equal(job.isRunning(), true);
    assert.equal(job.start(async () => events.push('overlap')), false);

    await new Promise(setImmediate);
    assert.deepEqual(events, ['started']);

    finish();
    await job.wait();
    assert.equal(job.isRunning(), false);
    assert.deepEqual(events, ['started', 'finished', 'success:42', 'settled']);
});

test('background job reports errors and can be started again', async () => {
    const errors = [];
    const job = new BackgroundJob();

    assert.equal(job.start(async () => {
        throw new Error('failed');
    }, {
        onError: error => errors.push(error.message),
    }), true);
    await job.wait();

    assert.deepEqual(errors, ['failed']);
    assert.equal(job.start(async () => 'recovered'), true);
    await job.wait();
});

test('background job aborts the active run cooperatively', async () => {
    let signal;
    let outcome;
    let release;
    let started;
    const pending = new Promise(resolve => {
        release = resolve;
    });
    const active = new Promise(resolve => {
        started = resolve;
    });
    const job = new BackgroundJob();

    assert.equal(job.start(async (activeSignal) => {
        signal = activeSignal;
        started();
        await pending;
    }, {
        onSettled: value => {
            outcome = value;
        },
    }), true);

    await active;
    assert.equal(signal.aborted, false);
    job.abort();
    assert.equal(signal.aborted, true);

    release();
    await job.wait();
    assert.equal(job.isRunning(), false);
    assert.equal(outcome, 'cancelled');
});

test('a job aborted mid-flight reports cancelled instead of an error', async () => {
    const job = new BackgroundJob();
    const errors = [];
    let outcome = null;
    let started;
    const active = new Promise(resolve => {
        started = resolve;
    });

    job.start(async () => {
        started();
        await new Promise(resolve => setImmediate(resolve));
        throw new Error('账号任务已停止');
    }, {
        onError: error => errors.push(error.message),
        onSettled: value => {
            outcome = value;
        },
    });

    await active;
    job.abort();
    await job.wait();

    assert.deepEqual(errors, []);
    assert.equal(outcome, 'cancelled');
});
