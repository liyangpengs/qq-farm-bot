const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

function emailHarness(t) {
    const dataRoot = path.resolve(__dirname, '../data');
    fs.mkdirSync(dataRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(dataRoot, 'test-email-'));
    t.after(() => {
        assert.equal(path.dirname(dir), dataRoot);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const clock = { now: Date.parse('2026-11-09T01:59:59Z'), failLists: false, failWrite: false };
    const methods = [];
    const utils = {
        log() {}, toNum: Number,
        getSystemDateKey: () => new Date(clock.now + 8 * 3600000).toISOString().slice(0, 10),
        getSystemClockMinutes: () => {
            const date = new Date(clock.now + 8 * 3600000);
            return date.getUTCHours() * 60 + date.getUTCMinutes();
        },
        getServerTimeSec: () => Math.floor(clock.now / 1000),
    };
    const db = require('../dist/services/json-db');
    const types = {
        GetEmailListRequest: { create: value => value, encode: value => ({ finish: () => value }) },
        GetEmailListReply: { decode: () => ({ emails: [] }) },
    };
    class ClockDate extends Date {
        static now() { return clock.now; }
    }
    function load() {
        const filename = path.resolve(__dirname, '../dist/services/email.js');
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
            module, exports: module.exports, Date: ClockDate,
            require(name) {
                if (name === '../utils/utils') return utils;
                if (name === '../config/runtime-paths') return { getDataFile: name => path.join(dir, name) };
                if (name === '../utils/proto') return { types };
                if (name === './json-db') return {
                    ...db,
                    writeJsonFileAtomic(...args) {
                        if (clock.failWrite) throw new Error('disk full');
                        db.writeJsonFileAtomic(...args);
                    },
                };
                if (name === '../utils/network') return { sendMsgAsync: async (_service, method, body) => {
                    methods.push([method, body.box_type]);
                    if (clock.failLists) throw new Error('list unavailable');
                    return { body: {} };
                } };
                return createRequire(filename)(name);
            },
        }, { filename });
        return module.exports;
    }
    return { load, clock, methods, dir, utils, ClockDate };
}

test('到点前不请求，到点后按账号落盘，重启、改时间和强制调用均不重复', async (t) => {
    const h = emailHarness(t);
    const email = h.load();
    email.configureEmailClaim({ accountId: 'first', hour: 10 });
    assert.equal((await email.checkAndClaimEmails()).skipped, 'waiting');
    assert.equal(h.methods.length, 0);
    h.clock.now += 1000;
    await Promise.all([email.checkAndClaimEmails(), email.checkAndClaimEmails()]);
    assert.deepEqual(h.methods, [['GetEmailList', 1], ['GetEmailList', 2]]);
    assert.equal(email.getEmailDailyState().result, 'none');
    const restarted = h.load();
    restarted.configureEmailClaim({ accountId: 'first', hour: 0 });
    assert.equal((await restarted.checkAndClaimEmails(true)).skipped, 'done');
    restarted.configureEmailClaim({ accountId: 'second', hour: 0 });
    await restarted.checkAndClaimEmails();
    assert.equal(h.methods.length, 4);
    restarted.configureEmailClaim({ accountId: 'first', hour: 10 });
    h.clock.now = Date.parse('2026-11-10T01:59:59Z');
    assert.equal((await restarted.checkAndClaimEmails()).skipped, 'waiting');
    h.clock.now += 1000;
    await restarted.checkAndClaimEmails();
    assert.equal(h.methods.length, 6);
});

test('失败也占用当日名额，进程中断时保存的 running 状态不会重发', async (t) => {
    const h = emailHarness(t);
    h.clock.failLists = true;
    const email = h.load();
    email.configureEmailClaim({ accountId: 'first', hour: 0 });
    assert.equal((await email.checkAndClaimEmails()).error, 'list unavailable');
    const file = path.join(h.dir, fs.readdirSync(h.dir)[0]);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.result = 'running';
    state.lastError = '';
    fs.writeFileSync(file, JSON.stringify(state));
    const restarted = h.load();
    restarted.configureEmailClaim({ accountId: 'first', hour: 0 });
    assert.equal(restarted.getEmailDailyState().result, 'error');
    assert.equal((await restarted.checkAndClaimEmails()).skipped, 'done');
    assert.equal(h.methods.length, 2);
});

