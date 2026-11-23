const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness() {
    const clock = { now: 1_000_000 };
    const auto = { ranch_illustrated: true, ranch_check_minutes: 30 };
    const quotes = [];
    const writes = [];
    const errors = [];
    const raw = { cells: { facilities: [] }, bag: {} };
    const filename = require.resolve('../dist/services/ranch/automation');
    const realRequire = createRequire(filename);
    const modules = {
        '../../models/store': { getAutomation: () => auto },
        './transport': { isUnlocked: () => true, inScene: fn => fn({}) },
        './state': { loadRaw: async () => raw, snapshot: () => ({ facilities: [], serverTime: clock.now }), inventory: () => [] },
        './actions': {
            prepareAction: async (_action, input) => {
                quotes.push(input.kind);
                if (clock.disableDuringQuote) auto.ranch_illustrated = false;
                return { expected: {}, label: '图鉴', costItems: [] };
            },
            operate: async (_action, input) => {
                // Model the existing persistent action guard: subsequent quotes must not resend.
                if (clock.pending) throw Object.assign(new Error('pending'), { code: 'PENDING_CONFIRMATION' });
                writes.push(input.kind);
                if (clock.unknown) { clock.pending = true; throw Object.assign(new Error('unknown'), { outcomeUnknown: true }); }
                return { status: 'confirmed' };
            },
        },
        './context': { getAmbientSendContext: () => null, runWithSendContext: (_context, fn) => fn() },
        './daily': { markTasksChanged() {} },
        './friends': { getInteractionQuotaResetAt: () => 0 },
        '../../utils/utils': { log: (...args) => errors.push(args), getServerTimeSec: () => clock.now / 1000 },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, process: { env: { FARM_ACCOUNT_ID: '1' } },
        Date: class extends Date { static now() { return clock.now; } },
        require: key => Object.hasOwn(modules, key) ? modules[key] : realRequire(key),
    }, { filename });
    return { clock, auto, quotes, writes, errors, routine: module.exports };
}

test('without any notification, checks both ranch books on startup and every five minutes', async () => {
    const h = harness();
    assert.equal(h.routine.getRoutineState().doneToday, false);
    await h.routine.run();
    assert.deepEqual(h.writes, ['normal', 'giant']);
    assert.equal(h.errors.some(args => args[2]?.result === 'error'), false);
    h.clock.now += 299_999;
    assert.equal(h.routine.getRoutineState().doneToday, true);
    await h.routine.run();
    assert.equal(h.writes.length, 2);
    h.clock.now++;
    assert.equal(h.routine.getRoutineState().doneToday, false);
    await h.routine.run();
    assert.deepEqual(h.writes, ['normal', 'giant', 'normal', 'giant']);
});

test('disabled ranch switch and disabled-during-quote guard prevent writes', async () => {
    const h = harness(); h.auto.ranch_illustrated = false;
    await h.routine.run(); assert.deepEqual(h.quotes, []);
    h.auto.ranch_illustrated = true; h.clock.disableDuringQuote = true;
    await h.routine.run(); assert.deepEqual(h.writes, []);
});

test('unknown result remains guarded on the next periodic check', async () => {
    const h = harness(); h.clock.unknown = true;
    await h.routine.run(); assert.deepEqual(h.writes, ['normal']);
    h.clock.now += 10 * 60_000;
    await h.routine.run(); assert.deepEqual(h.writes, ['normal']);
    assert.equal(h.clock.pending, true);
});

function bookHarness(claimed) {
    const filename = require.resolve('../dist/services/ranch/book');
    const realRequire = createRequire(filename);
    const replies = [];
    const modules = {
        './transport': { rpc: async (route, input) => {
            replies.push(route);
            if (route === 'claimWeight') return { claimed_ids: [input.id], rewards: [{ id: 1002, count: 300 }] };
            if (route === 'weightBook') return { levels: [{ id: 1, claimed }] };
            throw new Error(route);
        } },
        './model': { mutationMap: new Map(), quantity: String, signature: JSON.stringify,
            error: (code, message) => Object.assign(new Error(message), { code }) },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports,
        require: key => Object.hasOwn(modules, key) ? modules[key] : realRequire(key),
    }, { filename });
    return { book: module.exports, replies };
}
const plan = { kind: 'giant', ids: [1], count: 1, levels: [{ id: 1, rewards: [{ id: 1002, count: 300 }] }] };

test('giant claim requires matching rewards and a claimed readback', async () => {
    const h = bookHarness(true);
    assert.equal((await h.book.claimBook(plan)).completed, 1);
    assert.deepEqual(h.replies, ['claimWeight', 'weightBook']);
    await assert.rejects(bookHarness(false).book.claimBook(plan), { code: 'RANCH_RESULT_UNKNOWN' });
});
