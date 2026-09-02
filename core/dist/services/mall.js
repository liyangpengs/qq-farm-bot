"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { Buffer } = require('node:buffer');
/**
 * 商城自动购买
 */
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, sleep, getSystemDateKey } = require('../utils/utils');
const ORGANIC_FERTILIZER_MALL_GOODS_ID = 1002;
const INORGANIC_FERTILIZER_MALL_GOODS_ID = 1003;
const BUY_COOLDOWN_MS = 10 * 60 * 1000;
const CHECK_BUY_COOLDOWN_MS = 60 * 1000;
const MAX_ROUNDS = 100;
const BUY_PER_ROUND = 10;
const FREE_GIFTS_DAILY_KEY = 'mall_free_gifts';
let lastBuyAt = 0;
const lastCheckBuyAt = 0;
let buyDoneDateKey = '';
let buyLastSuccessAt = 0;
let buyPausedNoGoldDateKey = '';
let freeGiftDoneDateKey = '';
let freeGiftLastAt = 0;
let freeGiftLastCheckAt = 0;
async function getMallListBySlotType(slotType = 1, subSlotType = 0) {
    const body = types.GetMallListBySlotTypeRequest.encode(types.GetMallListBySlotTypeRequest.create({
        slot_type: Number(slotType) || 1,
        sub_slot_type: Number(subSlotType) || 0,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType', body);
    return types.GetMallListBySlotTypeResponse.decode(replyBody);
}
async function purchaseMallGoods(goodsId, count = 1) {
    const body = types.PurchaseRequest.encode(types.PurchaseRequest.create({
        goods_id: Number(goodsId) || 0,
        count: Number(count) || 1,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.mallpb.MallService', 'Purchase', body);
    return types.PurchaseResponse.decode(replyBody);
}
async function getMallGoodsList(slotType = 1) {
    const mall = await getMallListBySlotType(slotType);
    const raw = Array.isArray(mall && mall.goods_list) ? mall.goods_list : [];
    return raw.flatMap((entry) => {
        if (!Buffer.isBuffer(entry) && !(entry instanceof Uint8Array))
            return entry ? [entry] : [];
        try {
            return [types.MallGoods.decode(entry)];
        }
        catch {
            return [];
        }
    });
}
function parseMallPriceValue(priceField) {
    if (priceField == null)
        return 0;
    if (typeof priceField === 'number')
        return Math.max(0, Math.floor(priceField));
    if (typeof priceField === 'object' && !Buffer.isBuffer(priceField) && !(priceField instanceof Uint8Array)) {
        return Math.max(0, Math.floor(toNum(priceField.count)));
    }
    const bytes = Buffer.isBuffer(priceField) ? priceField : Buffer.from(priceField || []);
    if (!bytes.length)
        return 0;
    // 从 bytes 中读取 field=2 的 varint 作为价格
    let idx = 0;
    let parsed = 0;
    while (idx < bytes.length) {
        const key = bytes[idx++];
        const field = key >> 3;
        const wire = key & 0x07;
        if (wire !== 0)
            break;
        let val = 0;
        let shift = 0;
        while (idx < bytes.length) {
            const b = bytes[idx++];
            val |= (b & 0x7F) << shift;
            if ((b & 0x80) === 0)
                break;
            shift += 7;
        }
        if (field === 2)
            parsed = val;
    }
    return Math.max(0, Math.floor(parsed || 0));
}
function findOrganicFertilizerMallGoods(goodsList) {
    const list = Array.isArray(goodsList) ? goodsList : [];
    return list.find((g) => toNum(g && g.goods_id) === ORGANIC_FERTILIZER_MALL_GOODS_ID) || null;
}
function findInorganicFertilizerMallGoods(goodsList) {
    const list = Array.isArray(goodsList) ? goodsList : [];
    return list.find((g) => toNum(g && g.goods_id) === INORGANIC_FERTILIZER_MALL_GOODS_ID) || null;
}
function findFertilizerMallGoods(goodsList, type = 'organic') {
    if (type === 'normal') {
        return findInorganicFertilizerMallGoods(goodsList);
    }
    return findOrganicFertilizerMallGoods(goodsList);
}
async function autoBuyOrganicFertilizerViaMall() {
    const goodsList = await getMallGoodsList(1);
    const goods = findOrganicFertilizerMallGoods(goodsList);
    if (!goods)
        return 0;
    const goodsId = toNum(goods.goods_id);
    if (goodsId <= 0)
        return 0;
    const singlePrice = parseMallPriceValue(goods.price);
    let ticket = Math.max(0, toNum((getUserState() || {}).ticket));
    let totalBought = 0;
    let perRound = BUY_PER_ROUND;
    if (singlePrice > 0 && ticket > 0) {
        perRound = Math.max(1, Math.min(BUY_PER_ROUND, Math.floor(ticket / singlePrice) || 1));
    }
    for (let i = 0; i < MAX_ROUNDS; i++) {
        if (singlePrice > 0 && ticket > 0 && ticket < singlePrice) {
            buyPausedNoGoldDateKey = getSystemDateKey();
            break;
        }
        try {
            await purchaseMallGoods(goodsId, perRound);
            totalBought += perRound;
            if (singlePrice > 0 && ticket > 0) {
                ticket = Math.max(0, ticket - (singlePrice * perRound));
                if (ticket < singlePrice)
                    break;
            }
            await sleep(120);
        }
        catch (e) {
            const msg = String((e && e.message) || '');
            log('商城', `购买化肥失败: ${msg}`, {
                module: 'warehouse',
                event: '购买化肥',
                result: 'error',
                error: msg,
            });
            if (msg.includes('余额不足') || msg.includes('点券不足') || msg.includes('code=1000019')) {
                if (perRound > 1) {
                    perRound = 1;
                    continue;
                }
                buyPausedNoGoldDateKey = getSystemDateKey();
            }
            break;
        }
    }
    if (totalBought > 0) {
        log('商城', `购买化肥成功，共购买 ${totalBought} 个`, {
            module: 'warehouse',
            event: '购买化肥',
            result: 'ok',
            count: totalBought,
            type: 'organic',
        });
    }
    return totalBought;
}
async function autoBuyFertilizerViaMall(type = 'organic', targetCount = 0) {
    log('商城', `开始购买化肥, 类型: ${type === 'normal' ? '无机化肥' : '有机化肥'}, 数量: ${targetCount || '不限'}`, {
        module: 'warehouse',
        event: '购买化肥',
        type,
        targetCount,
    });
    const goodsList = await getMallGoodsList(1);
    const goods = findFertilizerMallGoods(goodsList, type);
    if (!goods) {
        log('商城', `未找到化肥商品`, {
            module: 'warehouse',
            event: '购买化肥',
            result: 'error',
            type,
            error: '商品不存在',
        });
        return 0;
    }
    const goodsId = toNum(goods.goods_id);
    if (goodsId <= 0)
        return 0;
    const singlePrice = parseMallPriceValue(goods.price);
    let ticket = Math.max(0, toNum((getUserState() || {}).ticket));
    let totalBought = 0;
    let perRound = BUY_PER_ROUND;
    if (singlePrice > 0 && ticket > 0) {
        perRound = Math.max(1, Math.min(BUY_PER_ROUND, Math.floor(ticket / singlePrice) || 1));
    }
    log('商城', `准备购买化肥: goodsId=${goodsId}, 单价=${singlePrice}`, {
        module: 'warehouse',
        event: '购买化肥',
        goodsId,
        singlePrice,
        ticket,
        perRound,
    });
    const remainingToBuy = targetCount > 0 ? targetCount : Infinity;
    for (let i = 0; i < MAX_ROUNDS; i++) {
        if (targetCount > 0 && totalBought >= remainingToBuy)
            break;
        if (singlePrice > 0 && ticket > 0 && ticket < singlePrice) {
            buyPausedNoGoldDateKey = getSystemDateKey();
            break;
        }
        const buyCount = targetCount > 0 ? Math.min(perRound, remainingToBuy - totalBought) : perRound;
        try {
            await purchaseMallGoods(goodsId, buyCount);
            totalBought += buyCount;
            if (singlePrice > 0 && ticket > 0) {
                ticket = Math.max(0, ticket - (singlePrice * buyCount));
                if (ticket < singlePrice)
                    break;
            }
            await sleep(120);
        }
        catch (e) {
            const msg = String((e && e.message) || '');
            log('商城', `购买化肥失败: ${msg}`, {
                module: 'warehouse',
                event: '购买化肥',
                result: 'error',
                error: msg,
                type,
            });
            if (msg.includes('余额不足') || msg.includes('点券不足') || msg.includes('code=1000019')) {
                if (perRound > 1) {
                    perRound = 1;
                    continue;
                }
                buyPausedNoGoldDateKey = getSystemDateKey();
            }
            break;
        }
    }
    if (totalBought > 0) {
        log('商城', `购买化肥成功，共购买 ${totalBought} 个`, {
            module: 'warehouse',
            event: '购买化肥',
            result: 'ok',
            count: totalBought,
            type,
        });
    }
    return totalBought;
}
async function autoBuyOrganicFertilizer(force = false) {
    const now = Date.now();
    if (!force && now - lastBuyAt < BUY_COOLDOWN_MS)
        return 0;
    lastBuyAt = now;
    try {
        const totalBought = await autoBuyOrganicFertilizerViaMall();
        if (totalBought > 0) {
            buyDoneDateKey = getSystemDateKey();
            buyLastSuccessAt = Date.now();
            log('商城', `自动购买有机化肥 x${totalBought}`, {
                module: 'warehouse',
                event: '购买化肥',
                result: 'ok',
                count: totalBought,
            });
        }
        return totalBought;
    }
    catch {
        return 0;
    }
}
async function autoBuyFertilizer(force = false, type = 'organic', targetCount = 0) {
    const now = Date.now();
    if (!force && now - lastBuyAt < BUY_COOLDOWN_MS)
        return 0;
    lastBuyAt = now;
    try {
        const totalBought = await autoBuyFertilizerViaMall(type, targetCount);
        if (totalBought > 0) {
            buyDoneDateKey = getSystemDateKey();
            buyLastSuccessAt = Date.now();
            const typeName = type === 'normal' ? '无机化肥' : '有机化肥';
            log('商城', `自动购买${typeName} x${totalBought}`, {
                module: 'warehouse',
                event: '购买化肥',
                result: 'ok',
                count: totalBought,
                type,
            });
        }
        return totalBought;
    }
    catch {
        return 0;
    }
}
function isDoneTodayByKey(key) {
    return String(key || '') === getSystemDateKey();
}
async function buyFreeGifts(force = false) {
    const now = Date.now();
    if (!force && isDoneTodayByKey(freeGiftDoneDateKey))
        return 0;
    if (!force && now - freeGiftLastCheckAt < BUY_COOLDOWN_MS)
        return 0;
    freeGiftLastCheckAt = now;
    try {
        const goods = await getMallGoodsList(1);
        const free = goods.filter((g) => !!g && g.is_free === true && Number(g.goods_id || 0) > 0);
        if (!free.length) {
            freeGiftDoneDateKey = getSystemDateKey();
            log('商城', '今日暂无可领取免费礼包', {
                module: 'task',
                event: FREE_GIFTS_DAILY_KEY,
                result: 'none',
            });
            return 0;
        }
        let bought = 0;
        for (const g of free) {
            try {
                await purchaseMallGoods(Number(g.goods_id || 0), 1);
                bought += 1;
            }
            catch {
                // 单个失败跳过
            }
        }
        freeGiftDoneDateKey = getSystemDateKey();
        if (bought > 0) {
            freeGiftLastAt = Date.now();
            log('商城', `自动购买免费礼包 x${bought}`, {
                module: 'task',
                event: FREE_GIFTS_DAILY_KEY,
                result: 'ok',
                count: bought,
            });
        }
        else {
            log('商城', '本次未成功领取免费礼包', {
                module: 'task',
                event: FREE_GIFTS_DAILY_KEY,
                result: 'none',
            });
        }
        return bought;
    }
    catch (e) {
        log('商城', `领取免费礼包失败: ${e.message}`, {
            module: 'task',
            event: FREE_GIFTS_DAILY_KEY,
            result: 'error',
        });
        return 0;
    }
}
async function checkAndBuyFertilizerByThreshold(type, count, thresholdHours) {
    const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');
    if (count <= 0 || thresholdHours <= 0) {
        return { bought: 0, message: '参数无效' };
    }
    try {
        const bagReply = await getBag();
        const bagItems = getBagItems(bagReply);
        const containerHours = getContainerHoursFromBagItems(bagItems);
        const currentHours = type === 'normal' ? containerHours.normal : containerHours.organic;
        const typeName = type === 'normal' ? '无机化肥' : '有机化肥';
        log('商城', `检测${typeName}容器: 剩余 ${currentHours.toFixed(1)} 小时，阈值 ${thresholdHours} 小时`, {
            module: 'mall',
            event: 'check_fertilizer',
            type,
            currentHours,
            thresholdHours,
        });
        if (currentHours < thresholdHours) {
            const bought = await autoBuyFertilizer(true, type, count);
            return { bought, currentHours, thresholdHours, needed: true };
        }
        return { bought: 0, currentHours, thresholdHours, needed: false };
    }
    catch (e) {
        log('商城', `检测化肥容器失败: ${e.message}`, {
            module: 'mall',
            event: 'check_fertilizer',
            result: 'error',
            error: e.message,
        });
        return { bought: 0, error: e.message };
    }
}
async function checkAndBuyFertilizerBoth(options) {
    const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');
    const { sleep, randomDelay } = require('../utils/utils');
    const { buyOrganic = false, buyNormal = false, organicCount = 0, organicThresholdHours = 0, normalCount = 0, normalThresholdHours = 0, } = options || {};
    const result = {
        organicBought: 0,
        normalBought: 0,
        organicCurrentHours: 0,
        normalCurrentHours: 0,
    };
    if (!buyOrganic && !buyNormal) {
        return result;
    }
    try {
        const bagReply = await getBag();
        const bagItems = getBagItems(bagReply);
        const containerHours = getContainerHoursFromBagItems(bagItems);
        result.organicCurrentHours = containerHours.organic;
        result.normalCurrentHours = containerHours.normal;
        // 优先购买有机化肥
        if (buyOrganic && organicCount > 0 && organicThresholdHours > 0) {
            log('商城', `检测有机化肥容器: 剩余 ${containerHours.organic.toFixed(1)} 小时，阈值 ${organicThresholdHours} 小时`, {
                module: 'mall',
                event: 'check_fertilizer_organic',
                currentHours: containerHours.organic,
                thresholdHours: organicThresholdHours,
            });
            if (containerHours.organic < organicThresholdHours) {
                result.organicBought = await autoBuyFertilizer(true, 'organic', organicCount);
            }
        }
        // 如果同时购买两种化肥，添加随机延迟
        if (buyOrganic && buyNormal && result.organicBought > 0) {
            const delay = 1000 + Math.random() * 1000; // 1000-2000ms
            await sleep(delay);
        }
        // 购买无机化肥
        if (buyNormal && normalCount > 0 && normalThresholdHours > 0) {
            log('商城', `检测无机化肥容器: 剩余 ${containerHours.normal.toFixed(1)} 小时，阈值 ${normalThresholdHours} 小时`, {
                module: 'mall',
                event: 'check_fertilizer_normal',
                currentHours: containerHours.normal,
                thresholdHours: normalThresholdHours,
            });
            if (containerHours.normal < normalThresholdHours) {
                result.normalBought = await autoBuyFertilizer(true, 'normal', normalCount);
            }
        }
        return result;
    }
    catch (e) {
        log('商城', `检测化肥容器失败: ${e.message}`, {
            module: 'mall',
            event: 'check_fertilizer',
            result: 'error',
            error: e.message,
        });
        return { ...result, error: e.message };
    }
}
module.exports = {
    getMallListBySlotType,
    getMallGoodsList,
    purchaseMallGoods,
    parseMallPriceValue,
    autoBuyOrganicFertilizer,
    autoBuyFertilizer,
    checkAndBuyFertilizerByThreshold,
    checkAndBuyFertilizerBoth,
    buyFreeGifts,
    getFertilizerBuyDailyState: () => ({
        key: 'fertilizer_buy',
        doneToday: buyDoneDateKey === getSystemDateKey(),
        pausedNoGoldToday: buyPausedNoGoldDateKey === getSystemDateKey(),
        lastSuccessAt: buyLastSuccessAt,
    }),
    getFreeGiftDailyState: () => ({
        key: FREE_GIFTS_DAILY_KEY,
        doneToday: freeGiftDoneDateKey === getSystemDateKey(),
        lastCheckAt: freeGiftLastCheckAt,
        lastClaimAt: freeGiftLastAt,
    }),
};
//# sourceMappingURL=mall.js.map