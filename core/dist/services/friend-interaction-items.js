"use strict";
/** 特殊互动道具：库存发现、协议适配与顺序批量使用（好友农场与自己农场共用）。 */
Object.defineProperty(exports, "__esModule", { value: true });
const LongModule = require('long');
const { PlantPhase } = require('../config/config');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { isSellConditionSatisfied } = require('../config/sell-conditions');
const { sendMsgAsync, getUserState, GatewayError } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');
const { getSellConditionContext } = require('./activity-windows');
const { getAllLands } = require('./farm/api');
const { buildLandMap, buildLandDetail, getCurrentPhase, getDisplayLandContext, getPlantInteractionEffects, } = require('./farm/land-analysis');
const { enterFriendFarm, leaveFriendFarm } = require('./friend/api');
const { getBag, getBagItems } = require('./warehouse');
const SPECIAL_INTERACTION_TYPE = 'additemuseitem';
const MAX_BATCH_LANDS = 48;
const MAX_SIGNED_INT64 = 9223372036854775807n;
const FRIEND_FARM_ITEM_IDS = new Set([5005]);
/**
 * 可以对自己农场使用的互动道具白名单。
 * 种草、黄金虫、足球一类只能作用于他人农场，官方客户端也不提供自用入口，
 * 因此这里逐个登记，而不是按 interaction_type 放行。
 */
