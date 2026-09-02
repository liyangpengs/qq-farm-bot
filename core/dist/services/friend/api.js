"use strict";
/**
 * 好友 API 底层操作 (protobuf 发送/接收)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllFriends = getAllFriends;
exports.acceptFriends = acceptFriends;
exports.rejectFriends = rejectFriends;
exports.getApplications = getApplications;
exports.delFriend = delFriend;
exports.enterFriendFarm = enterFriendFarm;
exports.leaveFriendFarm = leaveFriendFarm;
exports.helpWater = helpWater;
exports.helpFarming = helpFarming;
exports.stealHarvest = stealHarvest;
exports.putPlantItems = putPlantItems;
exports.putPlantItemsDetailed = putPlantItemsDetailed;
exports.putInsects = putInsects;
exports.putWeeds = putWeeds;
exports.putInsectsDetailed = putInsectsDetailed;
exports.putWeedsDetailed = putWeedsDetailed;
exports.putSocialItem = putSocialItem;
const { CONFIG } = require('../../config/config');
const { sendMsgAsync, getUserState, GatewayError } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { toLong, toNum, log, logWarn, sleep, randomDelay } = require('../../utils/utils');
const { getFarmingSkillGiftCount } = require('../dog-skill-gifts');
const { recordFriendDogFromEnterReply } = require('./pet-cache');
const { syncKnownFriendGidsFromRecentVisitors, fetchQqFriendsByKnownGids, syncKnownFriendGidsFromFriends, getEffectiveKnownQqFriendGids, fetchQqFriendsByLegacyMethod, dedupeFriendsByGid, buildFriendReply, } = require('./gid-manager');
// 延迟引用 scheduler 模块，避免循环依赖
let _scheduler = null;
function schedulerRef() {
    if (!_scheduler)
        _scheduler = require('./scheduler');
    return _scheduler;
}
const allFriendsRequests = {};
// ============ 好友 API ============
async function fetchAllFriends(forceSync, priority) {
    const isQQ = CONFIG.platform === 'qq';
    if (isQQ) {
        await syncKnownFriendGidsFromRecentVisitors(forceSync, priority);
        const friendsFromKnownGids = await fetchQqFriendsByKnownGids(priority);
        if (friendsFromKnownGids.length > 0) {
            syncKnownFriendGidsFromFriends(friendsFromKnownGids);
            return buildFriendReply(friendsFromKnownGids);
        }
        try {
            const legacyFriends = dedupeFriendsByGid(await fetchQqFriendsByLegacyMethod(priority));
            if (legacyFriends.length > 0) {
                syncKnownFriendGidsFromFriends(legacyFriends);
            }
            else if (getEffectiveKnownQqFriendGids().length === 0) {
                logWarn('好友', 'QQ 好友列表为空；若近期接口已切到 GetGameFriends，请先在好友页维护已知好友 GID 列表', {
                    module: 'friend',
                    event: '好友列表接口',
                    result: 'empty',
                });
            }
            return buildFriendReply(legacyFriends);
        }
        catch (e) {
            if (getEffectiveKnownQqFriendGids().length === 0) {
                throw new Error(`QQ 好友列表获取失败，请先在好友页维护已知好友 GID 列表。${e.message}`);
            }
            throw e;
        }
    }
    const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body, { priority });
    return types.GetAllFriendsReply.decode(replyBody);
}
async function getAllFriends(forceSync = false, priority = 'normal') {
    // 同优先级好友列表请求合并，避免页面刷新、巡田和后台同步同时重复拉取。
    // 低优先级请求不会阻塞普通请求；反过来低优先级可以复用正在执行的普通请求。
    if (priority === 'low' && allFriendsRequests.normal)
        return allFriendsRequests.normal;
    const current = allFriendsRequests[priority];
    if (current)
        return current;
    const request = fetchAllFriends(forceSync, priority);
    allFriendsRequests[priority] = request;
    try {
        return await request;
    }
    finally {
        if (allFriendsRequests[priority] === request)
            delete allFriendsRequests[priority];
    }
}
async function acceptFriends(gids) {
    const body = types.AcceptFriendsRequest.encode(types.AcceptFriendsRequest.create({
        friend_gids: gids.map((g) => toLong(g)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'AcceptFriends', body);
    return types.AcceptFriendsReply.decode(replyBody);
}
async function rejectFriends(gids) {
    const body = types.RejectFriendsRequest.encode(types.RejectFriendsRequest.create({
        friend_gids: gids.map((g) => toLong(g)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'RejectFriends', body);
    return types.RejectFriendsReply.decode(replyBody);
}
async function getApplications() {
    const body = types.GetApplicationsRequest.encode(types.GetApplicationsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetApplications', body);
    return types.GetApplicationsReply.decode(replyBody);
}
async function delFriend(gid) {
    const numericGid = toNum(gid);
    if (!numericGid)
        throw new Error('无效的好友 GID');
    if (!types.DelFriendRequest || !types.DelFriendReply) {
        throw new Error('DelFriend 接口类型未加载');
    }
    const body = types.DelFriendRequest.encode(types.DelFriendRequest.create({
        friend_gid: toLong(numericGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'DelFriend', body);
    return types.DelFriendReply.decode(replyBody);
}
async function enterFriendFarm(friendGid, priority = 'normal') {
    const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2, // ENTER_REASON_FRIEND
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body, { priority });
    const reply = types.VisitEnterReply.decode(replyBody);
    // Enter 回包是护主犬信息的唯一来源；所有进好友农场的调用都在这里顺手写缓存，不额外花 RPC。
    recordFriendDogFromEnterReply(friendGid, reply);
    return reply;
}
async function leaveFriendFarm(friendGid, priority = 'normal') {
    const body = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({
        host_gid: toLong(friendGid),
    })).finish();
    try {
        await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body, { priority });
    }
    catch { /* 离开失败不影响主流程 */ }
}
async function helpWater(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    const reply = types.WaterLandReply.decode(replyBody);
    schedulerRef().updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp)
            schedulerRef().autoDisableHelpByExpLimit();
    }
    return reply;
}
async function helpFarming(friendGid, landIds, stopWhenExpLimit = false) {
    const targetIds = [...new Set((landIds || []).map((id) => toNum(id)).filter((id) => id > 0))];
    if (targetIds.length === 0) {
        return { effect: 'noop', operationCount: 0, landCount: 0, landIds: [], operationLimits: [], dogSkillGiftCount: 0 };
    }
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.FarmingRequest.encode(types.FarmingRequest.create({
        land_ids: targetIds,
        host_gid: toLong(friendGid),
        field_3: 0,
        field_4: 2,
    })).finish();
    try {
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Farming', body, {
            expectedErrorCodes: [1001057],
        });
        const reply = types.FarmingReply.decode(replyBody);
        const results = Array.isArray(reply.results) ? reply.results : [];
        const confirmedLandIds = [...new Set(results.map((result) => toNum(result && result.land_id)).filter((id) => id > 0))];
        const operationLimits = Array.isArray(reply.operation_limits) ? reply.operation_limits : [];
        const dogSkillGiftCount = getFarmingSkillGiftCount(reply);
        schedulerRef().updateOperationLimits(operationLimits);
        if (stopWhenExpLimit && results.length > 0) {
            await sleep(200);
            const afterExp = toNum((getUserState() || {}).exp);
            if (afterExp <= beforeExp)
                schedulerRef().autoDisableHelpByExpLimit();
        }
        if (dogSkillGiftCount > 0) {
            log('好友', `帮助好友触发护主犬“同气连枝”，自动获得礼包 x${dogSkillGiftCount}`, {
                module: 'friend',
                event: '同气连枝礼包',
                result: 'ok',
                friendGid,
                count: dogSkillGiftCount,
            });
        }
        return {
            effect: results.length > 0 ? 'confirmed' : 'uncertain',
            operationCount: results.length,
            landCount: confirmedLandIds.length,
            landIds: confirmedLandIds,
            operationLimits,
            dogSkillGiftCount,
            raw: reply,
        };
    }
    catch (e) {
        if (e instanceof GatewayError && e.code === 1001057) {
            return {
                effect: 'noop',
                operationCount: 0,
                landCount: 0,
                landIds: [],
                operationLimits: [],
                dogSkillGiftCount: 0,
                code: e.code,
            };
        }
        throw e;
    }
}
async function stealHarvest(friendGid, landIds) {
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    const reply = types.HarvestReply.decode(replyBody);
    schedulerRef().updateOperationLimits(reply.operation_limits);
    return reply;
}
async function putPlantItems(friendGid, landIds, RequestType, ReplyType, method) {
    const result = await putPlantItemsDetailed(friendGid, landIds, RequestType, ReplyType, method);
    if (result.failed.length > 0 && !result.limitReached) {
        log('好友', `放虫/放草部分失败: ${result.failed[0].reason}`, {
            module: 'friend',
            event: '放虫放草失败',
            method,
            failedCount: result.failed.length,
        });
    }
    return result.ok;
}
async function putPlantItemsDetailed(friendGid, landIds, RequestType, ReplyType, method) {
    const ids = [...new Set((Array.isArray(landIds) ? landIds : [])
            .map((id) => toNum(id))
            .filter((id) => id > 0))];
    if (ids.length === 0)
        return { ok: 0, failed: [] };
    if (schedulerRef().isBadOperationLimitReached()) {
        return {
            ok: 0,
            limitReached: true,
            failed: ids.map((id) => ({ landId: id, reason: '今日放虫/放草次数已达上限' })),
        };
    }
    let ok = 0;
    const failed = [];
    for (let index = 0; index < ids.length; index++) {
        const landId = ids[index];
        if (schedulerRef().isBadOperationLimitReached() || schedulerRef().getRemainingBadOperationTimes() <= 0) {
            schedulerRef().markBadOperationLimitReached('operation_limit');
            failed.push(...ids.slice(index).map((id) => ({ landId: id, reason: '今日放虫/放草次数已达上限' })));
            break;
        }
        try {
            // The game client sends one PutWeeds/PutInsects request per land.
            const body = RequestType.encode(RequestType.create({
                land_ids: [toLong(landId)],
                host_gid: toLong(friendGid),
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body, {
                expectedErrorCodes: [1001046],
            });
            const reply = ReplyType.decode(replyBody);
            schedulerRef().updateOperationLimits(reply.operation_limits);
            const confirmed = (Array.isArray(reply.land) ? reply.land : [])
                .some((land) => toNum(land && land.id) === landId);
            if (confirmed)
                ok++;
            else
                failed.push({ landId, reason: '土地状态未更新，请稍后重试' });
        }
        catch (e) {
            const limitReached = e instanceof GatewayError && e.code === 1001046;
            if (limitReached) {
                schedulerRef().markBadOperationLimitReached(method);
                failed.push(...ids.slice(index).map((id) => ({ landId: id, reason: '今日放虫/放草次数已达上限' })));
                break;
            }
            failed.push({ landId, reason: e && e.message ? e.message : '未知错误' });
        }
        if (index < ids.length - 1 && !schedulerRef().isBadOperationLimitReached()) {
            await randomDelay(80, 160);
        }
    }
    const limitReached = schedulerRef().isBadOperationLimitReached();
    return { ok, failed, ...(limitReached ? { limitReached: true } : {}) };
}
async function putInsects(friendGid, landIds) {
    return putPlantItems(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}
async function putWeeds(friendGid, landIds) {
    return putPlantItems(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}
async function putInsectsDetailed(friendGid, landIds) {
    return putPlantItemsDetailed(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}
async function putWeedsDetailed(friendGid, landIds) {
    return putPlantItemsDetailed(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}
// 使用社交道具（如友谊果实）
async function putSocialItem(friendGid, landId, itemId) {
    const body = types.PutSocialItemRequest.encode(types.PutSocialItemRequest.create({
        host_gid: toLong(friendGid),
        land_id: toLong(landId),
        item_id: toLong(itemId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'PutSocialItem', body);
    return types.PutSocialItemReply.decode(replyBody);
}
//# sourceMappingURL=api.js.map