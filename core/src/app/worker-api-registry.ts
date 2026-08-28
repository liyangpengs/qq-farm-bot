export {};

type WorkerApiExecution = 'queued' | 'direct' | 'self-queued' | 'read-fresh';
type WorkerApiHandler = (args: any[]) => Promise<any> | any;

interface WorkerApiDefinition {
    execution: WorkerApiExecution;
    allowOffline: boolean;
    handle: WorkerApiHandler;
}

interface WorkerApiContext {
    applyRuntimeConfigSnapshot: (snapshot: any) => any;
    setAutomation: (payload: any) => any;
    getDailyGiftOverview: () => Promise<any>;
    getSchedulers: () => any;
}

function createWorkerApiRegistry(context: WorkerApiContext): Map<string, WorkerApiDefinition> {
    const farm = require('../services/farm');
    const friend = require('../services/friend');
    const interact = require('../services/interact');
    const friendItems = require('../services/friend-interaction-items');
    const warehouse = require('../services/warehouse');
    const dogGifts = require('../services/dog-skill-gifts');
    const pets = require('../services/pets');
    const mall = require('../services/mall');
    const analytics = require('../services/analytics');
    const illustrated = require('../services/illustrated');
    const activity = require('../services/activity-center');
    const commerce = require('../services/commerce');
    const pay = require('../services/pay');

    const registry = new Map<string, WorkerApiDefinition>();
    const register = (
        name: string,
        handle: WorkerApiHandler,
        options: { execution?: WorkerApiExecution; allowOffline?: boolean } = {},
    ): void => {
        registry.set(name, {
            execution: options.execution || 'queued',
            allowOffline: options.allowOffline === true,
            handle,
        });
    };

    register('applyRuntimeConfigSnapshot', ([snapshot]) => context.applyRuntimeConfigSnapshot(snapshot || {}), {
        execution: 'direct',
        allowOffline: true,
    });
    register('setAutomation', ([payload]) => context.setAutomation(payload || {}));

    register('getLands', () => farm.getLandsDetail());
    register('getIllustratedSnapshot', () => illustrated.getIllustratedSnapshot());
    register('getFriends', ([forceSync]) => friend.getFriendsList(forceSync === true), {
        execution: 'self-queued',
    });
    register('getFriendsCache', () => friend.getFriendsListCacheOnly(), { execution: 'direct' });
    register('clearFriendsCache', () => {
        friend.clearFriendsListCache();
        return { ok: true };
    });
    register('getInteractRecords', () => interact.getInteractRecords());
    register('getFriendLands', ([gid]) => friend.getFriendLandsDetail(gid));
    register('getFriendInteractionItems', () => friendItems.getFriendInteractionItems());
    register('useFriendInteractionItemBatch', ([gid, itemId, landIds]) => friendItems.useFriendInteractionItemBatch(gid, itemId, landIds));
    register('useFriendFarmInteractionItem', ([gid, itemId]) => friendItems.useFriendFarmInteractionItem(gid, itemId));
    register('getSelfInteractionItems', () => friendItems.getSelfInteractionItems());
    register('useSelfInteractionItemBatch', ([itemId, landIds]) => friendItems.useSelfInteractionItemBatch(itemId, landIds));
    register('doFriendOp', ([gid, opType]) => friend.doFriendOperation(gid, opType));
    register('delFriend', ([gid]) => friend.deleteFriend(gid));

    register('getSeeds', () => farm.getAvailableSeeds(), { execution: 'read-fresh' });
    register('getBag', () => warehouse.getBagDetail(), { execution: 'read-fresh' });
    register('getBagSeeds', () => warehouse.getBagSeeds());
    register('getDiamondBalance', () => pay.getDiamondBalance());
    register('useItem', ([itemIdInput, countInput, uidInput]) => {
        const itemId = Number(itemIdInput) || 0;
        const count = Math.max(1, Number(countInput) || 1);
        const uid = Number(uidInput) || 0;
        return warehouse.useItem(itemId, count, [], uid);
    });
    register('sellItems', ([items]) => {
        const sellList = Array.isArray(items) ? items : [];
        return warehouse.sellItems(sellList.map((item: any) => ({
            id: item.id,
            count: item.count,
            uid: item.uid || 0,
            expire_time: item.expireTime ?? item.expire_time,
        })));
    });
    register('setItemsLocked', ([itemUids, locked]) => warehouse.setItemsLocked(itemUids, locked === true));

    register('getDogSkillGiftStatus', async () => {
        const info = await dogGifts.getDogInfo();
        return { pendingCount: dogGifts.getPendingGiftCount(info) };
    });
    register('claimDogSkillGifts', () => dogGifts.checkAndClaimDogSkillGifts());
    register('getPetInfo', () => pets.getPetInfo());
    register('deployDog', ([dogId]) => pets.deployDog(dogId));
    register('withdrawDog', () => pets.withdrawDog());
    register('useDogFood', ([itemId, count, uid]) => pets.useDogFood(itemId, count, uid));
    register('getPetProtectLogs', () => pets.getProtectLogs());

    register('doFarmOp', ([opType, targetLandId]) => farm.runFarmOperation(opType, targetLandId));
    register('fertilizeOwnLand', ([landId, fertilizerType]) => farm.fertilizeOwnLand(landId, fertilizerType));
    register('buyFertilizer', ([fertilizerType, count]) => mall.autoBuyFertilizer(true, fertilizerType || 'organic', Number(count) || 0));
    register('checkAndBuyFertilizer', ([options]) => mall.checkAndBuyFertilizerBoth(options || {}));
    register('getAnalytics', ([sortBy]) => analytics.getPlantRankings(sortBy), { execution: 'direct' });
    register('getDailyGiftOverview', () => context.getDailyGiftOverview());

    register('getActivityDirectorySnapshot', () => activity.getActivityDirectorySnapshot());
    register('getActivityCenterSnapshot', () => activity.getActivityCenterSnapshot());
    register('getCurrentSeasonEvent', () => activity.getCurrentSeasonEvent());
    register('getCurrentStellarActivity', () => activity.getCurrentStellarActivity());
    register('getCurrentStarSandShop', () => activity.getCurrentStarSandShop());
    register('getCurrentSolarTerms', () => activity.getCurrentSolarTerms());
    register('getCurrentQixiActivity', () => activity.getCurrentQixiActivity());
    register('getCurrentWeatherActivity', () => activity.getCurrentWeatherActivity());
    register('buyWeatherBottle', ([count]) => activity.buyWeatherBottle(count));
    register('collectWeatherBottle', ([targetGid]) => activity.collectWeatherBottle(targetGid));
    register('lightWeatherResearch', ([nodeId]) => activity.lightWeatherResearch(nodeId));
    register('summonWeatherRain', () => activity.summonWeatherRain());
    register('claimBattlePassRewards', () => activity.claimBattlePassRewards());
    register('exchangeStarSandGoods', ([goodsId, count]) => activity.exchangeStarSandGoods(goodsId, count));
    register('lightConstellation', () => activity.lightConstellation());
    register('claimSolarTerm', ([termId]) => activity.claimSolarTerm(String(termId || '')));
    register('getCurrentQingMeiActivity', () => activity.getCurrentQingMeiActivity());
    register('claimQingMeiDailySeed', () => activity.claimQingMeiDailySeed());
    register('startQingMeiBrew', ([ingredients]) => activity.startQingMeiBrew(ingredients));
    register('continueQingMeiBrew', () => activity.continueQingMeiBrew());
    register('settleQingMeiBrew', () => activity.settleQingMeiBrew());
    register('claimQixiBridgeRewards', () => activity.claimQixiBridgeRewards());
    register('giftQixiSachet', ([friendGid, messageTextId]) => activity.giftQixiSachet(friendGid, messageTextId));
    register('exchangeWeatherCollectorBottle', () => activity.exchangeWeatherCollectorBottle());
    register('getWeatherFriends', () => activity.getWeatherFriends(), {
        execution: 'self-queued',
    });
    register('scanWeatherFriends', ([friendGids]) => activity.scanWeatherFriends(friendGids), {
        execution: 'self-queued',
    });
    register('useWeatherCollectorBottle', ([friendGid]) => activity.useWeatherCollectorBottle(friendGid));
    register('useWeatherSummonBottle', () => activity.useWeatherSummonBottle());
    register('useWeatherFrogBottle', ([friendGid]) => activity.useWeatherFrogBottle(friendGid));
    register('useWeatherCloudBottle', ([friendGid, landId]) => activity.useWeatherCloudBottle(friendGid, landId));
    register('advanceWeatherResearch', ([nodeId]) => activity.advanceWeatherResearch(nodeId));

    register('getMallCatalog', ([slotType, subSlotType]) => commerce.getMallCatalog(slotType, subSlotType));
    register('purchaseMallProduct', ([goodsId, count]) => commerce.purchaseMallProduct(goodsId, count));
    register('getMysteryShop', () => commerce.getMysteryShop());
    register('purchaseMysteryOffer', ([npcId]) => commerce.purchaseMysteryOffer(npcId));
    register('getSchedulers', () => context.getSchedulers(), { execution: 'direct' });

    return registry;
}

module.exports = {
    createWorkerApiRegistry,
};
