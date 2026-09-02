import type protobuf from 'protobufjs';

export {};
/**
 * Proto 加载与消息类型管理
 */
const protobufModule = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');
const { log } = require('./utils');

// Proto 根对象与所有消息类型
let root: protobuf.Root | null = null;
const types: Record<string, protobuf.Type> = {};

async function loadProto(): Promise<void> {
    log('系统', '正在加载 Protobuf 定义...');
    root = new protobufModule.Root();
    await root.load([
        getResourcePath('proto', 'game.proto'),
        getResourcePath('proto', 'userpb.proto'),
        getResourcePath('proto', 'plantpb.proto'),
        getResourcePath('proto', 'corepb.proto'),
        getResourcePath('proto', 'shoppb.proto'),
        getResourcePath('proto', 'friendpb.proto'),
        getResourcePath('proto', 'weatherpb.proto'),
        getResourcePath('proto', 'visitpb.proto'),
        getResourcePath('proto', 'notifypb.proto'),
        getResourcePath('proto', 'taskpb.proto'),
        getResourcePath('proto', 'itempb.proto'),
        getResourcePath('proto', 'emailpb.proto'),
        getResourcePath('proto', 'mallpb.proto'),
        getResourcePath('proto', 'mysteryshoppb.proto'),
        getResourcePath('proto', 'redpacketpb.proto'),
        getResourcePath('proto', 'qqvippb.proto'),
        getResourcePath('proto', 'sharepb.proto'),
        getResourcePath('proto', 'illustratedpb.proto'),
        getResourcePath('proto', 'interactpb.proto'),
        getResourcePath('proto', 'activitypb.proto'),
        getResourcePath('proto', 'seasonpb.proto'),
        getResourcePath('proto', 'solartermspb.proto'),
        getResourcePath('proto', 'randomdroppb.proto'),
        getResourcePath('proto', 'guidepb.proto'),
        getResourcePath('proto', 'acepb.proto'),
        getResourcePath('proto', 'careerpb.proto'),
        getResourcePath('proto', 'dogpb.proto'),
        getResourcePath('proto', 'skinpb.proto'),
        getResourcePath('proto', 'avatarframepb.proto'),
        getResourcePath('proto', 'bulletinboardpb.proto'),
        getResourcePath('proto', 'marqueepb.proto'),
        getResourcePath('proto', 'paypb.proto'),
        getResourcePath('proto', 'rechargebonuspb.proto'),
        getResourcePath('proto', 'uicproxypb.proto'),
        getResourcePath('proto', 'mutantpb.proto'),
        getResourcePath('proto', 'miscpb.proto'),
        getResourcePath('proto', 'achievepb.proto'),
    ], { keepCase: true });

    // 网关
    types.GateMessage = root.lookupType('gatepb.Message');
    types.GateMeta = root.lookupType('gatepb.Meta');
    types.EventMessage = root.lookupType('gatepb.EventMessage');

    // 用户
    types.LoginRequest = root.lookupType('gamepb.userpb.LoginRequest');
    types.LoginReply = root.lookupType('gamepb.userpb.LoginReply');
    types.HeartbeatRequest = root.lookupType('gamepb.userpb.HeartbeatRequest');
    types.HeartbeatReply = root.lookupType('gamepb.userpb.HeartbeatReply');
    types.ReportArkClickRequest = root.lookupType('gamepb.userpb.ReportArkClickRequest');
    types.ReportArkClickReply = root.lookupType('gamepb.userpb.ReportArkClickReply');
    types.BatchClientReportFlowRequest = root.lookupType('gamepb.userpb.BatchClientReportFlowRequest');
    types.BatchClientReportFlowReply = root.lookupType('gamepb.userpb.BatchClientReportFlowReply');
    types.SetDisplayInfoRequest = root.lookupType('gamepb.userpb.SetDisplayInfoRequest');
    types.SetDisplayInfoReply = root.lookupType('gamepb.userpb.SetDisplayInfoReply');
    types.SetQQFriendRecommendAuthorizedRequest = root.lookupType('gamepb.userpb.SetQQFriendRecommendAuthorizedRequest');
    types.SetQQFriendRecommendAuthorizedReply = root.lookupType('gamepb.userpb.SetQQFriendRecommendAuthorizedReply');
    types.GetUserSettingsRequest = root.lookupType('gamepb.userpb.GetUserSettingsRequest');
    types.GetUserSettingsReply = root.lookupType('gamepb.userpb.GetUserSettingsReply');
    types.BatchGetBasicInfoRequest = root.lookupType('gamepb.userpb.BatchGetBasicInfoRequest');
    types.BatchGetBasicInfoReply = root.lookupType('gamepb.userpb.BatchGetBasicInfoReply');

    // 农场
    types.AllLandsRequest = root.lookupType('gamepb.plantpb.AllLandsRequest');
    types.AllLandsReply = root.lookupType('gamepb.plantpb.AllLandsReply');
    types.HarvestRequest = root.lookupType('gamepb.plantpb.HarvestRequest');
    types.HarvestReply = root.lookupType('gamepb.plantpb.HarvestReply');
    types.WaterLandRequest = root.lookupType('gamepb.plantpb.WaterLandRequest');
    types.WaterLandReply = root.lookupType('gamepb.plantpb.WaterLandReply');
    types.WeedOutRequest = root.lookupType('gamepb.plantpb.WeedOutRequest');
    types.WeedOutReply = root.lookupType('gamepb.plantpb.WeedOutReply');
    types.InsecticideRequest = root.lookupType('gamepb.plantpb.InsecticideRequest');
    types.InsecticideReply = root.lookupType('gamepb.plantpb.InsecticideReply');
    types.FarmingRequest = root.lookupType('gamepb.plantpb.FarmingRequest');
    types.FarmingReply = root.lookupType('gamepb.plantpb.FarmingReply');
    types.RemovePlantRequest = root.lookupType('gamepb.plantpb.RemovePlantRequest');
    types.RemovePlantReply = root.lookupType('gamepb.plantpb.RemovePlantReply');
    types.PutInsectsRequest = root.lookupType('gamepb.plantpb.PutInsectsRequest');
    types.PutInsectsReply = root.lookupType('gamepb.plantpb.PutInsectsReply');
    types.PutWeedsRequest = root.lookupType('gamepb.plantpb.PutWeedsRequest');
    types.PutWeedsReply = root.lookupType('gamepb.plantpb.PutWeedsReply');
    types.UpgradeLandRequest = root.lookupType('gamepb.plantpb.UpgradeLandRequest');
    types.UpgradeLandReply = root.lookupType('gamepb.plantpb.UpgradeLandReply');
    types.UnlockLandRequest = root.lookupType('gamepb.plantpb.UnlockLandRequest');
    types.UnlockLandReply = root.lookupType('gamepb.plantpb.UnlockLandReply');
    types.StealPlayer = root.lookupType('gamepb.plantpb.StealPlayer');
    types.FertilizeRequest = root.lookupType('gamepb.plantpb.FertilizeRequest');
    types.FertilizeReply = root.lookupType('gamepb.plantpb.FertilizeReply');
    types.PutSocialItemRequest = root.lookupType('gamepb.plantpb.PutSocialItemRequest');
    types.PutSocialItemReply = root.lookupType('gamepb.plantpb.PutSocialItemReply');

    // 背包/仓库
    types.BagRequest = root.lookupType('gamepb.itempb.BagRequest');
    types.BagReply = root.lookupType('gamepb.itempb.BagReply');
    types.SellRequest = root.lookupType('gamepb.itempb.SellRequest');
    types.SellReply = root.lookupType('gamepb.itempb.SellReply');
    types.UseRequest = root.lookupType('gamepb.itempb.UseRequest');
    types.UseTarget = root.lookupType('gamepb.itempb.UseTarget');
    types.UseReply = root.lookupType('gamepb.itempb.UseReply');
    types.BatchUseRequest = root.lookupType('gamepb.itempb.BatchUseRequest');
    types.BatchUseReply = root.lookupType('gamepb.itempb.BatchUseReply');
    types.LockItemsRequest = root.lookupType('gamepb.itempb.LockItemsRequest');
    types.LockItemsReply = root.lookupType('gamepb.itempb.LockItemsReply');
    types.UnlockItemsRequest = root.lookupType('gamepb.itempb.UnlockItemsRequest');
    types.UnlockItemsReply = root.lookupType('gamepb.itempb.UnlockItemsReply');
    types.PlantRequest = root.lookupType('gamepb.plantpb.PlantRequest');
    types.PlantReply = root.lookupType('gamepb.plantpb.PlantReply');

    // 商店
    types.ShopProfilesRequest = root.lookupType('gamepb.shoppb.ShopProfilesRequest');
    types.ShopProfilesReply = root.lookupType('gamepb.shoppb.ShopProfilesReply');
    types.ShopInfoRequest = root.lookupType('gamepb.shoppb.ShopInfoRequest');
    types.ShopInfoReply = root.lookupType('gamepb.shoppb.ShopInfoReply');
    types.BuyGoodsRequest = root.lookupType('gamepb.shoppb.BuyGoodsRequest');
    types.BuyGoodsReply = root.lookupType('gamepb.shoppb.BuyGoodsReply');
    types.GetMonthCardInfosRequest = root.lookupType('gamepb.mallpb.GetMonthCardInfosRequest');
    types.GetMonthCardInfosReply = root.lookupType('gamepb.mallpb.GetMonthCardInfosReply');
    types.ClaimMonthCardRewardRequest = root.lookupType('gamepb.mallpb.ClaimMonthCardRewardRequest');
    types.ClaimMonthCardRewardReply = root.lookupType('gamepb.mallpb.ClaimMonthCardRewardReply');
    types.GetTodayClaimStatusRequest = root.lookupType('gamepb.redpacketpb.GetTodayClaimStatusRequest');
    types.GetTodayClaimStatusReply = root.lookupType('gamepb.redpacketpb.GetTodayClaimStatusReply');
    types.ClaimRedPacketRequest = root.lookupType('gamepb.redpacketpb.ClaimRedPacketRequest');
    types.ClaimRedPacketReply = root.lookupType('gamepb.redpacketpb.ClaimRedPacketReply');
    types.GetMallListBySlotTypeRequest = root.lookupType('gamepb.mallpb.GetMallListBySlotTypeRequest');
    types.GetMallListBySlotTypeResponse = root.lookupType('gamepb.mallpb.GetMallListBySlotTypeResponse');
    types.MallGoods = root.lookupType('gamepb.mallpb.MallGoods');
    types.PurchaseRequest = root.lookupType('gamepb.mallpb.PurchaseRequest');
    types.PurchaseResponse = root.lookupType('gamepb.mallpb.PurchaseResponse');
    types.PurchaseLimit = root.lookupType('gamepb.mallpb.PurchaseLimit');
    types.GetActiveNPCRequest = root.lookupType('gamepb.mysteryshoppb.GetActiveNPCRequest');
    types.GetActiveNPCReply = root.lookupType('gamepb.mysteryshoppb.GetActiveNPCReply');
    types.ActiveMysteryShopNPC = root.lookupType('gamepb.mysteryshoppb.ActiveNPC');
    types.MysteryShopBuyRequest = root.lookupType('gamepb.mysteryshoppb.BuyRequest');
    types.GetQQVipRewardsStatusRequest = root.lookupType('gamepb.qqvippb.GetQQVipRewardsStatusRequest');
    types.GetQQVipRewardsStatusReply = root.lookupType('gamepb.qqvippb.GetQQVipRewardsStatusReply');
    types.RefreshVipInfoRequest = root.lookupType('gamepb.qqvippb.RefreshVipInfoRequest');
    types.RefreshVipInfoReply = root.lookupType('gamepb.qqvippb.RefreshVipInfoReply');
    types.ClaimQQVipRewardsRequest = root.lookupType('gamepb.qqvippb.ClaimQQVipRewardsRequest');
    types.ClaimQQVipRewardsReply = root.lookupType('gamepb.qqvippb.ClaimQQVipRewardsReply');
    types.CheckCanShareRequest = root.lookupType('gamepb.sharepb.CheckCanShareRequest');
    types.CheckCanShareReply = root.lookupType('gamepb.sharepb.CheckCanShareReply');
    types.ReportShareRequest = root.lookupType('gamepb.sharepb.ReportShareRequest');
    types.ReportShareReply = root.lookupType('gamepb.sharepb.ReportShareReply');
    types.ClaimShareRewardRequest = root.lookupType('gamepb.sharepb.ClaimShareRewardRequest');
    types.ClaimShareRewardReply = root.lookupType('gamepb.sharepb.ClaimShareRewardReply');
    types.GetIllustratedListV2Request = root.lookupType('gamepb.illustratedpb.GetIllustratedListV2Request');
    types.GetIllustratedListV2Reply = root.lookupType('gamepb.illustratedpb.GetIllustratedListV2Reply');
    types.GetIllustratedLevelListV2Request = root.lookupType('gamepb.illustratedpb.GetIllustratedLevelListV2Request');
    types.GetIllustratedLevelListV2Reply = root.lookupType('gamepb.illustratedpb.GetIllustratedLevelListV2Reply');
    types.ClaimAllRewardsV2Request = root.lookupType('gamepb.illustratedpb.ClaimAllRewardsV2Request');
    types.ClaimAllRewardsV2Reply = root.lookupType('gamepb.illustratedpb.ClaimAllRewardsV2Reply');
    types.ClearNewUnlockedFruitsV2Request = root.lookupType('gamepb.illustratedpb.ClearNewUnlockedFruitsV2Request');
    types.ClearNewUnlockedFruitsV2Reply = root.lookupType('gamepb.illustratedpb.ClearNewUnlockedFruitsV2Reply');

    // 好友
    types.GetAllFriendsRequest = root.lookupType('gamepb.friendpb.GetAllRequest');
    types.GetAllFriendsReply = root.lookupType('gamepb.friendpb.GetAllReply');
    types.GetApplicationsRequest = root.lookupType('gamepb.friendpb.GetApplicationsRequest');
    types.GetApplicationsReply = root.lookupType('gamepb.friendpb.GetApplicationsReply');
    types.AcceptFriendsRequest = root.lookupType('gamepb.friendpb.AcceptFriendsRequest');
    types.AcceptFriendsReply = root.lookupType('gamepb.friendpb.AcceptFriendsReply');
    types.RejectFriendsRequest = root.lookupType('gamepb.friendpb.RejectFriendsRequest');
    types.RejectFriendsReply = root.lookupType('gamepb.friendpb.RejectFriendsReply');
    types.DelFriendRequest = root.lookupType('gamepb.friendpb.DelFriendRequest');
    types.DelFriendReply = root.lookupType('gamepb.friendpb.DelFriendReply');
    types.SyncAllFriendsRequest = root.lookupType('gamepb.friendpb.SyncAllRequest');
    types.SyncAllFriendsReply = root.lookupType('gamepb.friendpb.SyncAllReply');
    types.GetGameFriendsRequest = root.lookupType('gamepb.friendpb.GetGameFriendsRequest');
    types.GetGameFriendsReply = root.lookupType('gamepb.friendpb.GetGameFriendsReply');
    types.GetShareKeyRequest = root.lookupType('gamepb.friendpb.GetShareKeyRequest');
    types.GetShareKeyReply = root.lookupType('gamepb.friendpb.GetShareKeyReply');

    // 访问
    types.VisitEnterRequest = root.lookupType('gamepb.visitpb.EnterRequest');
    types.VisitEnterReply = root.lookupType('gamepb.visitpb.EnterReply');
    types.VisitLeaveRequest = root.lookupType('gamepb.visitpb.LeaveRequest');
    types.VisitLeaveReply = root.lookupType('gamepb.visitpb.LeaveReply');

    // 任务
    types.TaskInfoRequest = root.lookupType('gamepb.taskpb.TaskInfoRequest');
    types.TaskInfoReply = root.lookupType('gamepb.taskpb.TaskInfoReply');
    types.ClaimTaskRewardRequest = root.lookupType('gamepb.taskpb.ClaimTaskRewardRequest');
    types.ClaimTaskRewardReply = root.lookupType('gamepb.taskpb.ClaimTaskRewardReply');
    types.BatchClaimTaskRewardRequest = root.lookupType('gamepb.taskpb.BatchClaimTaskRewardRequest');
    types.BatchClaimTaskRewardReply = root.lookupType('gamepb.taskpb.BatchClaimTaskRewardReply');
    types.ClaimDailyRewardRequest = root.lookupType('gamepb.taskpb.ClaimDailyRewardRequest');
    types.ClaimDailyRewardReply = root.lookupType('gamepb.taskpb.ClaimDailyRewardReply');

    // 邮箱
    types.GetEmailListRequest = root.lookupType('gamepb.emailpb.GetEmailListRequest');
    types.GetEmailListReply = root.lookupType('gamepb.emailpb.GetEmailListReply');
    types.ClaimEmailRequest = root.lookupType('gamepb.emailpb.ClaimEmailRequest');
    types.ClaimEmailReply = root.lookupType('gamepb.emailpb.ClaimEmailReply');
    types.BatchClaimEmailRequest = root.lookupType('gamepb.emailpb.BatchClaimEmailRequest');
    types.BatchClaimEmailReply = root.lookupType('gamepb.emailpb.BatchClaimEmailReply');
    types.BatchDeleteEmailRequest = root.lookupType('gamepb.emailpb.BatchDeleteEmailRequest');
    types.BatchDeleteEmailReply = root.lookupType('gamepb.emailpb.BatchDeleteEmailReply');

    // 服务器推送通知
    types.LandsNotify = root.lookupType('gamepb.plantpb.LandsNotify');
    types.FarmSocialEventsNotify = root.lookupType('gamepb.plantpb.FarmSocialEventsNotify');
    types.BasicNotify = root.lookupType('gamepb.userpb.BasicNotify');
    types.KickoutNotify = root.lookupType('gatepb.KickoutNotify');
    types.FriendApplicationReceivedNotify = root.lookupType('gamepb.friendpb.FriendApplicationReceivedNotify');
    types.FriendAddedNotify = root.lookupType('gamepb.friendpb.FriendAddedNotify');
    types.InteractRecordsRequest = root.lookupType('gamepb.interactpb.InteractRecordsRequest');
    types.InteractRecordsReply = root.lookupType('gamepb.interactpb.InteractRecordsReply');
    types.GetInteractInfoRequest = root.lookupType('gamepb.interactpb.GetInteractInfoRequest');
    types.GetInteractInfoReply = root.lookupType('gamepb.interactpb.GetInteractInfoReply');
    types.GetInteractSummaryRequest = root.lookupType('gamepb.interactpb.GetInteractSummaryRequest');
    types.GetInteractSummaryReply = root.lookupType('gamepb.interactpb.GetInteractSummaryReply');

    // 分享
    types.GetInviteInfoRequest = root.lookupType('gamepb.sharepb.GetInviteInfoRequest');
    types.GetInviteInfoReply = root.lookupType('gamepb.sharepb.GetInviteInfoReply');

    // 活动中心
    types.ActivityListRequest = root.lookupType('gamepb.activitypb.ActivityListRequest');
    types.ActivityListReply = root.lookupType('gamepb.activitypb.ActivityListReply');
    types.SetSplashedRequest = root.lookupType('gamepb.activitypb.SetSplashedRequest');
    types.SetSplashedReply = root.lookupType('gamepb.activitypb.SetSplashedReply');
    types.GetGroupRequest = root.lookupType('gamepb.activitypb.GetGroupRequest');
    types.GetGroupReply = root.lookupType('gamepb.activitypb.GetGroupReply');
    types.QueryActivityRequest = root.lookupType('gamepb.activitypb.QueryActivityRequest');
    types.ExchangeShopOperateParams = root.lookupType('gamepb.activitypb.ExchangeShopOperateParams');
    types.ExchangeShopRequest = root.lookupType('gamepb.activitypb.ExchangeShopRequest');
    types.WeatherResearchOperateParams = root.lookupType('gamepb.activitypb.WeatherResearchOperateParams');
    types.AdvanceWeatherResearchRequest = root.lookupType('gamepb.activitypb.AdvanceWeatherResearchRequest');
    types.WeatherCollectOperateParams = root.lookupType('gamepb.activitypb.WeatherCollectOperateParams');
    types.CollectWeatherRequest = root.lookupType('gamepb.activitypb.CollectWeatherRequest');
    types.WeatherResearchOperateRequest = root.lookupType('gamepb.activitypb.WeatherResearchOperateRequest');
    types.WeatherTaskOperateRequest = root.lookupType('gamepb.activitypb.WeatherTaskOperateRequest');
    types.OperateConstellationRequest = root.lookupType('gamepb.activitypb.OperateConstellationRequest');
    types.ClaimQingMeiDailySeedRequest = root.lookupType('gamepb.activitypb.ClaimQingMeiDailySeedRequest');
    types.StartQingMeiBrewRequest = root.lookupType('gamepb.activitypb.StartQingMeiBrewRequest');
    types.ContinueQingMeiBrewRequest = root.lookupType('gamepb.activitypb.ContinueQingMeiBrewRequest');
    types.SettleQingMeiBrewRequest = root.lookupType('gamepb.activitypb.SettleQingMeiBrewRequest');
    types.ClaimQixiBridgeRewardsRequest = root.lookupType('gamepb.activitypb.ClaimQixiBridgeRewardsRequest');
    types.GiftQixiSachetRequest = root.lookupType('gamepb.activitypb.GiftQixiSachetRequest');
    types.CharityRedFlowerOperateRequest = root.lookupType('gamepb.activitypb.CharityRedFlowerOperateRequest');
    types.ActivityOperateReply = root.lookupType('gamepb.activitypb.ActivityOperateReply');
    types.GetWeatherStatusRequest = root.lookupType('gamepb.weatherpb.GetWeatherStatusRequest');
    types.GetWeatherStatusReply = root.lookupType('gamepb.weatherpb.GetWeatherStatusReply');
    types.GetSeasonInfoRequest = root.lookupType('gamepb.seasonpb.GetSeasonInfoRequest');
    types.GetSeasonInfoReply = root.lookupType('gamepb.seasonpb.GetSeasonInfoReply');
    types.ClaimBattlePassRewardsRequest = root.lookupType('gamepb.seasonpb.ClaimBattlePassRewardsRequest');
    types.ClaimBattlePassRewardsReply = root.lookupType('gamepb.seasonpb.ClaimBattlePassRewardsReply');
    types.BattlePassChangeNotify = root.lookupType('gamepb.seasonpb.BattlePassChangeNotify');
    types.GetSolarTermsRequest = root.lookupType('gamepb.solartermspb.GetSolarTermsRequest');
    types.GetSolarTermsReply = root.lookupType('gamepb.solartermspb.GetSolarTermsReply');
    types.GetSolarTermsRedDotRequest = root.lookupType('gamepb.solartermspb.GetSolarTermsRedDotRequest');
    types.GetSolarTermsRedDotReply = root.lookupType('gamepb.solartermspb.GetSolarTermsRedDotReply');
    types.ClaimSolarTermsRequest = root.lookupType('gamepb.solartermspb.ClaimSolarTermsRequest');
    types.ClaimSolarTermsReply = root.lookupType('gamepb.solartermspb.ClaimSolarTermsReply');

    // 随机掉落
    types.RandomDropGetActivityInfoRequest = root.lookupType('gamepb.randomdroppb.GetActivityInfoRequest');
    types.RandomDropGetActivityInfoReply = root.lookupType('gamepb.randomdroppb.GetActivityInfoReply');

    // 引导
    types.SetWeakGuideNodeCompleteRequest = root.lookupType('gamepb.guidepb.SetWeakGuideNodeCompleteRequest');
    types.SetWeakGuideNodeCompleteReply = root.lookupType('gamepb.guidepb.SetWeakGuideNodeCompleteReply');
    types.ClaimWeakGuideRewardRequest = root.lookupType('gamepb.guidepb.ClaimWeakGuideRewardRequest');
    types.ClaimWeakGuideRewardReply = root.lookupType('gamepb.guidepb.ClaimWeakGuideRewardReply');

    // 反作弊
    types.AntiDataRequest = root.lookupType('gamepb.acepb.AntiDataRequest');
    types.AntiDataReply = root.lookupType('gamepb.acepb.AntiDataReply');

    // 变异
    types.ReadMutantBookRequest = root.lookupType('gamepb.mutantpb.ReadMutantBookRequest');
    types.ReadMutantBookReply = root.lookupType('gamepb.mutantpb.ReadMutantBookReply');

    // 职业
    types.CareerInfoGetRequest = root.lookupType('gamepb.careerpb.CareerInfoGetRequest');
    types.CareerInfoGetReply = root.lookupType('gamepb.careerpb.CareerInfoGetReply');

    // 狗狗
    types.GetDogInfoRequest = root.lookupType('gamepb.dogpb.GetDogInfoRequest');
    types.GetDogInfoReply = root.lookupType('gamepb.dogpb.GetDogInfoReply');
    types.DeployDogRequest = root.lookupType('gamepb.dogpb.DeployDogRequest');
    types.DeployDogReply = root.lookupType('gamepb.dogpb.DeployDogReply');
    types.WithdrawDogRequest = root.lookupType('gamepb.dogpb.WithdrawDogRequest');
    types.WithdrawDogReply = root.lookupType('gamepb.dogpb.WithdrawDogReply');
    types.AddFoodRequest = root.lookupType('gamepb.dogpb.AddFoodRequest');
    types.AddFoodReply = root.lookupType('gamepb.dogpb.AddFoodReply');
    types.ClaimSkillGiftsRequest = root.lookupType('gamepb.dogpb.ClaimSkillGiftsRequest');
    types.ClaimSkillGiftsReply = root.lookupType('gamepb.dogpb.ClaimSkillGiftsReply');
    types.PendingGiftCountNotify = root.lookupType('gamepb.dogpb.PendingGiftCountNotify');
    types.GetProtectLogsRequest = root.lookupType('gamepb.dogpb.GetProtectLogsRequest');
    types.GetProtectLogsReply = root.lookupType('gamepb.dogpb.GetProtectLogsReply');
    types.NewProtectLogNotify = root.lookupType('gamepb.dogpb.NewProtectLogNotify');

    // 皮肤
    types.SkinsOwnedRequest = root.lookupType('gamepb.skinpb.SkinsOwnedRequest');
    types.SkinsOwnedReply = root.lookupType('gamepb.skinpb.SkinsOwnedReply');
    types.SkinsEquippedRequest = root.lookupType('gamepb.skinpb.SkinsEquippedRequest');
    types.SkinsEquippedReply = root.lookupType('gamepb.skinpb.SkinsEquippedReply');
    types.GetSkinEffectTypeParamsRequest = root.lookupType('gamepb.skinpb.GetSkinEffectTypeParamsRequest');
    types.GetSkinEffectTypeParamsReply = root.lookupType('gamepb.skinpb.GetSkinEffectTypeParamsReply');

    // 头像框
    types.AvatarFramesOwnedRequest = root.lookupType('gamepb.avatarframepb.AvatarFramesOwnedRequest');
    types.AvatarFramesOwnedReply = root.lookupType('gamepb.avatarframepb.AvatarFramesOwnedReply');

    // 公告板
    types.GetBulletinListRequest = root.lookupType('gamepb.bulletinboardpb.GetBulletinListRequest');
    types.GetBulletinListReply = root.lookupType('gamepb.bulletinboardpb.GetBulletinListReply');
    types.BulletinListChangedNTF = root.lookupType('gamepb.bulletinboardpb.BulletinListChangedNTF');

    // 跑马灯
    types.GetMarqueeRequest = root.lookupType('gamepb.marqueepb.GetMarqueeRequest');
    types.GetMarqueeReply = root.lookupType('gamepb.marqueepb.GetMarqueeReply');

    // 充值
    types.GetRechargeInfoRequest = root.lookupType('gamepb.paypb.GetRechargeInfoRequest');
    types.GetRechargeInfoReply = root.lookupType('gamepb.paypb.GetRechargeInfoReply');
    types.RechargeInfo = root.lookupType('gamepb.paypb.RechargeInfo');
    // 充值奖励
    types.GetRechargeBonusConfigRequest = root.lookupType('gamepb.rechargebonuspb.GetConfigRequest');
    types.GetRechargeBonusConfigReply = root.lookupType('gamepb.rechargebonuspb.GetConfigReply');

    // 文本审核
    types.BatchModerateTextRequest = root.lookupType('gamepb.uicproxypb.BatchModerateTextRequest');
    types.BatchModerateTextReply = root.lookupType('gamepb.uicproxypb.BatchModerateTextReply');

    // 取消"新"标记
    types.CannelNewRequest = root.lookupType('gamepb.itempb.CannelNewRequest');
    types.CannelNewReply = root.lookupType('gamepb.itempb.CannelNewReply');

    // 皮肤（补充）
    types.EquipSkinRequest = root.lookupType('gamepb.skinpb.EquipRequest');
    types.EquipSkinReply = root.lookupType('gamepb.skinpb.EquipReply');
    types.MarkSkinAsViewedRequest = root.lookupType('gamepb.skinpb.MarkAsViewedRequest');
    types.MarkSkinAsViewedReply = root.lookupType('gamepb.skinpb.MarkAsViewedReply');

    // 互动（补充）
    types.DismissInteractPopupRequest = root.lookupType('gamepb.interactpb.DismissInteractPopupRequest');
    types.DismissInteractPopupReply = root.lookupType('gamepb.interactpb.DismissInteractPopupReply');

    // 公告板（补充）
    types.GetBulletinDetailRequest = root.lookupType('gamepb.bulletinboardpb.GetBulletinDetailRequest');
    types.GetBulletinDetailReply = root.lookupType('gamepb.bulletinboardpb.GetBulletinDetailReply');

    // Misc
    types.GetFollowGiftStatusRequest = root.lookupType('gamepb.miscpb.GetFollowGiftStatusRequest');
    types.GetFollowGiftStatusReply = root.lookupType('gamepb.miscpb.GetFollowGiftStatusReply');

    // 分享（补充）
    types.GetInviteAwardRequest = root.lookupType('gamepb.sharepb.GetInviteAwardRequest');
    types.GetInviteAwardReply = root.lookupType('gamepb.sharepb.GetInviteAwardReply');

    // 通知
    types.ItemNotify = root.lookupType('gamepb.itempb.ItemNotify');
    types.ItemUseDailyNotify = root.lookupType('gamepb.itempb.ItemUseDailyNotify');
    types.GoodsUnlockNotify = root.lookupType('gamepb.shoppb.GoodsUnlockNotify');
    types.TaskInfoNotify = root.lookupType('gamepb.taskpb.TaskInfoNotify');
    types.NeedNotify = root.lookupType('gamepb.mallpb.NeedNotify');
    types.VipInfoUpdatedNTF = root.lookupType('gamepb.qqvippb.VipInfoUpdatedNTF');
    types.AvatarFrameRedDotNotify = root.lookupType('gamepb.avatarframepb.AvatarFrameRedDotNotify');
    types.RechargeInfoNotify = root.lookupType('gamepb.paypb.RechargeInfoNotify');
    types.AchieveRedDotNotify = root.lookupType('gamepb.achievepb.AchieveRedDotNotify');
    types.ProductsHasChangedNotify = root.lookupType('gamepb.mallpb.ProductsHasChangedNotify');
    types.ActiviesChangeNotify = root.lookupType('gamepb.activitypb.ActiviesChangeNotify');
    types.SkinChangeNotify = root.lookupType('gamepb.skinpb.SkinChangeNotify');
    types.WeatherChangeNotify = root.lookupType('gamepb.weatherpb.WeatherChangeNotify');

    // Proto 加载完成
    log('系统', 'Protobuf 定义加载完成');
}

module.exports = { loadProto, types };
