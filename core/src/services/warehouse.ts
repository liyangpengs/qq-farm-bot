import type { SellConditionContext } from '../config/sell-conditions';

export {};
/**
 * 仓库系统 - 自动出售果实
 * 协议说明：BagReply 使用 item_bag（ItemBag），item_bag.items 才是背包物品列表
 */
const { getFruitName, getPlantByFruitId, getPlantBySeedId, getItemById, getItemImageById, getSeedImageBySeedId, getEffectiveSellInfo, getMutantEffectsByIds } = require('../config/gameConfig');
const { isAutomationOn } = require('../models/store');
const { sendMsgAsync, networkEvents, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, toTimeSec, log, logWarn, sleep, getSystemDateKey } = require('../utils/utils');
const { getSellConditionContext } = require('./activity-windows');
const { updateStatusGold } = require('./status');

const SELL_BATCH_SIZE: number = 15;
const LOCKABLE_ITEM_TYPES: Set<number> = new Set([17, 6, 5]);
const FERTILIZER_RELATED_IDS: Set<number> = new Set([
    100003, // 化肥礼包
    100004, // 有机化肥礼包
    80001, 80002, 80003, 80004, // 普通化肥道具
    80011, 80012, 80013, 80014, // 有机化肥道具
]);
const FERTILIZER_CONTAINER_LIMIT_HOURS: number = 990;
const NORMAL_CONTAINER_ID: number = 1011;
const ORGANIC_CONTAINER_ID: number = 1012;
const CHARITY_SETTLEMENT_GIFT_ID: number = 101604;
const SPECIAL_GIFT_CHECK_COOLDOWN_MS: number = 5 * 60 * 1000;
const NORMAL_FERTILIZER_ITEM_HOURS: Map<number, number> = new Map([
    [80001, 1], [80002, 4], [80003, 8], [80004, 12],
]);
const ORGANIC_FERTILIZER_ITEM_HOURS: Map<number, number> = new Map([
    [80011, 1], [80012, 4], [80013, 8], [80014, 12],
]);
let fertilizerGiftDoneDateKey: string = '';
let fertilizerGiftLastOpenAt: number = 0;
let charitySettlementGiftLastOpenAt: number = 0;
let pendingBagRequest: Promise<any> | null = null;

// ============ API ============

