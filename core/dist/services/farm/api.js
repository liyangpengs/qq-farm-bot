"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 低级农场 API - protobuf 请求、商店、铲除
 */
const protobuf = require('protobufjs');
const { sendMsgAsync, getUserState } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { toLong, toNum, sleep, randomDelay, logWarn } = require('../../utils/utils');
// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate = null;
function setOperationLimitsCallback(callback) {
    onOperationLimitsUpdate = callback;
}
/**
 * 通用植物操作请求
 */
async function sendPlantRequest(RequestType, ReplyType, method, landIds, hostGid) {
    const body = RequestType.encode(RequestType.create({
        land_ids: landIds,
        host_gid: toLong(hostGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
    return ReplyType.decode(replyBody);
}
async function getAllLands() {
    const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
    const reply = types.AllLandsReply.decode(replyBody);
    // 更新操作限制
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}
async function harvest(landIds) {
    const state = getUserState();
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}
async function waterLand(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.WaterLandRequest, types.WaterLandReply, 'WaterLand', landIds, state.gid);
}
async function farming(landIds, socialEventItemIds = []) {
    const state = getUserState();
    const body = encodeOwnFarmingRequest(landIds, state.gid, socialEventItemIds);
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Farming', body);
    return types.FarmingReply.decode(replyBody);
}
/**
 * 自家单点/一键务农。官方抓包会显式编码两个值为 0 的场景字段；不能依赖 proto3 默认省略。
 * 青蛙使坏瓶属于农场级社交事件，存在时还会以 packed int64 写入 field 5。
 * 好友帮助务农使用 field_4=2，由 friend/api.ts 单独编码。
 */
function encodeOwnFarmingRequest(landIds, hostGid, socialEventItemIds = []) {
    const normalizedSocialEventItemIds = [...new Set((Array.isArray(socialEventItemIds) ? socialEventItemIds : [])
            .map((value) => toNum(value))
            .filter((value) => value > 0))];
    return types.FarmingRequest.encode(types.FarmingRequest.create({
        land_ids: landIds,
        host_gid: toLong(hostGid),
        field_3: 0,
        field_4: 0,
        social_event_item_ids: normalizedSocialEventItemIds.map((value) => toLong(value)),
    })).finish();
}
// 普通肥料 ID
const NORMAL_FERTILIZER_ID = 1011;
// 有机肥料 ID
const ORGANIC_FERTILIZER_ID = 1012;
const MAX_ORGANIC_FERTILIZE_OPERATIONS = 240;
const MAX_ORGANIC_FERTILIZE_ROUNDS = 20;
async function fertilizeOne(landId, fertilizerId = NORMAL_FERTILIZER_ID) {
    const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
        land_ids: [toLong(landId)],
        fertilizer_id: toLong(fertilizerId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
    const reply = types.FertilizeReply.decode(replyBody);
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}
/**
 * 施肥 - 必须逐块进行，服务器不支持批量
 * 游戏中拖动施肥间隔很短，这里用 50ms
 */
async function fertilize(landIds, fertilizerId = NORMAL_FERTILIZER_ID) {
    let successCount = 0;
    for (const landId of landIds) {
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(fertilizerId),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        }
        catch {
            // 施肥失败（可能肥料不足），停止继续
            break;
        }
        if (landIds.length > 1)
            await sleep(50); // 50ms 间隔
    }
    return successCount;
}
/**
 * 有机肥循环施肥:
 * 按地块顺序循环施肥，失败或达到单次操作上限时停止。
 */
async function fertilizeOrganicLoop(landIds) {
    const ids = (Array.isArray(landIds) ? landIds : []).filter(Boolean);
    if (ids.length === 0)
        return 0;
    let successCount = 0;
    let idx = 0;
    const operationLimit = Math.min(MAX_ORGANIC_FERTILIZE_OPERATIONS, ids.length * MAX_ORGANIC_FERTILIZE_ROUNDS);
    while (successCount < operationLimit) {
        const landId = ids[idx];
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(ORGANIC_FERTILIZER_ID),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        }
        catch {
            // 常见是有机肥耗尽，按需求直接停止
            break;
        }
        idx = (idx + 1) % ids.length;
        await randomDelay(1000, 1500);
    }
    if (successCount >= operationLimit) {
        logWarn('施肥', `有机肥循环达到单次上限 ${operationLimit}，已停止继续请求`);
    }
    return successCount;
}
async function removePlant(landIds) {
    const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
        land_ids: landIds.map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    return types.RemovePlantReply.decode(replyBody);
}
async function upgradeLand(landId) {
    const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
        land_id: toLong(landId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
    return types.UpgradeLandReply.decode(replyBody);
}
async function unlockLand(landId, doShared = false) {
    const body = types.UnlockLandRequest.encode(types.UnlockLandRequest.create({
        land_id: toLong(landId),
        do_shared: !!doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UnlockLand', body);
    return types.UnlockLandReply.decode(replyBody);
}
// ============ 商店 API ============
async function getShopInfo(shopId) {
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
        shop_id: toLong(shopId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    return types.ShopInfoReply.decode(replyBody);
}
async function buyGoods(goodsId, num, price) {
    const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
        goods_id: toLong(goodsId),
        num: toLong(num),
        price: toLong(price),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
    return types.BuyGoodsReply.decode(replyBody);
}
// ============ 变异图鉴 ============
async function readMutantBook() {
    const body = types.ReadMutantBookRequest.encode(types.ReadMutantBookRequest.create({})).finish();
    await sendMsgAsync('gamepb.mutantpb.MutantService', 'ReadMutantBook', body);
}
// ============ 种植编码 ============
function encodePlantRequest(seedId, landIds) {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}
module.exports = {
    setOperationLimitsCallback,
    sendPlantRequest,
    getAllLands,
    harvest,
    waterLand,
    farming,
    encodeOwnFarmingRequest,
    fertilizeOne,
    fertilize,
    fertilizeOrganicLoop,
    removePlant,
    upgradeLand,
    unlockLand,
    getShopInfo,
    buyGoods,
    encodePlantRequest,
    readMutantBook,
};
//# sourceMappingURL=api.js.map