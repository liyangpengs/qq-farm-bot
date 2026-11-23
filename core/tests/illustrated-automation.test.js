const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

function harness(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'illustrated-auto-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const clock = { now: 1000, enabled: true, fail: 0, refreshFailure: false, diskFull: false };
    const env = { FARM_ACCOUNT_ID: 'first' };
    const accounts = new Map();
    const calls = [];
    const logs = [];
    function books() {
        if (!accounts.has(env.FARM_ACCOUNT_ID)) accounts.set(env.FARM_ACCOUNT_ID, {
            1: [{ level: 29, can_claim: true, claimed: false }],
            2: [{ level: 12, can_claim: true, claimed: false }],
        });
        return accounts.get(env.FARM_ACCOUNT_ID);
    }
    const service = {
        getIllustratedLevels: async type => ({ level_list: books()[type] }),
        claimIllustratedRewards: async (type, options) => {
            if (!options.canContinue()) return null;
            const available = books()[type].filter(level => level.can_claim && !level.claimed);
            if (!available.length) return null;
            options.beforeSend(available.map(level => level.level));
            calls.push([env.FARM_ACCOUNT_ID, type]);
            if (clock.fail === type) throw new Error('reply timeout');
            for (const level of available) { level.claimed = true; level.can_claim = false; }
            const dto = type => ({ levels: books()[type].map(level => ({ level: level.level, claimed: level.claimed })) });
            return { claimedLevels: available.map(level => level.level), rewards: [{ itemId: 1002, count: 200 }],
                snapshot: clock.refreshFailure ? null : { crop: dto(1), mutant: dto(2) } };
        },
    };
    function load() {
        const filename = require.resolve('../dist/services/illustrated-automation');
        const localRequire = createRequire(filename);
        const module = { exports: {} };
        const overrides = {
            '../config/runtime-paths': { getDataDir: () => dir },
            '../models/store': { getAutomation: () => ({ farm_illustrated: clock.enabled }) },
            './illustrated': service,
            './json-db': { writeJsonFileAtomic(file, value) {
                if (clock.diskFull) throw new Error('disk full');
                localRequire('./json-db').writeJsonFileAtomic(file, value);
            } },
            '../utils/utils': { log: (...args) => logs.push(args), logWarn: (...args) => logs.push(args) },
        };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
            module, exports: module.exports, process: { env },
            Date: class extends Date { static now() { return clock.now; } },
            require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
        }, { filename });
        return module.exports;
    }
    return { clock, env, books, calls, logs, load, dir };
}

test('disabled automation performs no reads or writes; enabled runs both books once and throttles concurrent checks', async (t) => {
    const h = harness(t);
    const auto = h.load();
    h.clock.enabled = false;
    assert.equal(auto.isDue(), false);
    await auto.run();
    assert.equal(h.calls.length, 0);
    assert.deepEqual(fs.readdirSync(h.dir), []);
    h.clock.enabled = true;
    await Promise.all([auto.run(), auto.run(), auto.run()]);
    assert.deepEqual(h.calls, [['first', 1], ['first', 2]]);
    assert.equal(auto.isDue(), false);
    h.clock.now += 300_000;
    assert.equal(auto.isDue(), true);
    await auto.run();
    assert.equal(h.calls.length, 2, 'claimed levels cannot generate another write');
});

test('unknown results survive restart and only fresh claimed levels release the protection', async (t) => {
    const h = harness(t);
    h.clock.fail = 1;
    await h.load().run();
    assert.deepEqual(h.calls, [['first', 1], ['first', 2]]);
    h.clock.fail = 0;
    await h.load().run();
    assert.equal(h.calls.length, 2, 'restart must not replay a timeout');
    h.books()[1][0].claimed = true;
    h.books()[1][0].can_claim = false;
    await h.load().run();
    assert.equal(h.calls.length, 2);
    assert.ok(h.logs.some(row => row[2]?.result === 'reconciled'));
});

test('claim response with failed readback stays pending until a later read confirms it', async (t) => {
    const h = harness(t);
    h.clock.refreshFailure = true;
    await h.load().run();
    assert.equal(h.calls.length, 2);
    h.clock.refreshFailure = false;
    await h.load().run();
    assert.equal(h.calls.length, 2);
    assert.equal(h.logs.filter(row => row[2]?.result === 'reconciled').length, 2);
});