test('状态写入失败时不发送邮箱请求', async (t) => {
    const h = emailHarness(t);
    h.clock.failWrite = true;
    const email = h.load();
    email.configureEmailClaim({ accountId: 'first', hour: 0 });
    assert.equal((await email.checkAndClaimEmails()).skipped, 'storage');
    assert.equal(h.methods.length, 0);
});

test('损坏的当日状态必须暴露读取错误，后续调用也不能绕过记录', async (t) => {
    const h = emailHarness(t);
    const email = h.load();
    email.configureEmailClaim({ accountId: 'first', hour: 0 });
    await email.checkAndClaimEmails();
    fs.writeFileSync(path.join(h.dir, fs.readdirSync(h.dir)[0]), '{broken');
    const restarted = h.load();
    assert.throws(() => restarted.configureEmailClaim({ accountId: 'first', hour: 0 }), { code: 'STORAGE_READ_FAILED' });
    await assert.rejects(restarted.checkAndClaimEmails(), { code: 'STORAGE_READ_FAILED' });
    assert.equal(h.methods.length, 2);
});

test('上游 Worker 的登录与跨日强制任务遵守邮箱时刻，同日整点只运行邮箱', async (t) => {
    const h = emailHarness(t);
    const email = h.load();
    const filename = path.resolve(__dirname, '../dist/core/worker.js');
    let tick;
    let otherRoutines = 0;
    const noop = () => {};
    const modules = {
        'node:worker_threads': {},
        '../config/config': { CONFIG: { timeZone: 'Asia/Shanghai' } },
        '../models/store': { getAutomation: () => ({}), applyConfigSnapshot: value => value },
        '../services/email': email,
        '../services/status': { setRecordGoldExpHook: noop },
        '../services/automation-lock': require('../dist/services/automation-lock'),
        '../services/scheduler': { createScheduler: () => ({ clear: noop, setIntervalTask: (_name, ms, fn) => {
            assert.equal(ms, 30000);
            tick = fn;
        } }) },
        '../services/warehouse': { openCharitySettlementGiftPacksSilently: async () => { otherRoutines += 1; } },
        '../services/share': { checkDailyShareStatus: noop },
        '../services/monthcard': { performDailyMonthCardGift: noop },
        '../services/mall': { buyFreeGifts: noop },
        '../services/qqvip': { performDailyVipGift: noop },
        '../utils/utils': { ...h.utils, setLogHook: noop },
    };
    const worker = vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}\n;({
        configure: applyRuntimeConfig,
        start() { loginReady = true; startDailyRoutineTimer(); },
    })`, {
        exports: {}, Date: h.ClockDate,
        process: { env: { FARM_ACCOUNT_ID: 'worker' }, send: noop, on: noop },
        require: name => modules[name] || {},
    }, { filename });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    worker.configure({ emailClaimHour: 10 });
    worker.start();
    await flush();
    assert.equal(h.methods.length, 0, '登录强制日常任务不提前请求邮箱');
    assert.equal(otherRoutines, 1);
    h.clock.now += 1000;
    tick();
    await flush();
    tick();
    await flush();
    assert.equal(h.methods.length, 2);
    assert.equal(otherRoutines, 1, '同日邮箱到点不会重复其他日常任务');
    h.clock.now = Date.parse('2026-11-09T16:00:00Z');
    tick();
    await flush();
    assert.equal(h.methods.length, 2, '跨日强制日常任务也不提前请求邮箱');
    assert.equal(otherRoutines, 2);
    h.clock.now = Date.parse('2026-11-10T02:00:00Z');
    tick();
    await flush();
    assert.equal(h.methods.length, 4);
});
