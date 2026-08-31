const assert = require('node:assert/strict');
const test = require('node:test');

test('a failed farm read preserves the boolean API', async (t) => {
    const store = require('../dist/models/store');
    const network = require('../dist/utils/network');
    const farmApi = require('../dist/services/farm/api');
    const visitStrategy = require('../dist/services/friend/visit-strategy');
    const schedulerModulePath = require.resolve('../dist/services/farm/scheduler');
    const originals = {
        isAutomationOn: store.isAutomationOn,
        getUserState: network.getUserState,
        getAllLands: farmApi.getAllLands,
        inFarmQuietHours: visitStrategy.inFarmQuietHours,
    };
    t.after(() => {
        store.isAutomationOn = originals.isAutomationOn;
        network.getUserState = originals.getUserState;
        farmApi.getAllLands = originals.getAllLands;
        visitStrategy.inFarmQuietHours = originals.inFarmQuietHours;
        delete require.cache[schedulerModulePath];
    });

    store.isAutomationOn = key => key === 'farm';
    network.getUserState = () => ({ gid: 99, accountId: 'account-1' });
    farmApi.getAllLands = async () => {
        throw new Error('get lands failed');
    };
    visitStrategy.inFarmQuietHours = () => false;

    delete require.cache[schedulerModulePath];
    const { checkFarm } = require(schedulerModulePath);
    assert.equal(await checkFarm(), false);
});

function emptyFarmStatus(overrides = {}) {
    return {
        harvestable: [],
        needWeed: [],
        needBug: [],
        needWater: [],
        needInteractionCleanup: [],
        dead: [],
        empty: [],
        unlockable: [],
        upgradable: [],
        growing: [1],
        ...overrides,
    };
}

async function runSmartSnapshotCase(t, status) {
    const store = require('../dist/models/store');
    const network = require('../dist/utils/network');
    const farmApi = require('../dist/services/farm/api');
    const landAnalysis = require('../dist/services/farm/land-analysis');
    const fertilizer = require('../dist/services/farm/fertilizer');
    const visitStrategy = require('../dist/services/friend/visit-strategy');
    const schedulerModulePath = require.resolve('../dist/services/farm/scheduler');
    const originals = {
        isAutomationOn: store.isAutomationOn,
        getAutomation: store.getAutomation,
        getUserState: network.getUserState,
        getAllLands: farmApi.getAllLands,
        farming: farmApi.farming,
        analyzeLands: landAnalysis.analyzeLands,
        getCleanableFarmSocialEventItemIds: landAnalysis.getCleanableFarmSocialEventItemIds,
        runFertilizerByConfig: fertilizer.runFertilizerByConfig,
        inFarmQuietHours: visitStrategy.inFarmQuietHours,
    };
    t.after(() => {
        store.isAutomationOn = originals.isAutomationOn;
        store.getAutomation = originals.getAutomation;
        network.getUserState = originals.getUserState;
        farmApi.getAllLands = originals.getAllLands;
        farmApi.farming = originals.farming;
        landAnalysis.analyzeLands = originals.analyzeLands;
        landAnalysis.getCleanableFarmSocialEventItemIds = originals.getCleanableFarmSocialEventItemIds;
        fertilizer.runFertilizerByConfig = originals.runFertilizerByConfig;
        visitStrategy.inFarmQuietHours = originals.inFarmQuietHours;
        delete require.cache[schedulerModulePath];
    });

    const landsReply = { lands: [{ id: 1, level: 1 }] };
    let landsReads = 0;
    let fertilizerOptions = null;
    store.isAutomationOn = key => key === 'farm';
    store.getAutomation = () => ({ fertilizer: 'smart' });
    network.getUserState = () => ({ gid: 99, accountId: 'account-1' });
    farmApi.getAllLands = async () => {
        landsReads += 1;
        return landsReply;
    };
    farmApi.farming = async () => ({});
    landAnalysis.analyzeLands = () => emptyFarmStatus(status);
    landAnalysis.getCleanableFarmSocialEventItemIds = () => [];
    fertilizer.runFertilizerByConfig = async (_landIds, options) => {
        fertilizerOptions = options;
        return { normal: 0, organic: 0 };
    };
    visitStrategy.inFarmQuietHours = () => false;

    delete require.cache[schedulerModulePath];
    const { checkFarm } = require(schedulerModulePath);
    await checkFarm();
    return { fertilizerOptions, landsReads, landsReply };
}

test('smart farm checks pass the initial fresh lands to fertilizer when no write occurred', async (t) => {
    const result = await runSmartSnapshotCase(t, {});

    assert.equal(result.landsReads, 1);
    assert.equal(result.fertilizerOptions.landsSnapshot, result.landsReply);
});

test('smart farm checks require a fresh fertilizer read after a land write', async (t) => {
    const result = await runSmartSnapshotCase(t, { needWater: [1] });

    assert.equal(result.landsReads, 1);
    assert.equal(result.fertilizerOptions.landsSnapshot, undefined);
});