test('pending protection is isolated by account and disabling a queued run prevents claims', async (t) => {
    const h = harness(t);
    h.clock.fail = 1;
    const auto = h.load();
    await auto.run();
    h.clock.fail = 0;
    h.env.FARM_ACCOUNT_ID = 'second';
    await auto.run();
    assert.deepEqual(h.calls, [['first', 1], ['first', 2], ['second', 1], ['second', 2]]);
    h.env.FARM_ACCOUNT_ID = 'third';
    await auto.run({ canContinue: () => false });
    assert.equal(h.calls.length, 4);
});

test('failure to persist pending prevents the request, and corrupt records fail closed', async (t) => {
    const h = harness(t);
    h.clock.diskFull = true;
    await h.load().run();
    assert.equal(h.calls.length, 0);
    h.clock.diskFull = false;
    h.clock.fail = 1;
    await h.load().run();
    const file = path.join(h.dir, 'illustrated-automation', fs.readdirSync(path.join(h.dir, 'illustrated-automation'))[0]);
    fs.writeFileSync(file, JSON.stringify({ 1: { levels: [], createdAt: 1 } }));
    const before = h.calls.length;
    await assert.rejects(h.load().run(), /待核对记录格式错误/);
    assert.equal(h.calls.length, before);
});

test('farm and ranch switches remain independent across account normalization and updates', () => {
    const { DEFAULT_ACCOUNT_CONFIG, globalConfig, normalizeAccountConfig } = require('../dist/models/store/shared-state');
    const { applyConfigSnapshot, getAccountConfigSnapshot } = require('../dist/models/store/account-config');
    const first = '__illustrated_first__';
    const second = '__illustrated_second__';
    try {
        assert.equal(DEFAULT_ACCOUNT_CONFIG.automation.farm_illustrated, true);
        assert.equal(normalizeAccountConfig({}).automation.farm_illustrated, true);
        applyConfigSnapshot({ automation: { farm_illustrated: false, ranch_illustrated: true } }, { accountId: first, persist: false });
        applyConfigSnapshot({ automation: { farm_illustrated: true, ranch_illustrated: false } }, { accountId: second, persist: false });
        const a = getAccountConfigSnapshot(first).automation;
        const b = getAccountConfigSnapshot(second).automation;
        assert.deepEqual([a.farm_illustrated, a.ranch_illustrated], [false, true]);
        assert.deepEqual([b.farm_illustrated, b.ranch_illustrated], [true, false]);
    } finally {
        delete globalConfig.accountConfigs[first];
        delete globalConfig.accountConfigs[second];
    }
});

test('the online worker schedules due claims once and invalidates a disconnected session', async () => {
    const filename = require.resolve('../dist/core/worker');
    const localRequire = createRequire(filename);
    let tick;
    let due = false;
    let runs = 0;
    let release;
    let allowed;
    const noop = () => {};
    const modules = {
        'node:worker_threads': {},
        '../config/config': { CONFIG: {} },
        '../models/store': { getAutomation: () => ({ farm_illustrated: due }) },
        '../services/status': { setRecordGoldExpHook: noop },
        '../services/email': { getEmailDailyState: () => ({ doneToday: true }) },
        '../services/automation-lock': localRequire('../services/automation-lock'),
        '../services/illustrated-automation': {
            isDue: () => due,
            run: async (options) => { runs++; allowed = options.canContinue; await new Promise(resolve => { release = resolve; }); },
        },
        '../services/scheduler': { createScheduler: () => ({ clear: noop, setIntervalTask: (_name, ms, fn) => {
            assert.equal(ms, 30000);
            tick = fn;
        } }) },
        '../utils/network': { getGatewayLoad: () => ({}) },
        '../utils/low-priority-gate': { isGatewayIdleForLowPriority: () => true },
        '../utils/request-context': { runWithRequestClass: (_kind, work) => work() },
        '../utils/utils': { setLogHook: noop, getSystemDateKey: () => '2026-11-23', logWarn: noop },
    };
    const worker = vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}\n;({
        start() { loginReady = true; startDailyRoutineTimer(false); },
        disconnect() { loginReady = false; runtimeGeneration++; },
    })`, {
        exports: {}, process: { env: { FARM_ACCOUNT_ID: 'worker-test' }, send: noop, on: noop },
        require: name => modules[name] || {},
    }, { filename });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    worker.start();
    tick();
    await flush();
    assert.equal(runs, 0);
    due = true;
    tick(); tick(); tick();
    await flush();
    assert.equal(runs, 1);
    assert.equal(allowed(), true);
    worker.disconnect();
    assert.equal(allowed(), false);
    release();
    await flush();
    tick();
    await flush();
    assert.equal(runs, 1, 'offline ticks must not start another check');
});
