export {};

const network = require('../../utils/network');
const { types } = require('../../utils/proto');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const { logWarn } = require('../../utils/utils');
const { error } = require('./model');

const ROUTES: Record<string, [string, string, string, string?]> = {
    cells: ['homesteadpb.HomesteadService', 'AllCells', 'RanchAllCells'],
    buildings: ['homesteadpb.HomesteadService', 'GetBuildingList', 'RanchGetBuildingList'],
    facility: ['homesteadpb.HomesteadService', 'GetFacilityDetail', 'RanchGetFacilityDetail'],
    upgrade: ['homesteadpb.HomesteadService', 'UpgradeBuilding', 'RanchUpgradeBuilding'],
    completeUpgrade: ['homesteadpb.HomesteadService', 'CompleteBuildingUpgrade', 'RanchCompleteBuildingUpgrade'],
    addGrass: ['homesteadpb.FeedMachineService', 'AddFeed', 'RanchAddFeed'],
    animals: ['animalpb.AnimalService', 'GetRanchDetail', 'RanchGetRanchDetail'],
    enterFriend: ['visitpb.VisitService', 'EnterHomestead', 'RanchEnterHomestead'],
    leaveFriend: ['visitpb.VisitService', 'LeaveHomestead', 'RanchLeaveHomestead'],
    steal: ['animalpb.AnimalService', 'StealProduce', 'RanchStealProduce'],
    place: ['animalpb.AnimalService', 'PlaceAnimal', 'RanchPlaceAnimal'],
    produce: ['animalpb.AnimalService', 'TriggerProduce', 'RanchTriggerProduce'],
    harvest: ['animalpb.AnimalService', 'HarvestRanch', 'RanchHarvestRanch'],
    feed: ['animalpb.AnimalService', 'FeedAnimal', 'RanchFeedAnimal'],
    clean: ['animalpb.RanchService', 'CleanAllRanch', 'RanchCleanAllRanch'],
    stroke: ['animalpb.RanchService', 'StrokeAnimal', 'RanchStrokeAnimal'],
    bag: ['itempb.ItemService', 'GetBag', 'RanchGetBag'],
    bagTabs: ['itempb.ItemService', 'GetBagTab', 'RanchGetBagTab'],
    sell: ['itempb.ItemService', 'Sell', 'RanchSell'],
    useCan: ['itempb.ItemService', 'Use', 'RanchUse'],
    shop: ['shoppb.ShopService', 'ShopInfo', 'ShopInfo'],
    buy: ['shoppb.ShopService', 'BuyGoods', 'BuyGoods'],
    market: ['shoppb.ShopService', 'RotationShopInfo', 'RanchRotationShopInfo'],
    exchange: ['shoppb.ShopService', 'RotationBuyGoods', 'RanchRotationBuyGoods'],
    tasks: ['taskpb.TaskService', 'TaskInfo', 'TaskInfo'],
    claimTask: ['taskpb.TaskService', 'ClaimTaskReward', 'ClaimTaskReward'],
    claimTasks: ['taskpb.TaskService', 'BatchClaimTaskReward', 'BatchClaimTaskReward'],
    reportTask: ['taskpb.TaskService', 'ClientReportProgress', 'ClientReportProgress'],
    book: ['illustratedpb.IllustratedService', 'GetIllustratedListV2', 'RanchGetIllustratedListV2'],
    weightBook: ['illustratedpb.IllustratedService', 'GetRanchWeightScoreV2', 'RanchGetRanchWeightScoreV2'],
    claimBook: ['illustratedpb.IllustratedService', 'ClaimAllRewardsV2', 'RanchClaimAllRewardsV2'],
    claimWeight: ['illustratedpb.IllustratedService', 'ClaimRanchWeightScoreRewardV2', 'RanchClaimRanchWeightScoreRewardV2'],
    checkShare: ['sharepb.ShareService', 'CheckCanShare', 'CheckCanShare'],
    reportShare: ['sharepb.ShareService', 'ReportShare', 'RanchReportShare'],
    claimShare: ['sharepb.ShareService', 'ClaimShareReward', 'RanchClaimShareReward'],
    activities: ['activitypb.ActivityService', 'List', 'ActivityList'],
    canShop: ['mallpb.MallService', 'GetMallListBySlotType', 'GetMallListBySlotType', 'GetMallListBySlotTypeResponse'],
    buyCan: ['mallpb.MallService', 'Purchase', 'Purchase', 'PurchaseResponse'],
};

async function rpc(route: string, input: any = {}, writing = false): Promise<any> {
    const [service, method, type, replyType] = ROUTES[route];
    const request = types[`${type}Request`];
    const body = request.encode(request.fromObject(input)).finish();
    const context = getAmbientSendContext();
    const reply = await network.sendMsgAsync(`gamepb.${service}`, method, body, {
        beforeSend: () => context?.check(`gamepb.${service}`, method) || null,
        onSent: () => { if (writing) context?.onSent(`gamepb.${service}`, method); },
    });
    return types[replyType || `${type}Reply`].decode(reply.body);
}

function isUnlocked(): boolean {
    return network.getUserState().unlockedSceneIds.includes(2);
}

function inScene(run: (cells: any) => Promise<any>): Promise<any> {
    return runExclusiveAutomationTask('ranch.scene', async () => {
        if (!isUnlocked()) throw error('RANCH_LOCKED', '牧场尚未解锁，请先在游戏中完成开启条件');
        const previous = network.getUserState().globalSceneId;
        const socket = network.getWs();
        let result: any;
        try {
            const scene = previous === 2 ? null : await network.loginGameScene(2);
            const cells = scene ? types.RanchSceneData.decode(scene.big_farm_scene_ext_data).homestead_cells : null;
            result = await run(cells);
            return result;
        } finally {
            if (previous !== 2 && network.getWs() === socket) {
                try {
                    // 调用方取消后仍在原队列任务中恢复场景。
                    await runWithSendContext({ check: () => null, onSent: () => {} }, () => network.loginGameScene(previous));
                } catch (error: any) {
                    logWarn('牧场', `恢复场景 ${previous} 失败：${error.message}`, { module: 'ranch', event: 'ranch_scene_restore' });
                    network.invalidateGameScene('牧场操作结束后场景恢复未确认，需要重新登录');
                    if (result) Object.assign(result, { sceneRestored: false, refreshRequired: true, notice: '场景恢复未确认，账号需重新登录；请刷新核对操作结果' });
                }
            }
        }
    });
}

module.exports = { rpc, inScene, isUnlocked };
