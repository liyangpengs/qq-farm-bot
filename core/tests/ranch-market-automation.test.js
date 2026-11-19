const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const ranchConfig = require('../dist/config/ranch-automation');

function load(file, overrides) {
    const filename = path.resolve(__dirname, '../dist', file);
    const realRequire = createRequire(filename);
    const sandbox = { require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
        module: { exports: {} }, exports: {}, process, console, Date, Map, Set, BigInt };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox.module.exports;
}

function configStore() {
    const saved = new Map();
    const shared = load('models/store/shared-state.js', {
        '../../config/runtime-paths': { getDataFile: name => name, ensureDataDir() {} },
        './config-storage': { createConfigStorage: () => ({ saveAccount: (id, value) => saved.set(id, JSON.parse(JSON.stringify(value))) }) },
    });
    const store = load('models/store/account-config.js', { './shared-state': shared, './global-config': {} });
    return { shared, store, saved };
}

test('旧总开关迁移为两个独立开关，明确的新设置优先，默认行为不变', () => {
    const { shared } = configStore();
    for (const legacy of [true, false]) {
        for (const normalize of [shared.normalizeAccountConfig, shared.cloneAccountConfig]) {
            const result = normalize({ automation: { ranch_market_organic: legacy } });
            assert.equal(result.automation.ranch_market_organic_poop, legacy);
            assert.equal(result.automation.ranch_market_organic_pinecone, legacy);
        }
    }
    const result = shared.normalizeAccountConfig({ automation: {
        ranch_market_organic: true, ranch_market_organic_poop: false, ranch_market_organic_pinecone: true,
    } });
    assert.equal(result.automation.ranch_market_organic_poop, false);
    assert.equal(result.automation.ranch_market_organic_pinecone, true);
    assert.equal(shared.normalizeAccountConfig({}).automation.ranch_market_organic_poop, true);
});

test('独立保存、重新加载、账号隔离及旧客户端总开关兼容', () => {
    const { shared, store, saved } = configStore();
    store.applyConfigSnapshot({ automation: { ranch_market_organic_poop: false, ranch_market_organic_pinecone: true } }, { accountId: 'a' });
    store.applyConfigSnapshot({ automation: { ranch_market_organic_poop: true, ranch_market_organic_pinecone: false } }, { accountId: 'b' });
    shared.globalConfig.accountConfigs.a = JSON.parse(JSON.stringify(saved.get('a')));
    shared.globalConfig.accountConfigs.b = JSON.parse(JSON.stringify(saved.get('b')));
    assert.equal(store.getAutomation('a').ranch_market_organic_poop, false);
    assert.equal(store.getAutomation('a').ranch_market_organic_pinecone, true);
    assert.equal(store.getAutomation('b').ranch_market_organic_poop, true);
    assert.equal(store.getAutomation('b').ranch_market_organic_pinecone, false);
    store.applyConfigSnapshot({ automation: { ranch_market_organic_pinecone: false } }, { accountId: 'a' });
    assert.equal(store.getAutomation('a').ranch_market_organic_poop, false);
    assert.equal(store.getAutomation('a').ranch_market_organic_pinecone, false);
    store.applyConfigSnapshot({ automation: { ranch_market_organic: true } }, { accountId: 'a' });
    assert.equal(store.getAutomation('a').ranch_market_organic_poop, true);
    assert.equal(store.getAutomation('a').ranch_market_organic_pinecone, true);
});

