const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createWorkerManager } = require('../dist/runtime/worker-manager');

class FakeWorker extends EventEmitter {
    constructor() {
        super();
        this.exitCode = null;
        this.signalCode = null;
        this.killCalls = 0;
        this.sent = [];
    }

    send(message) {
        this.sent.push(message);
    }

    kill() {
        this.killCalls += 1;
    }

    exit() {
        if (this.exitCode !== null) return;
        this.exitCode = 0;
        this.emit('exit', 0, null);
    }
}

function createHarness(overrides = {}) {
    const workers = {};
    const processes = [];
    const manager = createWorkerManager({
        fork() {
            const process = new FakeWorker();
            processes.push(process);
            return process;
        },
        WorkerThread: null,
        runtimeMode: 'fork',
        processRef: { env: {} },
        mainEntryPath: 'client.js',
        workerScriptPath: 'worker.js',
        workers,
        globalLogs: [],
        log() {},
        addAccountLog() {},
        normalizeStatusForPanel(value) { return value; },
        buildConfigSnapshotForAccount() { return {}; },
        getOfflineAutoDeleteMs() { return 0; },
        triggerOfflineReminder() {},
        addOrUpdateAccount() {},
        deleteAccount() {},
        ...overrides,
    });
    return { manager, processes, workers };
}

test('api execution timeout starts after the worker begins the queued call', async () => {
    const { manager, processes } = createHarness({ defaultApiCallTimeoutMs: 20 });
    const account = { id: 'account-a', name: 'A', platform: 'qq', code: 'code' };
    assert.equal(manager.startWorker(account), true);
    const worker = processes[0];
    let outcome = 'pending';

    manager.callWorkerApi(account.id, 'getLands').then(
        () => { outcome = 'resolved'; },
        error => { outcome = error.message; },
    );

    try {
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(outcome, 'pending');

        const call = worker.sent.find(message => message.type === 'api_call');
        worker.emit('message', { type: 'api_call_started', id: call.id });
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(outcome, 'API Timeout');
    } finally {
        worker.exit();
    }
});

test('a worker can release a failed shared invite claim for another account', (t) => {
    const { sharedInviteBatch } = require('../dist/app/shared-invite-batch');
    const originalClaim = sharedInviteBatch.claim;
    const originalComplete = sharedInviteBatch.complete;
    const originalRelease = sharedInviteBatch.release;
    const calls = [];
    sharedInviteBatch.claim = () => ({
        claimId: 7,
        invites: [{ uid: '11', openid: 'openid', shareSource: '', docId: '' }],
    });
    sharedInviteBatch.complete = () => {
        calls.push('complete');
        return true;
    };
    sharedInviteBatch.release = (accountId, claimId) => {
        calls.push(['release', accountId, claimId]);
        return true;
    };
    t.after(() => {
        sharedInviteBatch.claim = originalClaim;
        sharedInviteBatch.complete = originalComplete;
        sharedInviteBatch.release = originalRelease;
    });

    const { manager, processes, workers } = createHarness();
    const account = { id: 'account-a', name: 'A', platform: 'wx', code: 'code' };
    assert.equal(manager.startWorker(account), true);
    const worker = processes[0];

    worker.emit('message', { type: 'invite_batch_release', claimId: 7 });

    assert.deepEqual(calls, [['release', 'account-a', 7]]);
    assert.equal(workers[account.id].inviteBatchClaim, null);
    worker.exit();
});

test('restart does not replace an account worker until the old worker exits', async () => {
    const { manager, processes, workers } = createHarness();
    const account = { id: 'account-a', name: 'A', platform: 'qq', code: 'code' };

    assert.equal(manager.startWorker(account), true);
    const oldWorker = processes[0];
    manager.restartWorker(account);

    await new Promise(resolve => setTimeout(resolve, 1100));

    assert.equal(oldWorker.killCalls, 1);
    assert.equal(processes.length, 1);
    assert.equal(workers[account.id].process, oldWorker);

    oldWorker.exit();
    await new Promise(setImmediate);

    assert.equal(processes.length, 2);
    assert.notEqual(workers[account.id].process, oldWorker);
    processes[1].exit();
});

test('known friend GID messages merge worker changes into current main-process state', (t) => {
    const store = require('../dist/models/store');
    const originalGet = store.getKnownFriendGids;
    const originalSet = store.setKnownFriendGids;
    let gids = [11, 22, 44];
    let writes = 0;
    store.getKnownFriendGids = () => [...gids];
    store.setKnownFriendGids = (_accountId, next) => {
        writes += 1;
        gids = [...next];
        return [...gids];
    };
    t.after(() => {
        store.getKnownFriendGids = originalGet;
        store.setKnownFriendGids = originalSet;
    });

    const { manager, processes } = createHarness();
    const account = { id: 'account-a', name: 'A', platform: 'qq', code: 'code' };
    assert.equal(manager.startWorker(account), true);
    const worker = processes[0];

    worker.emit('message', {
        type: 'known_friend_gids_sync',
        revision: 1,
        baseGids: [11, 22],
        gids: [22, 33],
    });

    assert.deepEqual(gids, [22, 44, 33]);
    assert.equal(writes, 1);
    assert.deepEqual(worker.sent.at(-1), {
        type: 'known_friend_gids_ack',
        revision: 1,
        gids: [22, 44, 33],
    });

    gids.push(55);
    worker.emit('message', {
        type: 'known_friend_gids_sync',
        revision: 1,
        baseGids: [11, 22],
        gids: [22, 33],
    });

    assert.equal(writes, 1);
    assert.deepEqual(worker.sent.at(-1), {
        type: 'known_friend_gids_ack',
        revision: 1,
        gids: [22, 44, 33, 55],
    });
    worker.exit();
});