const SELF_USABLE_INTERACTION_ITEM_IDS = new Set([
    5003, // 闪电变异瓶：自己的未成熟 1*1 作物。
    301103, // 七夕活动土地道具，展示名称由 ItemInfo 提供。
]);
class FriendInteractionBusinessError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'FriendInteractionBusinessError';
        this.code = code;
    }
}
function businessError(code, message) {
    return new FriendInteractionBusinessError(code, message);
}
function int64String(value) {
    if (value == null)
        return '0';
    if (LongModule.isLong(value))
        return value.toString();
    const text = String(value).trim();
    return /^-?\d+$/.test(text) ? text : '0';
}
function positiveDecimal(value, code, fieldName) {
    const normalized = int64String(value);
    if (!/^[1-9]\d*$/.test(normalized) || normalized.length > 19 || BigInt(normalized) > MAX_SIGNED_INT64) {
        throw businessError(code, `${fieldName} 必须是 int64 范围内的正十进制整数`);
    }
    return normalized;
}
function safePositiveNumber(value, code, fieldName) {
    const normalized = positiveDecimal(value, code, fieldName);
    const numeric = Number(normalized);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        throw businessError(code, `${fieldName} 超出当前客户端可处理范围`);
    }
    return numeric;
}
function normalizeLandIds(value) {
    const source = Array.isArray(value) ? value : [value];
    const unique = new Set();
    for (const entry of source) {
        unique.add(positiveDecimal(entry, 'INVALID_FRIEND_INTERACTION_LAND_IDS', 'landIds'));
    }
    if (unique.size === 0) {
        throw businessError('INVALID_FRIEND_INTERACTION_LAND_IDS', '至少选择一块地');
    }
    if (unique.size > MAX_BATCH_LANDS) {
        throw businessError('INVALID_FRIEND_INTERACTION_LAND_IDS', `单次最多选择 ${MAX_BATCH_LANDS} 块地`);
    }
    return [...unique].sort((left, right) => {
        const leftId = BigInt(left);
        const rightId = BigInt(right);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}
function isFriendLandInteractionMetadata(info) {
    if (!info || typeof info !== 'object')
        return false;
    if (Number(info.type) !== 23 || Number(info.can_use) <= 0)
        return false;
    if (String(info.interaction_type || '').trim().toLowerCase() !== SPECIAL_INTERACTION_TYPE)
        return false;
    const id = Number(info.id) || 0;
    if (id === 301101 || id === 301102 || id === 301103)
        return true;
    // 排除同属 additemuseItem、但描述明确只作用于自己作物的物品。
    const targetDescription = `${String(info.desc || '')} ${String(info.effectDesc || '')}`;
    return /好友|他人/.test(targetDescription);
}
function isLandInteractionMetadata(info) {
    if (!info || typeof info !== 'object')
        return false;
    return Number(info.type) === 23
        && Number(info.can_use) > 0
        && String(info.interaction_type || '').trim().toLowerCase() === SPECIAL_INTERACTION_TYPE;
}
function isFriendFarmInteractionMetadata(info) {
    const itemId = Number(info?.id) || 0;
    return !!info && Number(info.type) === 23 && Number(info.can_use) > 0 && FRIEND_FARM_ITEM_IDS.has(itemId);
}
function isSelfLandInteractionMetadata(info) {
    if (!isLandInteractionMetadata(info))
        return false;
    return SELF_USABLE_INTERACTION_ITEM_IDS.has(Number(info.id) || 0);
}
function getStackExpireTime(stack) {
    return toNum(stack?.expire_time ?? stack?.expireTime);
}
function isStackSaleConditionSatisfied(info, stack, baseContext) {
    const condition = String(info?.sell_cond || '').trim();
    if (!condition)
        return false;
    return isSellConditionSatisfied(condition, {
        ...baseContext,
        expireTime: getStackExpireTime(stack),
    });
}
function eligibleStacksForItem(bagItems, itemId, info, baseContext) {
    return (Array.isArray(bagItems) ? bagItems : [])
        .filter((stack) => (toNum(stack?.id ?? stack?.item_id) === itemId
        && toNum(stack?.uid) > 0
        && toNum(stack?.count) > 0
        && !stack?.locked))
        .map((stack) => ({
        raw: stack,
        remaining: Math.max(0, toNum(stack?.count)),
        expireTime: getStackExpireTime(stack),
        saleConditionSatisfied: isStackSaleConditionSatisfied(info, stack, baseContext),
    }))
        .sort((left, right) => {
        const leftExpire = left.expireTime > 0 ? left.expireTime : Number.MAX_SAFE_INTEGER;
        const rightExpire = right.expireTime > 0 ? right.expireTime : Number.MAX_SAFE_INTEGER;
        return leftExpire - rightExpire;
    });
}
function buildInteractionItemDto(info, stacks, targetKind = 'land') {
    const count = stacks.reduce((sum, stack) => sum + Math.max(0, Number(stack.remaining) || 0), 0);
    const saleConditionSatisfiedCount = stacks
        .filter((stack) => stack.saleConditionSatisfied)
        .reduce((sum, stack) => sum + Math.max(0, Number(stack.remaining) || 0), 0);
    const expirations = stacks
        .map((stack) => Number(stack.expireTime) || 0)
        .filter((expireTime) => expireTime > 0)
        .sort((left, right) => left - right);
    const itemId = Number(info.id) || 0;
    return {
        id: String(itemId),
        itemId: String(itemId),
        name: String(info.name || `物品${itemId}`),
        image: getItemImageById(itemId) || '',
        count,
        saleConditionSatisfiedCount,
        interactionType: String(info.interaction_type || ''),
        protocol: 'item-use',
        selfUsable: SELF_USABLE_INTERACTION_ITEM_IDS.has(itemId),
        targetKind,
        description: String(info.desc || info.effectDesc || ''),
        activityId: info.activity_id == null ? '' : String(info.activity_id),
        sellCondition: String(info.sell_cond || ''),
        nearestExpireTime: expirations[0] || 0,
        serverValidationRequired: true,
    };
}
async function collectInteractionInventory(predicate, targetKind = 'land') {
    const [bagReply, baseContext] = await Promise.all([getBag(), getSellConditionContext()]);
    const bagItems = getBagItems(bagReply);
    const itemIds = new Set();
    for (const stack of (Array.isArray(bagItems) ? bagItems : [])) {
        const itemId = toNum(stack?.id ?? stack?.item_id);
        if (itemId > 0 && toNum(stack?.count) > 0)
            itemIds.add(itemId);
    }
    const items = [];
    const stacksByItemId = new Map();
    for (const itemId of itemIds) {
        const info = getItemById(itemId);
        if (!predicate(info))
            continue;
        const allItemStacks = bagItems.filter((stack) => toNum(stack?.id ?? stack?.item_id) === itemId);
        const stacks = eligibleStacksForItem(allItemStacks, itemId, info, baseContext);
        const dto = buildInteractionItemDto(info, stacks, targetKind);
        if (dto.count <= 0)
            continue;
        stacksByItemId.set(itemId, stacks);
        items.push(dto);
    }
    items.sort((left, right) => {
        if (right.count !== left.count)
            return right.count - left.count;
        return Number(left.itemId) - Number(right.itemId);
    });
    return { items, stacksByItemId };
}
async function getFriendInteractionItems() {
    const [landInventory, farmInventory] = await Promise.all([
        collectInteractionInventory(isFriendLandInteractionMetadata, 'land'),
        collectInteractionInventory(isFriendFarmInteractionMetadata, 'farm'),
    ]);
    const items = [...landInventory.items, ...farmInventory.items];
    return {
        items,
        count: items.length,
        serverValidationRequired: true,
        confirmationRequired: true,
        message: items.length > 0
            ? '请选择好友农场或土地使用'
            : '背包中暂无可用于好友农场的特殊互动道具',
    };
}
async function getSelfInteractionItems() {
    const inventory = await collectInteractionInventory(isSelfLandInteractionMetadata, 'land');
    const items = inventory.items.filter((item) => item.selfUsable);
    return {
        items,
        count: items.length,
        serverValidationRequired: true,
        confirmationRequired: true,
        message: items.length > 0
            ? '请选择自己农场中符合条件的土地使用'
            : '背包中暂无可对自己农场使用的特殊互动道具',
    };
}
function hasInteractionItem(detail, itemId) {
    return (Array.isArray(detail?.interactionEffects) ? detail.interactionEffects : [])
        .some((effect) => String(effect?.itemId || '') === String(itemId));
}
function isEligibleInteractionTarget(itemId, detail, currentPhase) {
    const phase = toNum(currentPhase?.phase);
    const rarity = toNum(detail?.rarity);
    const mutantIds = new Set((Array.isArray(detail?.mutantConfigIds) ? detail.mutantConfigIds : []).map(String));
    if (itemId === 5003) {
        return phase >= PlantPhase.GERMINATION
            && phase <= PlantPhase.BLOOMING
            && toNum(detail?.plantSize) === 1
            && rarity !== 4
            && rarity !== 5
            && !mutantIds.has('12');
    }
    if (itemId === 5004) {
        return phase >= PlantPhase.GERMINATION
            && phase <= PlantPhase.BLOOMING
            && rarity !== 4
            && rarity !== 5
            && !hasInteractionItem(detail, itemId);
    }
    if (itemId === 5006 || itemId === 301101 || itemId === 301102 || itemId === 301103) {
        return phase >= PlantPhase.SEED && phase <= PlantPhase.BLOOMING && !hasInteractionItem(detail, itemId);
    }
    return phase !== PlantPhase.DEAD;
}
function buildTargetLandMap(landsInput, itemId, friendMode) {
    const lands = Array.isArray(landsInput) ? landsInput : [];
    const landsMap = buildLandMap(lands);
    const targets = new Map();
    for (const land of lands) {
        if (!land?.unlocked)
            continue;
        const context = getDisplayLandContext(land, landsMap);
        if (context.occupiedByMaster)
            continue;
        const sourceLand = context.sourceLand || land;
        const landId = toNum(sourceLand?.id);
        if (landId <= 0 || targets.has(String(landId)))
            continue;
        const plant = sourceLand?.plant;
        if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0)
            continue;
        const currentPhase = getCurrentPhase(plant.phases, false, '');
        const detail = buildLandDetail(sourceLand, { friendMode, landsMap });
        if (!isEligibleInteractionTarget(itemId, detail, currentPhase))
            continue;
        targets.set(String(landId), {
            landId: String(landId),
            plantId: int64String(plant.id),
            occupiedLandIds: (Array.isArray(context.occupiedLandIds) ? context.occupiedLandIds : [landId])
                .map((id) => String(toNum(id)))
                .filter((id) => id !== '0'),
            detail,
        });
    }
    return targets;
}
function currentStack(stacks) {
    return stacks.find((stack) => Number(stack.remaining) > 0) || null;
}
async function sendTargetedItemUse(itemId, stack, friendGid, landId) {
    const request = types.UseRequest.create({
        item: {
            id: itemId,
            count: 1,
            uid: stack.raw.uid,
        },
        target: {
            host_gid: friendGid,
            land_ids: [landId],
            use_config_id: 0,
        },
    });
    const body = Buffer.from(types.UseRequest.encode(request).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
    return types.UseReply.decode(replyBody);
}
async function sendFriendFarmItemUse(itemId, stack, friendGid) {
    const request = types.UseRequest.create({
        item: { id: itemId, count: 1, uid: stack.raw.uid },
        target: { host_gid: friendGid, use_config_id: 0 },
    });
    const body = Buffer.from(types.UseRequest.encode(request).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
    return types.UseReply.decode(replyBody);
}
function normalizedErrorCode(error) {
    return String(error?.code || String(error?.message || '').match(/\bcode=(\d+)\b/)?.[1] || 'FRIEND_INTERACTION_USE_FAILED');
}
function interactionFailure(itemName, landId, error, target = null) {
    const code = normalizedErrorCode(error);
    const knownMessages = {
        '1001065': `该地块当前不符合${itemName}的使用条件，作物品级或状态可能已变化`,
        '1003008': `该农场当前已达到${itemName}的使用限制`,
        FRIEND_INTERACTION_TARGET_UNAVAILABLE: '该地块已经没有可互动的作物',
    };
    const serverMessage = String(error?.errorMessage || '').trim();
    const businessMessage = error instanceof FriendInteractionBusinessError ? String(error.message || '') : '';
    return {
        landId,
        ok: false,
        code,
        message: knownMessages[code] || businessMessage || serverMessage || `服务器未接受该地块的${itemName}使用请求`,
        target,
    };
}
function normalizeReplyItems(itemsInput) {
    return (Array.isArray(itemsInput) ? itemsInput : []).map((item) => ({
        id: int64String(item?.id ?? item?.item_id),
        count: int64String(item?.count),
        landId: int64String(item?.land_id),
    }));
}
function interactionItemName(itemId, info) {
    return String(info?.name || getItemById(itemId)?.name || `道具${itemId}`);
}
function normalizeUpdatedLand(rawLand, target = null, friendMode = true) {
    if (!rawLand || typeof rawLand !== 'object')
        return null;
    let detail;
    try {
        detail = buildLandDetail(rawLand, { friendMode });
    }
    catch {
        detail = {
            id: toNum(rawLand.id),
            unlocked: !!rawLand.unlocked,
            status: 'growing',
            plantName: String(rawLand?.plant?.name || ''),
            occupiedLandIds: [],
            mutantConfigIds: [],
            mutantEffects: [],
            isMutated: false,
            interactionEffects: [],
        };
    }
    if (target && Array.isArray(target.occupiedLandIds) && target.occupiedLandIds.length > 0) {
        detail.occupiedLandIds = [...new Set(target.occupiedLandIds.map((id) => String(id)))];
    }
    return detail;
}
function buildConfirmedInteractionEffects(rawLand, itemId, landId, itemName) {
    const itemActivityId = toNum(getItemById(itemId)?.activity_id);
    const protocolEffects = typeof getPlantInteractionEffects === 'function'
        ? getPlantInteractionEffects(rawLand?.plant)
        : [];
    const matched = protocolEffects
        .filter((effect) => (String(effect.itemId || '') === String(itemId)
        && (!effect.landId || String(effect.landId) === String(landId))))
        .map((effect) => ({
        ...effect,
        landId: String(effect.landId || landId),
        itemId: String(effect.itemId || itemId),
        itemName: String(effect.itemName || itemName),
        activityId: toNum(effect.activityId) || itemActivityId,
        plantId: int64String(rawLand?.plant?.id),
        confirmed: true,
    }));
    if (matched.length > 0)
        return matched;
    return [{
            landId: String(landId),
            itemId: String(itemId),
            itemName,
            activityId: itemActivityId,
            plantId: int64String(rawLand?.plant?.id),
            effectType: 0,
            confirmed: true,
            source: 'use-reply',
        }];
}
/** 读取并校验本次批量使用要消耗的库存，返回按过期时间排序的可用堆叠。 */
async function resolveUsableStacks(itemId, info, landCount) {
    const inventory = await collectInteractionInventory((candidate) => isLandInteractionMetadata(candidate) || isFriendFarmInteractionMetadata(candidate), 'land');
    const stacks = inventory.stacksByItemId.get(itemId) || [];
    const available = stacks.reduce((sum, stack) => sum + Math.max(0, Number(stack.remaining) || 0), 0);
    if (available <= 0) {
        throw businessError('FRIEND_INTERACTION_ITEM_UNAVAILABLE', `${info.name || `物品${itemId}`}当前没有可提交服务器校验的库存`);
    }
    if (landCount > available) {
        throw businessError('FRIEND_INTERACTION_SELECTION_EXCEEDS_BALANCE', `已选择 ${landCount} 块地，但当前只有 ${available} 个${info.name || `物品${itemId}`}`);
    }
    return stacks;
}
/**
 * 在同一次农场会话内按地块编号顺序逐块提交道具使用。
 * 好友农场由调用方负责 Enter/Leave，自己农场直接使用 AllLands 快照。
 */
async function runInteractionBatch(itemId, info, stacks, hostGid, landsInput, landIds, friendMode = true) {
    const itemName = String(info.name || `物品${itemId}`);
    const targetMap = buildTargetLandMap(landsInput, itemId, friendMode);
    const attempts = [];
    for (let index = 0; index < landIds.length; index += 1) {
        const landId = landIds[index];
        const target = targetMap.get(landId) || null;
        if (!target) {
            attempts.push(interactionFailure(itemName, landId, businessError('FRIEND_INTERACTION_TARGET_UNAVAILABLE', '所选地块已无可互动作物')));
            continue;
        }
        const stack = currentStack(stacks);
        if (!stack) {
            attempts.push(interactionFailure(itemName, landId, businessError('FRIEND_INTERACTION_ITEM_DEPLETED', '本次可用库存已经用完'), target));
            continue;
        }
        try {
            const reply = await sendTargetedItemUse(itemId, stack, hostGid, landId);
            stack.remaining -= 1;
            const updatedLand = normalizeUpdatedLand(reply?.land, target, friendMode);
            const interactionEffects = buildConfirmedInteractionEffects(reply?.land, itemId, landId, interactionItemName(itemId, info));
            attempts.push({
                landId,
                ok: true,
                code: '',
                message: `第 ${landId} 块地使用成功`,
                target,
                updatedLand,
                interactionEffects,
                consumed: normalizeReplyItems(reply?.consumed || reply?.used_items || []),
                rewards: normalizeReplyItems([
                    ...(Array.isArray(reply?.rewards) ? reply.rewards : []),
                    ...(Array.isArray(reply?.items) ? reply.items : []),
                    ...(Array.isArray(reply?.land_reward?.items) ? reply.land_reward.items : []),
                ]),
            });
        }
        catch (error) {
            attempts.push(interactionFailure(itemName, landId, error, target));
            const gatewayFailure = typeof GatewayError === 'function' && error instanceof GatewayError;
            if (!gatewayFailure && !(error instanceof FriendInteractionBusinessError)) {
                for (const remainingLandId of landIds.slice(index + 1)) {
                    attempts.push({
                        landId: remainingLandId,
                        ok: false,
                        code: 'FRIEND_INTERACTION_BATCH_ABORTED',
                        message: '前序请求被中断，本地未继续提交该地块',
                        target: targetMap.get(remainingLandId) || null,
                    });
                }
                break;
            }
        }
    }
    return attempts;
}
async function performFriendInteractionItemBatch(friendGidInput, itemIdInput, landIdsInput) {
    const friendGid = positiveDecimal(friendGidInput, 'INVALID_FRIEND_INTERACTION_GID', 'friendGid');
    const friendGidNumber = safePositiveNumber(friendGid, 'INVALID_FRIEND_INTERACTION_GID', 'friendGid');
    const itemId = safePositiveNumber(itemIdInput, 'INVALID_FRIEND_INTERACTION_ITEM_ID', 'itemId');
    const landIds = normalizeLandIds(landIdsInput);
    const info = getItemById(itemId);
    if (!isFriendLandInteractionMetadata(info)) {
        throw businessError('FRIEND_INTERACTION_ITEM_UNSUPPORTED', '该物品不是可用于好友土地的特殊互动道具');
    }
    const stacks = await resolveUsableStacks(itemId, info, landIds.length);
    const enterReply = await enterFriendFarm(friendGidNumber);
    let attempts = [];
    try {
        const actualGid = int64String(enterReply?.basic?.gid);
        if (actualGid !== '0' && actualGid !== friendGid) {
            throw businessError('FRIEND_INTERACTION_HOST_MISMATCH', '进入的好友农场与所选 GID 不一致');
        }
        attempts = await runInteractionBatch(itemId, info, stacks, friendGid, enterReply?.lands || [], landIds);
    }
    finally {
        await leaveFriendFarm(friendGidNumber);
    }
    const succeeded = attempts.filter((attempt) => attempt.ok);
    const failed = attempts.filter((attempt) => !attempt.ok);
    const ownerName = String(enterReply?.basic?.remark || enterReply?.basic?.name || `GID:${friendGid}`);
    const itemName = String(info.name || `物品${itemId}`);
    const refreshedInventory = await getFriendInteractionItems();
    const updatedLands = succeeded
        .map((attempt) => attempt.updatedLand)
        .filter((land) => !!land);
    const interactionEffects = succeeded.flatMap((attempt) => (Array.isArray(attempt.interactionEffects) ? attempt.interactionEffects : []));
    return {
        hostGid: friendGid,
        ownerName,
        itemId: String(itemId),
        itemName,
        protocol: 'item-use',
        requestedLandIds: landIds,
        usedLandIds: succeeded.map((attempt) => attempt.landId),
        failedLandIds: failed.map((attempt) => attempt.landId),
        successCount: succeeded.length,
        failureCount: failed.length,
        results: attempts,
        updatedLands,
        interactionEffects,
        items: refreshedInventory.items,
        message: failed.length > 0
            ? `已在${ownerName}的农场按顺序使用 ${succeeded.length} 个${itemName}，跳过 ${failed.length} 块地`
            : `已在${ownerName}的农场按顺序使用 ${succeeded.length} 个${itemName}`,
    };
}
async function performFriendFarmInteractionItem(friendGidInput, itemIdInput) {
    const friendGid = positiveDecimal(friendGidInput, 'INVALID_FRIEND_INTERACTION_GID', 'friendGid');
    const friendGidNumber = safePositiveNumber(friendGid, 'INVALID_FRIEND_INTERACTION_GID', 'friendGid');
    const itemId = safePositiveNumber(itemIdInput, 'INVALID_FRIEND_INTERACTION_ITEM_ID', 'itemId');
    const info = getItemById(itemId);
    if (!isFriendFarmInteractionMetadata(info)) {
        throw businessError('FRIEND_INTERACTION_ITEM_UNSUPPORTED', '该物品不是可用于好友农场的特殊互动道具');
    }
    const stacks = await resolveUsableStacks(itemId, info, 1);
    const stack = currentStack(stacks);
    if (!stack)
        throw businessError('FRIEND_INTERACTION_ITEM_UNAVAILABLE', `${info.name || `物品${itemId}`}当前没有可用库存`);
    const enterReply = await enterFriendFarm(friendGidNumber);
    try {
        const actualGid = int64String(enterReply?.basic?.gid);
        if (actualGid !== '0' && actualGid !== friendGid) {
            throw businessError('FRIEND_INTERACTION_HOST_MISMATCH', '进入的好友农场与所选 GID 不一致');
        }
        await sendFriendFarmItemUse(itemId, stack, friendGid);
        const itemName = String(info.name || `物品${itemId}`);
        return {
            hostGid: friendGid,
            ownerName: String(enterReply?.basic?.remark || enterReply?.basic?.name || `GID:${friendGid}`),
            itemId: String(itemId),
            itemName,
            targetKind: 'farm',
            protocol: 'item-use',
            requestedLandIds: [],
            usedLandIds: [],
            failedLandIds: [],
            successCount: 1,
            failureCount: 0,
            results: [{ landId: '', ok: true, code: '', message: `已在好友农场使用${itemName}` }],
            items: (await getFriendInteractionItems()).items,
            message: `已在好友农场使用 1 个${itemName}`,
        };
    }
    finally {
        await leaveFriendFarm(friendGidNumber);
    }
}
function currentAccountGid() {
    const state = getUserState() || {};
    return positiveDecimal(state.gid, 'SELF_INTERACTION_ACCOUNT_UNAVAILABLE', '当前账号 GID');
}
async function performSelfInteractionItemBatch(itemIdInput, landIdsInput) {
    const hostGid = currentAccountGid();
    const itemId = safePositiveNumber(itemIdInput, 'INVALID_FRIEND_INTERACTION_ITEM_ID', 'itemId');
    const landIds = normalizeLandIds(landIdsInput);
    const info = getItemById(itemId);
    if (!isSelfLandInteractionMetadata(info)) {
        throw businessError('SELF_INTERACTION_ITEM_UNSUPPORTED', '该道具只能在好友农场使用，不能对自己的农场使用');
    }
    const stacks = await resolveUsableStacks(itemId, info, landIds.length);
    const landsReply = await getAllLands();
    const attempts = await runInteractionBatch(itemId, info, stacks, hostGid, landsReply?.lands || [], landIds, false);
    const succeeded = attempts.filter((attempt) => attempt.ok);
    const failed = attempts.filter((attempt) => !attempt.ok);
    const itemName = String(info.name || `物品${itemId}`);
    const refreshedInventory = await getSelfInteractionItems();
    const updatedLands = succeeded
        .map((attempt) => attempt.updatedLand)
        .filter((land) => !!land);
    const interactionEffects = succeeded.flatMap((attempt) => (Array.isArray(attempt.interactionEffects) ? attempt.interactionEffects : []));
    return {
        hostGid,
        ownerName: '我的农场',
        isSelf: true,
        itemId: String(itemId),
        itemName,
        protocol: 'item-use',
        requestedLandIds: landIds,
        usedLandIds: succeeded.map((attempt) => attempt.landId),
        failedLandIds: failed.map((attempt) => attempt.landId),
        successCount: succeeded.length,
        failureCount: failed.length,
        results: attempts,
        updatedLands,
        interactionEffects,
        items: refreshedInventory.items,
        message: failed.length > 0
            ? `已在我的农场按顺序使用 ${succeeded.length} 个${itemName}，跳过 ${failed.length} 块地`
            : `已在我的农场按顺序使用 ${succeeded.length} 个${itemName}`,
    };
}
let mutationTail = Promise.resolve();
function serializeMutation(operation) {
    const run = mutationTail.then(operation, operation);
    mutationTail = run.then(() => undefined, () => undefined);
    return run;
}
function useFriendInteractionItemBatch(friendGidInput, itemIdInput, landIdsInput) {
    return serializeMutation(() => performFriendInteractionItemBatch(friendGidInput, itemIdInput, landIdsInput));
}
function useFriendFarmInteractionItem(friendGidInput, itemIdInput) {
    return serializeMutation(() => performFriendFarmInteractionItem(friendGidInput, itemIdInput));
}
function useSelfInteractionItemBatch(itemIdInput, landIdsInput) {
    return serializeMutation(() => performSelfInteractionItemBatch(itemIdInput, landIdsInput));
}
module.exports = {
    MAX_BATCH_LANDS,
    SELF_USABLE_INTERACTION_ITEM_IDS,
    isFriendLandInteractionMetadata,
    isSelfLandInteractionMetadata,
    getFriendInteractionItems,
    getSelfInteractionItems,
    useFriendInteractionItemBatch,
    useFriendFarmInteractionItem,
    useSelfInteractionItemBatch,
};
//# sourceMappingURL=friend-interaction-items.js.map