function marketHarness(poop, pinecone, options = {}) {
    const auto = { ...ranchConfig.RANCH_AUTOMATION_DEFAULTS };
    for (const key of ranchConfig.RANCH_SWITCH_KEYS) auto[key] = false;
    // 旧字段即使保持开启，也不能重新启用明确关闭的兑换方式。
    Object.assign(auto, { ranch_market_organic: true, ranch_market_organic_poop: poop, ranch_market_organic_pinecone: pinecone });
    const balances = new Map([[7002, 20n], [1008, 20n]]);
    const rewards = [[7002, 80011], [7002, 80012], [1008, 80011], [1008, 80012], [1008, 80013]];
    const goods = rewards.map(([currency, reward], index) => ({ id: index + 1, available: true,
        price: { id: currency, count: '1' }, reward: { id: reward }, remaining: 1 }));
    const rotation = { period_day: 'fixture-day', round_index: 1, shop_start_time: 900, shop_end_time: 2000, present: true };
    const raw = { cells: { facilities: [] }, bag: {} };
    const exchanges = [];
    const automation = load('services/ranch/automation.js', {
        '../../models/store': { getAutomation: () => auto, getFriendBlacklist: () => [] },
        './transport': { isUnlocked: () => true, inScene: work => work({}) },
        './state': {
            loadRaw: async () => raw, snapshot: () => ({ facilities: [] }),
            inventory: () => [], catalog: () => [], readMarketRotation: async () => rotation,
            market: async () => ({ opened: true, present: true, periodDay: 'fixture-day', roundIndex: 1, goods }),
            balance: (_bag, id) => ({ total: String(balances.get(id) || 0n), locked: '0' }),
        },
        './model': { cubMap: new Map(), quantity: String },
        './actions': {
            prepareAction: async (_action, input) => {
                const good = goods.find(row => row.id === input.goodsId);
                options.onQuote?.(auto, good);
                return { label: '模拟兑换', costItems: [good.price], rewards: [good.reward], expected: {} };
            },
            operate: async (_action, input) => {
                const good = goods.find(row => row.id === input.goodsId);
                exchanges.push({ currency: good.price.id, reward: good.reward.id });
                balances.set(good.price.id, balances.get(good.price.id) - BigInt(input.count));
                options.onExchange?.(auto, good);
                return { status: 'confirmed' };
            },
        },
        '../../utils/utils': { getServerTimeSec: () => 1000, log() {} },
        '../../config/gameConfig': { getShopGoodsById: () => null },
        './operation-state': { forCurrentAccount: () => ({ reserved: () => '0' }) },
        './context': { getAmbientSendContext: () => null, runWithSendContext: (_context, work) => work() },
        './daily': {}, './friends': {}, './friend-roster': {},
    });
    return { automation, exchanges, auto };
}

for (const [poop, pinecone] of [[true, false], [false, true], [true, true], [false, false]]) {
    test('实际兑换按货币独立执行：粑粑=' + poop + '，松果=' + pinecone, async () => {
        const h = marketHarness(poop, pinecone);
        assert.equal(h.automation.getRoutineState().doneToday, !(poop || pinecone));
        await h.automation.run();
        assert.deepEqual(h.exchanges.filter(row => row.currency === 7002).map(row => row.reward), poop ? [80012, 80011] : []);
        assert.deepEqual(h.exchanges.filter(row => row.currency === 1008).map(row => row.reward), pinecone ? [80013, 80012, 80011] : []);
        // 没有新到访和货币到账时，两项独立开关不会引发空转巡查。
        assert.equal(h.automation.getRoutineState().doneToday, true);
    });
}

test('报价期间关闭粑粑兑换，发送前再次检查，不影响松果兑换', async () => {
    const h = marketHarness(true, true, { onQuote(auto, good) {
        if (good.price.id === 7002) auto.ranch_market_organic_poop = false;
    } });
    await h.automation.run();
    assert.equal(h.exchanges.some(row => row.currency === 7002), false);
    assert.equal(h.exchanges.filter(row => row.currency === 1008).length, 3);
});

test('任一货币开启均能接收到访事件并唤醒，关闭另一项不影响', async () => {
    const h = marketHarness(false, true);
    await h.automation.run();
    assert.equal(h.automation.getRoutineState().doneToday, true);
    assert.equal(h.automation.noteMarketVisit({ period_day: 'fixture-day', round_index: 2, shop_start_time: 900, shop_end_time: 2000, present: true }), true);
    assert.equal(h.automation.getRoutineState().doneToday, false);
});
