const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkerApiRegistry } = require('../dist/app/worker-api-registry');

function createRegistry() {
    return createWorkerApiRegistry({
        applyRuntimeConfigSnapshot: () => null,
        setAutomation: () => null,
        getDailyGiftOverview: async () => null,
        getSchedulers: () => null,
    });
}

test('worker API registry preserves the existing IPC method surface', () => {
    const registry = createRegistry();
    const expectedMethods = [
        'advanceWeatherResearch',
        'applyRuntimeConfigSnapshot',
        'buyFertilizer',
        'buyWeatherBottle',
        'checkAndBuyFertilizer',
        'claimBattlePassRewards',
        'claimDogSkillGifts',
        'claimQingMeiDailySeed',
        'claimQixiBridgeRewards',
        'claimSolarTerm',
        'clearFriendsCache',
        'collectWeatherBottle',
        'continueQingMeiBrew',
        'delFriend',
        'deployDog',
        'doFarmOp',
        'doFriendOp',
        'exchangeStarSandGoods',
        'exchangeWeatherCollectorBottle',
        'fertilizeOwnLand',
        'getActivityCenterSnapshot',
        'getActivityDirectorySnapshot',
        'getAnalytics',
        'getBag',
        'getBagSeeds',
        'getCurrentQingMeiActivity',
        'getCurrentQixiActivity',
        'getCurrentSeasonEvent',
        'getCurrentSolarTerms',
        'getCurrentStarSandShop',
        'getCurrentStellarActivity',
        'getCurrentWeatherActivity',
        'getDailyGiftOverview',
        'getDiamondBalance',
        'getDogSkillGiftStatus',
        'getFriendInteractionItems',
        'getFriendLands',
        'getFriends',
        'getFriendsCache',
        'getIllustratedSnapshot',
        'getInteractRecords',
        'getLands',
        'getMallCatalog',
        'getMysteryShop',
        'getPetInfo',
        'getPetProtectLogs',
        'getSchedulers',
        'getSeeds',
        'getSelfInteractionItems',
        'getWeatherFriends',
        'giftQixiSachet',
        'lightConstellation',
        'lightWeatherResearch',
        'purchaseMallProduct',
        'purchaseMysteryOffer',
        'scanWeatherFriends',
        'sellItems',
        'setAutomation',
        'setItemsLocked',
        'settleQingMeiBrew',
        'startQingMeiBrew',
        'summonWeatherRain',
        'useDogFood',
        'useFriendFarmInteractionItem',
        'useFriendInteractionItemBatch',
        'useItem',
        'useSelfInteractionItemBatch',
        'useWeatherCloudBottle',
        'useWeatherCollectorBottle',
        'useWeatherFrogBottle',
        'useWeatherSummonBottle',
        'withdrawDog',
    ];

    assert.deepEqual([...registry.keys()].sort(), expectedMethods);
});

test('only explicit local operations bypass account serialization', () => {
    const registry = createRegistry();
    const direct = [...registry]
        .filter(([, entry]) => entry.execution === 'direct')
        .map(([method]) => method)
        .sort();

    assert.deepEqual(direct, [
        'applyRuntimeConfigSnapshot',
        'getAnalytics',
        'getFriendsCache',
        'getSchedulers',
    ]);
    const selfQueued = [...registry]
        .filter(([, entry]) => entry.execution === 'self-queued')
        .map(([method]) => method)
        .sort();

    assert.deepEqual(selfQueued, [
        'getFriends',
        'getWeatherFriends',
        'scanWeatherFriends',
    ]);
    const freshReads = [...registry]
        .filter(([, entry]) => entry.execution === 'read-fresh')
        .map(([method]) => method)
        .sort();

    assert.deepEqual(freshReads, [
        'getBag',
        'getSeeds',
    ]);
    assert.equal(registry.get('getFriendLands').execution, 'queued');
    assert.equal(registry.get('getCurrentWeatherActivity').execution, 'queued');
});
