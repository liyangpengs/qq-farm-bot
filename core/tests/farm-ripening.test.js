const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

const { PlantPhase } = require('../dist/config/config');
const { getServerTimeSec } = require('../dist/utils/utils');
const { DEFAULT_ACCOUNT_CONFIG, globalConfig, normalizeAccountConfig } = require('../dist/models/store/shared-state');
const { applyConfigSnapshot, ensureAccountConfig, getAccountConfigSnapshot } = require('../dist/models/store/account-config');

function load(relativePath, overrides) {
    const filepath = require.resolve(relativePath);
    const localRequire = createRequire(filepath);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filepath, 'utf8'), {
        exports: module.exports, module, require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
    });
    return module.exports;
}

function growingLand(id, time, options = {}) {
    const now = getServerTimeSec();
    return {
        id, unlocked: true, level: options.level ?? 1, master_land_id: options.masterId ?? 0,
        plant: { id: 2020002, left_inorc_fert_times: options.remaining ?? 1, phases: [
            { phase: PlantPhase.GERMINATION, begin_time: now - 100 },
            { phase: PlantPhase.MATURE, begin_time: now + time },
        ] },
    };
}

test('new accounts default to no fertilizer and existing strategies round-trip unchanged', () => {
    const accountId = '__farm_ripening_test__';
    try {
        assert.equal(DEFAULT_ACCOUNT_CONFIG.automation.fertilizer, 'none');
        assert.equal(ensureAccountConfig(accountId, { persist: false }).automation.fertilizer, 'none');
        for (const mode of ['smart', 'both', 'normal', 'organic', 'none', 'normal_ripen', 'organic_ripen']) {
            const automation = { fertilizer: mode, fertilizer_smart_seconds: 450 };
            assert.equal(normalizeAccountConfig({ automation }).automation.fertilizer, mode);
            applyConfigSnapshot({ automation }, { accountId, persist: false });
            const saved = getAccountConfigSnapshot(accountId).automation;
            assert.equal(saved.fertilizer, mode);
            assert.equal(saved.fertilizer_smart_seconds, 450);
        }
        applyConfigSnapshot({ automation: { fertilizer: 'invalid' } }, { accountId, persist: false });
        assert.equal(getAccountConfigSnapshot(accountId).automation.fertilizer, 'organic_ripen');
    } finally {
        delete globalConfig.accountConfigs[accountId];
    }
});

test('ripening selects only configured land types and sends one batch of the chosen fertilizer', async () => {
    const calls = [];
    const { runRipeningFertilizer } = load('../dist/services/farm/ripening', {
        './api': {
            getAllLands: async () => assert.fail('reuse supplied snapshot'),
            fertilizeBatch: async (ids, fertilizer) => {
                calls.push([fertilizer, ...ids]);
                return { land: [{ id: ids[0] }, { id: 99 }] };
            },
            fertilizeOrganicLoop: async ids => { calls.push(['legacy', ...ids]); return ids.length; },
        },
        '../stats': { recordOperation() {} },
        '../../utils/utils': { toNum: value => Number(value) || 0, log() {} },
    });
    const lands = [
        growingLand(1, 120), growingLand(2, 240, { remaining: 0 }), growingLand(3, 600),
        growingLand(4, 120, { level: 4 }), growingLand(5, 120, { masterId: 1 }),
    ];
    const config = { fertilizer_land_types: ['normal'], fertilizer_smart_seconds: 300 };
    assert.equal(await runRipeningFertilizer({ ...config, fertilizer: 'none' }, lands), 0);
    assert.equal(await runRipeningFertilizer({ ...config, fertilizer: 'normal_ripen' }, lands), 1);
    assert.equal(await runRipeningFertilizer({ ...config, fertilizer: 'organic_ripen' }, lands), 1);
    assert.equal(await runRipeningFertilizer({ ...config, fertilizer: 'smart' }, lands), 2);
    assert.equal(await runRipeningFertilizer({ ...config, fertilizer: 'organic_ripen', fertilizer_land_types: [] }, lands), 0);
    assert.deepEqual(calls, [[1011, 1], [1012, 1, 2], ['legacy', 1, 2]]);
});

test('ripening-only modes do not spend fertilizer in sowing or multi-season top-up', async () => {
    for (const fertilizer of ['normal_ripen', 'organic_ripen']) {
        const { runFertilizerByConfig } = load('../dist/services/farm/planting', {
            '../../models/store': { getAutomation: () => ({ fertilizer }) },
            './api': {
                getAllLands: async () => assert.fail('ripening-only mode must not read at sowing'),
                fertilize: async () => assert.fail('ripening-only mode must not fertilize at sowing'),
                fertilizeOrganicLoop: async () => assert.fail('ripening-only mode must not fertilize at sowing'),
            },
        });
        for (const reason of ['normal', 'multi_season']) {
            const result = await runFertilizerByConfig([1], { reason });
            assert.equal(result.normal + result.organic, 0);
        }
    }
});

test('patrol reuses its land read and rechecks once for harvest only after successful ripening', async () => {
    for (const successful of [false, true]) {
        const calls = [];
        const land = growingLand(1, 120);
        const status = { harvestable: [], needWeed: [], needBug: [], needWater: [], needInteractionCleanup: [],
            dead: [], empty: [], unlockable: [], upgradable: [], growing: [1] };
        const { runFarmOperation } = load('../dist/services/farm/scheduler', {
            '../../models/store': { getAutomation: () => ({ fertilizer: 'normal_ripen' }), isAutomationOn: () => false },
            '../../utils/network': { getUserState: () => ({ gid: 1 }), networkEvents: { emit() {} } },
            '../../utils/utils': { toNum: Number, log() {}, logWarn() {} },
            '../stats': { recordOperation() {} },
            './api': {
                getAllLands: async () => { calls.push('read'); return { lands: [land] }; },
                harvest: async ids => { calls.push(`harvest:${ids.join(',')}`); return {}; },
            },
            './land-analysis': {
                analyzeLands: () => calls.includes('ripen') ? { ...status, harvestable: [1] } : status,
                getCleanableFarmSocialEventItemIds: () => [], resolveRemovableHarvestedLands: async () => ({ growing: [] }),
            },
            './ripening': {
                isRipeningOnlyMode: mode => mode === 'normal_ripen',
                runRipeningFertilizer: async (config, lands) => {
                    assert.equal(config.fertilizer, 'normal_ripen');
                    assert.equal(lands[0], land);
                    calls.push('ripen');
                    return Number(successful);
                },
            },
        });
        assert.equal((await runFarmOperation('all', null, true)).hadWork, successful);
        assert.deepEqual(calls, successful ? ['read', 'ripen', 'read', 'harvest:1'] : ['read', 'ripen']);
    }
});