async function getBag(options: { fresh?: boolean } = {}): Promise<any> {
    if (!options.fresh && pendingBagRequest) return pendingBagRequest;

    const request = (async () => {
        const body: Uint8Array = types.BagRequest.encode(types.BagRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Bag', body);
        return types.BagReply.decode(replyBody);
    })();
    pendingBagRequest = request;
    try {
        return await request;
    } finally {
        if (pendingBagRequest === request) pendingBagRequest = null;
    }
}

function toSellItem(item: any): any {
    const idNum: number = toNum(item && item.id);
    const countNum: number = toNum(item && item.count);
    const uidNum: number = toNum(item && item.uid);
    const payload: any = {
        id: toLong(idNum),
        count: toLong(countNum),
    };
    // SellRequest 通常只需要 id + count；仅在 uid 有效时携带
    if (uidNum > 0) payload.uid = toLong(uidNum);
    return payload;
}

async function sellItems(items: any[]): Promise<any> {
    const requested: any[] = Array.isArray(items) ? items : [];
    if (requested.length === 0) throw new Error('没有可出售的物品');
    const baseContext: SellConditionContext = await getSellConditionContext();
    const bagItems: any[] = getBagItems(await getBag());
    for (const item of requested) {
        const id: number = toNum(item && item.id);
        const count: number = toNum(item && item.count);
        if (id <= 0 || count <= 0) throw new Error('出售物品参数无效');
        const info: any = getItemById(id);
        const bagItem: any | null = findBagItem(bagItems, item);
        if (!bagItem) throw new Error(`背包中未找到${info?.name || `物品${id}`}`);
        if (isItemLocked(bagItem)) throw new Error(`${info?.name || `物品${id}`}已锁定，不能出售`);
        const expireTime: number = hasExpireSellCondition(info)
            ? getItemExpireTime(bagItem)
            : getItemExpireTime(item);
        const sellInfo: any = getEffectiveSellInfo(info, { ...baseContext, expireTime });
        if (!sellInfo.sellable) {
            throw new Error(`${info?.name || `物品${id}`}当前不可出售`);
        }
    }
    const payload: any[] = requested.map(toSellItem);
    const body: Uint8Array = types.SellRequest.encode(types.SellRequest.create({ items: payload })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Sell', body);
    return types.SellReply.decode(replyBody);
}

async function useItem(itemId: number, count: number = 1, landIds: number[] = [], uid: number = 0): Promise<any> {
    if (landIds.length > 0) throw new Error('新版物品使用协议不再接受 landIds');
    const bagReply: any = await getBag();
    const matchingItems: any[] = getBagItems(bagReply).filter((item: any) => (
        toNum(item && item.id) === itemId && (uid <= 0 || toNum(item && item.uid) === uid)
    ));
    const candidates: any[] = matchingItems.filter((item: any) => !isItemLocked(item));
    const available: number = candidates.reduce((sum: number, item: any) => sum + Math.max(0, toNum(item && item.count)), 0);
    if (available < count) {
        const lockedCount: number = matchingItems
            .filter((item: any) => isItemLocked(item))
            .reduce((sum: number, item: any) => sum + Math.max(0, toNum(item && item.count)), 0);
        const suffix: string = lockedCount > 0 ? `，另有 ${lockedCount} 个已锁定` : '';
        throw new Error(`物品可用数量不足: 需要 ${count}，当前 ${available}${suffix}`);
    }
    const item: any = candidates.find((entry: any) => toNum(entry && entry.count) >= count);
    if (!item && candidates.length > 1) {
        let remaining: number = count;
        const items: any[] = [];
        for (const candidate of candidates) {
            const useCount: number = Math.min(remaining, Math.max(0, toNum(candidate && candidate.count)));
            if (useCount <= 0) continue;
            items.push({ itemId, count: useCount, uid: toNum(candidate.uid) });
            remaining -= useCount;
            if (remaining === 0) break;
        }
        return batchUseItems(items);
    }
    if (!item) throw new Error(`背包中未找到物品 ${itemId}`);

    const body: Uint8Array = types.UseRequest.encode(types.UseRequest.create({
        item: {
            id: toLong(itemId),
            count: toLong(count),
            uid: toLong(toNum(item.uid)),
        },
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
    return describeUseReply(types.UseReply.decode(replyBody));
}

function describeUseReply(reply: any): any {
    return { ...reply, rewards: (reply.items || []).map((item: any) => ({
        id: toNum(item.id), count: String(item.count),
        name: getItemById(toNum(item.id))?.name || `物品${item.id}`,
    })) };
}

async function batchUseItems(items: any[]): Promise<any> {
    const payload: any[] = (items || []).map((it: any) => ({
        id: toLong(it.itemId),
        count: toLong(it.count || 1),
        uid: toLong(it.uid || 0),
    }));
    const body: Uint8Array = types.BatchUseRequest.encode(types.BatchUseRequest.create({ items: payload })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', body);
    return describeUseReply(types.BatchUseReply.decode(replyBody));
}

function isFruitItemId(id: number): boolean {
    return !!getPlantByFruitId(Number(id));
}

function getBagItems(bagReply: any): any[] {
    if (bagReply && bagReply.item_bag && bagReply.item_bag.items && bagReply.item_bag.items.length) {
        return bagReply.item_bag.items;
    }
    return bagReply && bagReply.items ? bagReply.items : [];
}

function isItemLocked(item: any): boolean {
    return item?.locked === true || item?.locked === 1 || item?.locked === '1';
}

function isLockableItem(item: any): boolean {
    const id: number = toNum(item?.id);
    const info: any = id > 0 ? getItemById(id) : null;
    return LOCKABLE_ITEM_TYPES.has(Number(info?.type || 0));
}

function normalizeItemUids(values: any[]): number[] {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((value: any) => toNum(value))
        .filter((value: number) => Number.isSafeInteger(value) && value > 0))];
}

async function setItemsLocked(itemUids: any[], locked: boolean): Promise<any> {
    const requestedUids: number[] = normalizeItemUids(itemUids);
    if (requestedUids.length === 0) throw new Error('缺少物品 UID');

    const bagItems: any[] = getBagItems(await getBag());
    const byUid: Map<number, any> = new Map(
        bagItems
            .filter((item: any) => toNum(item?.uid) > 0)
            .map((item: any) => [toNum(item.uid), item]),
    );
    const actionableUids: number[] = [];
    for (const uid of requestedUids) {
        const item: any = byUid.get(uid);
        if (!item) throw new Error(`背包中未找到 UID ${uid}`);
        const info: any = getItemById(toNum(item.id));
        if (!isLockableItem(item)) {
            throw new Error(`${info?.name || `物品${toNum(item.id)}`}不支持锁定`);
        }
        if (isItemLocked(item) !== locked) actionableUids.push(uid);
    }

    if (actionableUids.length === 0) {
        return { locked, changed: 0, itemUids: [] };
    }

    const RequestType: any = locked ? types.LockItemsRequest : types.UnlockItemsRequest;
    const ReplyType: any = locked ? types.LockItemsReply : types.UnlockItemsReply;
    const method: string = locked ? 'LockItems' : 'UnlockItems';
    const body: Uint8Array = RequestType.encode(RequestType.create({
        item_uids: actionableUids.map((uid: number) => toLong(uid)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', method, body);
    const reply: any = ReplyType.decode(replyBody);
    const confirmedUids: number[] = normalizeItemUids(reply?.item_uids);
    return {
        locked,
        changed: confirmedUids.length || actionableUids.length,
        itemUids: confirmedUids.length > 0 ? confirmedUids : actionableUids,
    };
}

function getItemExpireTime(item: any): number {
    if (!item) return 0;
    return toTimeSec(item.expire_time ?? item.expireTime);
}

function getItemSourceInfo(item: any): any | null {
    const source: any = item?.source_info ?? item?.sourceInfo;
    if (!source || typeof source !== 'object') return null;

    const senderName: string = String(source.sender_name ?? source.senderName ?? '').trim();
    const sentAt: number = toTimeSec(source.sent_at ?? source.sentAt);
    // Qixi GiftQixiSachetRequest calls this value msg_text_id. The Bag reply
    // carries the same selector as ItemSourceInfo field 3.
    const messageTextId: number = toNum(source.source_type ?? source.sourceType);
    if (!senderName && sentAt <= 0 && messageTextId <= 0) return null;
    return { senderName, sentAt, messageTextId };
}

function getProtocolSellPrice(item: any): { currencyId: number; price: number } | null {
    const show: any = item?.show;
    const sellPrice: any = show?.sell_price ?? show?.sellPrice;
    const currencyId: number = toNum(sellPrice?.id);
    const price: number = toNum(sellPrice?.count);
    return currencyId > 0 && price > 0 ? { currencyId, price } : null;
}

function hasExpireSellCondition(info: any): boolean {
    return String(info?.sell_cond || '')
        .split(';')
        .some((condition) => condition.trim().startsWith('道具过期后:'));
}

function findBagItem(items: any[], requested: any): any | null {
    const id = toNum(requested?.id);
    const uid = toNum(requested?.uid);
    return (items || []).find((item: any) => (
        toNum(item?.id) === id && (uid <= 0 || toNum(item?.uid) === uid)
    )) || null;
}

function getMutantTypes(item: any): number[] {
    const values: any[] = Array.isArray(item?.mutant_types)
        ? item.mutant_types
        : (Array.isArray(item?.mutantTypes) ? item.mutantTypes : []);
    return values
        .map((value: any) => toNum(value))
        .filter((value: number) => value > 0)
        .sort((left: number, right: number) => left - right);
}

function isFertilizerRelatedItemId(itemId: number): boolean {
    const id: number = Number(itemId) || 0;
    if (id <= 0) return false;
    // 禁止对容器道具执行使用，避免触发 1011/1012 补充逻辑
    if (id === 1011 || id === 1012) return false;
    if (FERTILIZER_RELATED_IDS.has(id)) return true;
    const info: any = getItemById(id);
    if (!info || typeof info !== 'object') return false;
    const interactionType: string = String(info.interaction_type || '').toLowerCase();
    return interactionType === 'fertilizer' || interactionType === 'fertilizerpro';
}

function collectFertilizerUsePayload(items: any[]): Array<{ id: number; count: number }> {
    const merged: Map<number, number> = new Map();
    for (const it of (items || [])) {
        const id: number = toNum(it && it.id);
        const count: number = Math.max(0, toNum(it && it.count));
        if (id <= 0 || count <= 0) continue;
        if (!isFertilizerRelatedItemId(id)) continue;
        merged.set(id, (merged.get(id) || 0) + count);
    }
    return Array.from(merged.entries()).map(([id, count]) => ({ id, count }));
}

function getContainerHoursFromBagItems(items: any[]): { normal: number; organic: number } {
    let normalSec: number = 0;
    let organicSec: number = 0;
    for (const it of (items || [])) {
        const id: number = toNum(it && it.id);
        const count: number = Math.max(0, toNum(it && it.count));
        if (id === NORMAL_CONTAINER_ID) normalSec = count;
        if (id === ORGANIC_CONTAINER_ID) organicSec = count;
    }
    return {
        normal: normalSec / 3600,
        organic: organicSec / 3600,
    };
}

function getFertilizerItemTypeAndHours(itemId: number): { type: string; perItemHours: number } {
    const id: number = Number(itemId) || 0;
    if (NORMAL_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'normal', perItemHours: NORMAL_FERTILIZER_ITEM_HOURS.get(id) as number };
    }
    if (ORGANIC_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'organic', perItemHours: ORGANIC_FERTILIZER_ITEM_HOURS.get(id) as number };
    }
    const info: any = getItemById(id) || {};
    const interactionType: string = String(info.interaction_type || '').toLowerCase();
    if (interactionType === 'fertilizer') return { type: 'normal', perItemHours: 1 };
    if (interactionType === 'fertilizerpro') return { type: 'organic', perItemHours: 1 };
    return { type: 'other', perItemHours: 0 };
}

function isFertilizerContainerFullError(err: any): boolean {
    const msg: string = String((err && err.message) || '');
    return msg.includes('code=1003002')
        || msg.includes('普通化肥容器已达到上限')
        || msg.includes('普通化肥容器已满')
        || msg.includes('有机化肥容器已达到上限')
        || msg.includes('有机化肥容器已满');
}

async function autoOpenFertilizerGiftPacks(): Promise<number> {
    try {
        const bagReply: any = await getBag();
        const bagItems: any[] = getBagItems(bagReply);
        const payloads: Array<{ id: number; count: number }> = collectFertilizerUsePayload(bagItems);
        if (payloads.length <= 0) {
            return 0;
        }
        const containerHours: { normal: number; organic: number } = getContainerHoursFromBagItems(bagItems);

        let opened: number = 0;
        const details: string[] = [];
        // 按条目 BatchUse，避免数量大时逐个 Use 造成请求风暴
        for (const row of payloads) {
            const itemId: number = Number(row.id) || 0;
            const rawCount: number = Math.max(1, Number(row.count) || 0);
            const { type, perItemHours } = getFertilizerItemTypeAndHours(itemId);
            let useCount: number = rawCount;

            // 容器达到 990h 后不再使用对应化肥道具；未达到时也按剩余可用小时裁剪数量
            if (type === 'normal' || type === 'organic') {
                const currentHours: number = type === 'normal' ? containerHours.normal : containerHours.organic;
                if (currentHours >= FERTILIZER_CONTAINER_LIMIT_HOURS) {
                    continue;
                }
                if (perItemHours > 0) {
                    const remainHours: number = Math.max(0, FERTILIZER_CONTAINER_LIMIT_HOURS - currentHours);
                    const maxCountByHours: number = Math.floor(remainHours / perItemHours);
                    useCount = Math.max(0, Math.min(rawCount, maxCountByHours));
                    if (useCount <= 0) continue;
                }
            }
            const itemInfo: any = getItemById(itemId);
            const itemName: string = itemInfo && itemInfo.name ? String(itemInfo.name) : `物品#${itemId}`;
            let used: number = 0;
            try {
                await batchUseItems([{ itemId, count: useCount, uid: 0 }]);
                used = useCount;
            } catch {
                // BatchUse 失败时直接跳过该条目
                used = 0;
            }
            if (used > 0) {
                opened += used;
                details.push(`${itemName}x${used}`);
                if (type === 'normal' && perItemHours > 0) containerHours.normal += used * perItemHours;
                if (type === 'organic' && perItemHours > 0) containerHours.organic += used * perItemHours;
            }
            await sleep(100);
        }

        if (opened > 0) {
            fertilizerGiftDoneDateKey = getSystemDateKey();
            fertilizerGiftLastOpenAt = Date.now();
            log('仓库', `自动使用化肥类道具 x${opened}${details.length ? ` [${details.join('，')}]` : ''}`, {
                module: 'warehouse',
                event: '开启化肥礼包',
                result: 'ok',
                count: opened,
            });
        }
        return opened;
    } catch (e: any) {
        if (isFertilizerContainerFullError(e)) {
            return 0;
        }
        logWarn('仓库', `开启化肥礼包失败: ${e.message}`, {
            module: 'warehouse',
            event: '开启化肥礼包',
            result: 'error',
        });
        return 0;
    }
}

async function openFertilizerGiftPacksSilently(): Promise<number> {
    return autoOpenFertilizerGiftPacks();
}

async function openCharitySettlementGiftPacksSilently(): Promise<number> {
    const now: number = Date.now();
    if (now - charitySettlementGiftLastOpenAt < SPECIAL_GIFT_CHECK_COOLDOWN_MS) return 0;
    charitySettlementGiftLastOpenAt = now;

    try {
        const bagReply: any = await getBag();
        const giftItems: any[] = getBagItems(bagReply).filter((item: any) => (
            toNum(item?.id) === CHARITY_SETTLEMENT_GIFT_ID
            && !isItemLocked(item)
            && toNum(item?.count) > 0
        ));
        if (giftItems.length === 0) return 0;

        let opened: number = 0;
        for (const item of giftItems) {
            const count: number = Math.max(1, toNum(item?.count));
            try {
                await useItem(CHARITY_SETTLEMENT_GIFT_ID, count, [], toNum(item?.uid));
                opened += count;
            } catch {
                // Retry on a later cooldown if the bag changed or the request failed.
            }
        }

        if (opened > 0) {
            log('仓库', `自动打开公益小红花结算礼包 x${opened}`, {
                module: 'warehouse',
                event: 'charity_settlement_gift_open',
                result: 'ok',
                count: opened,
            });
        }
        return opened;
    } catch (e: any) {
        logWarn('仓库', `打开公益小红花结算礼包失败: ${e.message}`, {
            module: 'warehouse',
            event: 'charity_settlement_gift_open',
            result: 'error',
        });
        return 0;
    }
}

function getGoldFromItems(items: any[]): number {
    for (const item of (items || [])) {
        const id: number = toNum(item.id);
        if (id === 1 || id === 1001) {
            const count: number = toNum(item.count);
            if (count > 0) return count;
        }
    }
    return 0;
}

function deriveGoldGainFromSellReply(reply: any, lastKnownGold: number): { gain: number; nextKnownGold: number } {
    const gainFromGetItems: number = getGoldFromItems((reply && reply.get_items) || []);
    if (gainFromGetItems > 0) {
        // get_items 通常就是本次获得值
        return { gain: gainFromGetItems, nextKnownGold: lastKnownGold };
    }

    // 兼容旧 proto/旧结构
    const currentOrDelta: number = getGoldFromItems((reply && (reply.items || reply.sell_items)) || []);
    if (currentOrDelta <= 0) return { gain: 0, nextKnownGold: lastKnownGold };

    // 协议在不同场景下可能返回"当前总金币"或"本次变化值"
    if (lastKnownGold > 0 && currentOrDelta >= lastKnownGold) {
        return { gain: currentOrDelta - lastKnownGold, nextKnownGold: currentOrDelta };
    }
    return { gain: currentOrDelta, nextKnownGold: lastKnownGold };
}

function getCurrentTotals(): { gold: number; exp: number } {
    const state: any = getUserState() || {};
    return {
        gold: Number(state.gold || 0),
        exp: Number(state.exp || 0),
    };
}

async function getCurrentTotalsFromBag(): Promise<{ gold: number | null; exp: number | null }> {
    const bagReply: any = await getBag();
    const items: any[] = getBagItems(bagReply);
    let gold: number | null = null;
    let exp: number | null = null;
    for (const item of items) {
        const id: number = toNum(item.id);
        const count: number = toNum(item.count);
        if (id === 1 || id === 1001) gold = count;       // 金币
        if (id === 1101) exp = count;     // 累计经验
    }
    return { gold, exp };
}

async function getBagDetail(): Promise<any> {
    const bagReply: any = await getBag();
    const rawItems: any[] = getBagItems(bagReply);
    const baseContext: SellConditionContext = await getSellConditionContext();

    // Balance/container entries have no UID and are not real bag stacks. Keep
    // them separate so status widgets can consume them without displaying them.
    const systemItems: any[] = (rawItems || [])
        .filter((it: any) => toNum(it.id) > 0 && toNum(it.count) > 0 && toNum(it.uid) <= 0)
        .map((it: any) => {
            const id: number = toNum(it.id);
            const count: number = toNum(it.count);
            const info: any = getItemById(id) || null;
            const interactionType: string = info && info.interaction_type ? String(info.interaction_type) : '';
            const hoursText: string = interactionType === 'fertilizerbucket'
                ? `${(Math.floor((count / 3600) * 10) / 10).toFixed(1)}小时`
                : '';
            return { id, count, name: info?.name || `物品${id}`, interactionType, hoursText };
        });

    // 保留原始物品列表（用于出售等操作）
    const originalItems: any[] = [];
    for (const it of (rawItems || [])) {
        const id: number = toNum(it.id);
        const count: number = toNum(it.count);
        const uid: number = toNum(it.uid);
        if (id <= 0 || count <= 0 || uid <= 0) continue;
        const mutantTypes: number[] = getMutantTypes(it);
        const mutantEffects = getMutantEffectsByIds(mutantTypes);
        originalItems.push({
            id,
            count,
            uid,
            expireTime: getItemExpireTime(it),
            mutantTypes,
            mutantEffects,
            mutantTypeNames: mutantEffects.map((effect: any) => effect.name),
            locked: isItemLocked(it),
            groupKey: `uid:${uid}`,
        });
    }

    // UID is the authoritative identity of a concrete bag stack.
    const merged: Map<string, any> = new Map();
    for (const it of (rawItems || [])) {
        const id: number = toNum(it.id);
        const count: number = toNum(it.count);
        const uid: number = toNum(it.uid);
        if (id <= 0 || count <= 0 || uid <= 0) continue;
        const mutantTypes: number[] = getMutantTypes(it);
        const mutantEffects = getMutantEffectsByIds(mutantTypes);
        const groupKey: string = `uid:${uid}`;
        const info: any = getItemById(id) || null;
        let name: string = info && info.name ? String(info.name) : '';
        const itemType: number = info ? (Number(info.type) || 0) : 0;
        let category: string = 'item';
        if (id === 1 || id === 1001) {
            name = '金币';
            category = 'gold';
        } else if (id === 1101) {
            name = '经验';
            category = 'exp';
        } else if (itemType === 17) {
            if (!name) name = `${getFruitName(id)}果实`;
            category = 'mutant';
        } else if (itemType === 6 || getPlantByFruitId(id)) {
            if (!name) name = `${getFruitName(id)}果实`;
            category = 'fruit';
        } else if (itemType === 5 || getPlantBySeedId(id)) {
            const p: any = getPlantBySeedId(id);
            if (!name) name = `${p && p.name ? p.name : '未知'}种子`;
            category = 'seed';
        }
        if (!name) name = `物品${id}`;
        const interactionType: string = info && info.interaction_type ? String(info.interaction_type) : '';
        const expireTime: number = getItemExpireTime(it);
        const sourceInfo: any | null = getItemSourceInfo(it);
        const sellInfo: any = getEffectiveSellInfo(info, { ...baseContext, expireTime });
        const sellsList: any[] = sellInfo.sells;
        const protocolSellPrice: { currencyId: number; price: number } | null = getProtocolSellPrice(it);
        const priceId: number = protocolSellPrice?.currencyId || (sellsList.length > 0 ? sellsList[0].currencyId : 0);
        const price: number = protocolSellPrice?.price || (sellsList.length > 0 ? sellsList[0].price : 0);
        const priceUnit: string = priceId === 1005 ? '金豆豆' : priceId === 1002 ? '点券' : '金';

        if (!merged.has(groupKey)) {
            merged.set(groupKey, {
                key: groupKey,
                id,
                count: 0,
                uid,
                expireTime,
                mutantTypes,
                mutantEffects,
                mutantTypeNames: mutantEffects.map((effect: any) => effect.name),
                locked: isItemLocked(it),
                sourceInfo,
                name,
                image: getItemImageById(id),
                category,
                itemType,
                sellable: sellInfo.sellable,
                sellStatus: sellInfo.status,
                sellCondition: sellInfo.condition,
                priceId,
                price,
                priceUnit,
                level: info ? (Number(info.level) || 0) : 0,
                interactionType,
                description: info?.desc ? String(info.desc) : '',
                viewable: Number(info?.to_see || 0) > 0,
                hoursText: '',
            });
        }
        const row: any = merged.get(groupKey);
        row.count += count;
    }

    const items: any[] = Array.from(merged.values()).map((row: any) => {
        if (row.interactionType === 'fertilizerbucket' && row.count > 0) {
            // 游戏显示更接近截断到 1 位小数（非四舍五入）
            const hoursFloor1: number = Math.floor((row.count / 3600) * 10) / 10;
            row.hoursText = `${hoursFloor1.toFixed(1)}小时`;
        } else {
            row.hoursText = '';
        }
        return row;
    });
    items.sort((a: any, b: any) => {
        const taRaw: number = Number(a.itemType || 0);
        const tbRaw: number = Number(b.itemType || 0);
        const typePriority: Map<number, number> = new Map([
            [6, 0],
            [17, 1],
            [5, 2],
        ]);
        const ta: number = typePriority.has(taRaw) ? typePriority.get(taRaw) as number : (taRaw > 0 ? (1000 + taRaw) : Number.MAX_SAFE_INTEGER);
        const tb: number = typePriority.has(tbRaw) ? typePriority.get(tbRaw) as number : (tbRaw > 0 ? (1000 + tbRaw) : Number.MAX_SAFE_INTEGER);
        if (ta !== tb) return ta - tb;
        const ca: number = Number(a.count || 0);
        const cb: number = Number(b.count || 0);
        if (cb !== ca) return cb - ca;
        return Number(a.id || 0) - Number(b.id || 0);
    });
    return { totalKinds: items.length, items, originalItems, systemItems };
}

// ============ 出售逻辑 ============

/**
 * 检查并出售所有果实
 */
async function sellAllFruits(): Promise<void> {
    const sellEnabled: boolean = isAutomationOn('sell');
    if (!sellEnabled) {
        return;
    }
    try {
        const bagReply: any = await getBag();
        const items: any[] = getBagItems(bagReply);
        const baseContext: SellConditionContext = await getSellConditionContext();

        const toSell: any[] = [];
        const names: string[] = [];
        for (const item of items) {
            const id: number = toNum(item.id);
            const count: number = toNum(item.count);
            const expireTime: number = getItemExpireTime(item);
            if (isFruitItemId(id) && count > 0
                && !isItemLocked(item)
                && getEffectiveSellInfo(id, { ...baseContext, expireTime }).sellable) {
                toSell.push(item);
                names.push(`${getFruitName(id)}x${count}`);
            }
        }

        if (toSell.length === 0) {
            log('仓库', '无果实可出售');
            return;
        }

        const totalsBefore: { gold: number; exp: number } = getCurrentTotals();
        const goldBefore: number = totalsBefore.gold;
        let serverGoldTotal: number = 0;
        let knownGold: number = goldBefore;
        for (let i = 0; i < toSell.length; i += SELL_BATCH_SIZE) {
            const batch: any[] = toSell.slice(i, i + SELL_BATCH_SIZE);
            try {
                const reply: any = await sellItems(batch);
                const inferred: { gain: number; nextKnownGold: number } = deriveGoldGainFromSellReply(reply, knownGold);
                const gained: number = Math.max(0, toNum(inferred.gain));
                knownGold = inferred.nextKnownGold;
                if (gained > 0) serverGoldTotal += gained;
            } catch (batchErr: any) {
                // 某个条目可能参数非法，降级为逐个出售，跳过错误条目
                logWarn('仓库', `批量出售失败，改为逐个重试: ${batchErr.message}`);
                for (const it of batch) {
                    try {
                        const singleReply: any = await sellItems([it]);
                        const inferred: { gain: number; nextKnownGold: number } = deriveGoldGainFromSellReply(singleReply, knownGold);
                        const gained: number = Math.max(0, toNum(inferred.gain));
                        knownGold = inferred.nextKnownGold;
                        if (gained > 0) serverGoldTotal += gained;
                    } catch (singleErr: any) {
                        const sid: number = toNum(it.id);
                        const sc: number = toNum(it.count);
                        logWarn('仓库', `跳过不可售物品: ID=${sid} x${sc} (${singleErr.message})`, {
                            module: 'warehouse',
                            event: '跳过不可售物品',
                            result: 'skip',
                            itemId: sid,
                            count: sc,
                        });
                    }
                }
            }
            if (i + SELL_BATCH_SIZE < toSell.length) await sleep(300);
        }
        // 等待金币通知更新（最多 2s）
        let goldAfter: number = goldBefore;
        const startWait: number = Date.now();
        while (Date.now() - startWait < 2000) {
            const currentGold: number = (getUserState() && getUserState().gold) ? getUserState().gold : goldAfter;
            if (currentGold !== goldBefore) {
                goldAfter = currentGold;
                break;
            }
            await sleep(200);
        }
        const totalsAfter: { gold: number; exp: number } = getCurrentTotals();
        const totalGoldDelta: number = goldAfter > goldBefore ? (goldAfter - goldBefore) : 0;
        const totalsDeltaGold: number = totalsAfter.gold - totalsBefore.gold;
        const totalsDeltaExp: number = totalsAfter.exp - totalsBefore.exp;

        // 通知缺失时，尝试从背包读取金币做最终兜底
        let bagDelta: number = 0;
        if (totalGoldDelta <= 0 && serverGoldTotal <= 0) {
            try {
                const bagAfter: any = await getBag();
                const bagGold: number = getGoldFromItems(getBagItems(bagAfter));
                if (bagGold > goldBefore) bagDelta = bagGold - goldBefore;
            } catch {}
        }

        const totalGoldEarned: number = Math.max(serverGoldTotal, totalGoldDelta, bagDelta);
        if (totalGoldDelta <= 0 && totalGoldEarned > 0) {
            // 某些情况下 ItemNotify 丢失，使用出售回包做金币兜底同步
            const state: any = getUserState();
            if (state) {
                state.gold = Number(state.gold || 0) + totalGoldEarned;
                updateStatusGold(state.gold);
            }
        }
        log('仓库', `出售 ${names.join(', ')}${totalGoldEarned > 0 ? `，获得 ${totalGoldEarned} 金币` : ''}`, {
            module: 'warehouse',
            event: totalGoldEarned > 0 ? 'sell_success' : 'sell_done',
            result: totalGoldEarned > 0 ? 'ok' : 'unknown_gain',
            count: toSell.length,
            gold: totalGoldEarned,
            totalsBefore,
            totalsAfter,
            totalsDeltaGold,
            totalsDeltaExp,
        });

        // 发送出售事件，用于统计金币收益
        if (totalGoldEarned > 0) {
            networkEvents.emit('sell', totalGoldEarned);
        }
    } catch (e: any) {
        logWarn('仓库', `出售失败: ${e.message}`);
    }
}

async function getBagSeeds(): Promise<any[]> {
    const bagReply: any = await getBag();
    const rawItems: any[] = getBagItems(bagReply);
    const merged: Map<number, any> = new Map();

    for (const item of (rawItems || [])) {
        const seedId: number = toNum(item && item.id);
        const count: number = toNum(item && item.count);
        if (seedId <= 0 || count <= 0) continue;
        if (isItemLocked(item)) continue;

        const plant: any = getPlantBySeedId(seedId);
        if (!plant) continue;

        const current: any = merged.get(seedId) || {
            seedId,
            name: String(plant.name || `种子#${seedId}`),
            count: 0,
            requiredLevel: (() => { const si = getItemById(seedId); return si ? Math.max(0, Number(si.level || 0)) : Math.max(0, Number(plant.land_level_need || 0)); })(),
            image: getSeedImageBySeedId(seedId) || getItemImageById(seedId),
            plantSize: Math.max(1, Number(plant.size || 1)),
        };
        current.count += count;
        merged.set(seedId, current);
    }

    return Array.from(merged.values());
}

module.exports = {
    getBag,
    getBagDetail,
    sellItems,
    useItem,
    batchUseItems,
    openFertilizerGiftPacksSilently,
    openCharitySettlementGiftPacksSilently,
    getFertilizerGiftDailyState: () => ({
        key: 'fertilizer_gift_open',
        doneToday: fertilizerGiftDoneDateKey === getSystemDateKey(),
        lastOpenAt: fertilizerGiftLastOpenAt,
    }),
    sellAllFruits,
    getBagItems,
    getCurrentTotalsFromBag,
    getBagSeeds,
    getContainerHoursFromBagItems,
    setItemsLocked,
    isItemLocked,
};
