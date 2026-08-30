export {};
/**
 * 活动商店 - 目录查询、归一与星砂兑换写操作。
 */

const { sendMsgAsync } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { getBag } = require('../warehouse');
const {
    int64String,
    itemDto,
    bytesToText,
    parseJsonText,
    businessError,
    positiveDecimal,
    readBagBalances,
} = require('./shared');
const { SHOP_ACTIVITY_TYPE, querySeason, findSeasonActivity } = require('./season');

const EXCHANGE_SHOP_OPERATE_TYPE = 1;
const QUERY_SHOP_OPERATE_TYPE = 7;

// snapshot 依赖本模块，写操作又要回传最新快照；延迟 require 打破循环依赖。
function getActivityCenterSnapshot(shopOverride: any = null) {
    return require('./snapshot').getActivityCenterSnapshot(shopOverride);
}

function isExplicitlyUnavailableShopStatus(_statusCode: string): boolean {
    // status=100 已在成功兑换后的目录中出现，不能视为售罄或禁用。
    // 尚无状态值被协议或抓包明确证实为禁用，因此目录存在且成本有效时交由服务端最终校验。
    return false;
}

function normalizeShopFromReply(seasonReply: any, shopActivity: any, reply: any, balances: Map<string, string> | null) {
    const goods = Array.isArray(reply.data?.catalog?.goods) ? reply.data.catalog.goods : [];
    const currencyIds: string[] = Array.from(new Set<string>(goods
        .map((entry: any) => int64String(entry?.cost?.item_id))
        .filter((id: string) => id !== '0')));
    const balanceKnown = balances !== null;
    const activityId = int64String(reply.activity_id);
    const goodsDtos = goods.map((entry: any) => {
        const statusCode = int64String(entry.status);
        const costId = int64String(entry?.cost?.item_id);
        const costCount = int64String(entry?.cost?.count);
        const costValid = costId !== '0' && BigInt(costCount) > 0n;
        const exchangeable = costValid && !isExplicitlyUnavailableShopStatus(statusCode);
        const balance = balanceKnown ? BigInt(balances!.get(costId) || '0') : 0n;
        const maxExchangeCount = exchangeable && balanceKnown
            ? (balance / BigInt(costCount)).toString()
            : '0';
        return {
            id: int64String(entry.goods_id),
            activityId,
            name: bytesToText(entry.name),
            category: bytesToText(entry.category),
            item: itemDto(entry.item),
            cost: itemDto(entry.cost),
            sortOrder: int64String(entry.sort_order),
            resource: parseJsonText(entry.resource_json),
            statusCode,
            owned: entry.owned === true,
            exchangeable,
            soldOut: false,
            balanceKnown,
            maxExchangeCount,
            maxExchangeCountKnown: balanceKnown,
            qualityCode: int64String(entry.field_10),
            field11Code: int64String(entry.field_11),
        };
    });
    const exchangeableCount = goodsDtos.filter((entry: any) => entry.exchangeable).length;
    const affordableCount = goodsDtos.filter((entry: any) => (
        entry.exchangeable && (!entry.maxExchangeCountKnown || BigInt(entry.maxExchangeCount) > 0n)
    )).length;
    return {
        activityId,
        name: bytesToText(reply.data?.activity?.name) || bytesToText(shopActivity.name),
        startTime: int64String(shopActivity.begin_time),
        endTime: int64String(shopActivity.end_time),
        serverTime: int64String(seasonReply?.season_info?.server_time),
        balanceKnown,
        currencies: currencyIds.map(id => ({
            ...itemDto({ item_id: id, count: balanceKnown ? balances!.get(id) || '0' : '0' }),
            balance: balanceKnown ? balances!.get(id) || '0' : null,
            balanceKnown,
        })),
        categories: Array.from(new Set(goods.map((entry: any) => bytesToText(entry.category)).filter(Boolean))),
        goods: goodsDtos,
        action: {
            supported: true,
            enabled: affordableCount > 0,
            available: affordableCount > 0,
            count: affordableCount,
            availabilityKnown: true,
            ...(exchangeableCount === 0
                ? { reason: '当前目录没有明确可兑换的商品' }
                : affordableCount === 0 ? { reason: '当前余额不足以兑换目录商品' } : {}),
        },
    };
}

async function queryShopCatalog(shopActivity: any): Promise<any> {
    const request = types.QueryActivityRequest.create({
        activity_id: shopActivity.activity_id,
        operate_type: QUERY_SHOP_OPERATE_TYPE,
    });
    const body = Buffer.from(types.QueryActivityRequest.encode(request).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    const reply = types.ActivityOperateReply.decode(replyBody);
    if (int64String(reply.activity_id) !== int64String(shopActivity.activity_id)) {
        throw businessError('SHOP_RESPONSE_INVALID', '活动商店查询返回了不匹配的活动 ID');
    }
    if (int64String(reply.operate_type) !== String(QUERY_SHOP_OPERATE_TYPE)) {
        throw businessError('SHOP_RESPONSE_INVALID', `活动商店查询返回了未知操作类型: ${int64String(reply.operate_type)}`);
    }
    if (!reply.data?.catalog || !Array.isArray(reply.data.catalog.goods)) {
        throw businessError('SHOP_RESPONSE_INVALID', '活动商店查询回包缺少商品目录');
    }
    return reply;
}

async function queryShopFromSeason(seasonReply: any) {
    const shopActivity = findSeasonActivity(seasonReply, SHOP_ACTIVITY_TYPE);
    if (!shopActivity) throw businessError('SHOP_UNAVAILABLE', '当前赛季未发现活动商店');

    const reply = await queryShopCatalog(shopActivity);
    const goods = reply.data.catalog.goods;
    const currencyIds: string[] = Array.from(new Set<string>(goods
        .map((entry: any) => int64String(entry?.cost?.item_id))
        .filter((id: string) => id !== '0')));
    let balances: Map<string, string> | null = null;
    try {
        balances = readBagBalances(await getBag(), currencyIds);
    } catch {
        // 商店目录仍可展示，但余额和基于余额的最大兑换数均不可确证。
    }
    return normalizeShopFromReply(seasonReply, shopActivity, reply, balances);
}

async function exchangeStarSandGoods(goodsIdInput: unknown, countInput: unknown) {
    const goodsId = positiveDecimal(goodsIdInput, 'INVALID_SHOP_GOODS_ID', 'goodsId');
    const count = positiveDecimal(countInput, 'INVALID_EXCHANGE_COUNT', 'count');

    const seasonReply = await querySeason();
    const shopActivity = findSeasonActivity(seasonReply, SHOP_ACTIVITY_TYPE);
    if (!shopActivity) throw businessError('SHOP_UNAVAILABLE', '当前赛季未发现活动商店');

    const catalogReply = await queryShopCatalog(shopActivity);
    const catalogGoods = catalogReply.data.catalog.goods;
    const rawGoods = catalogGoods.find((entry: any) => int64String(entry?.goods_id) === goodsId);
    if (!rawGoods) throw businessError('SHOP_GOODS_NOT_FOUND', '活动商店中未找到指定商品');

    const currencyId = int64String(rawGoods?.cost?.item_id);
    const unitCostText = int64String(rawGoods?.cost?.count);
    const unitCost = BigInt(unitCostText);
    if (currencyId === '0' || unitCost <= 0n) {
        throw businessError('SHOP_RESPONSE_INVALID', '商品兑换成本无效，请刷新商店后重试');
    }

    let balances: Map<string, string>;
    try {
        balances = readBagBalances(await getBag(), [currencyId]);
    } catch {
        throw businessError('SHOP_BALANCE_UNAVAILABLE', '无法确认当前星砂余额，请稍后重试');
    }
    const shopBefore = normalizeShopFromReply(seasonReply, shopActivity, catalogReply, balances);
    const normalizedGoods = shopBefore.goods.find((entry: any) => entry.id === goodsId);
    if (!normalizedGoods) throw businessError('SHOP_GOODS_NOT_FOUND', '活动商店中未找到指定商品');
    if (!normalizedGoods.exchangeable || normalizedGoods.soldOut) {
        throw businessError('SHOP_GOODS_UNAVAILABLE', '该商品当前不可兑换，请刷新商店后重试');
    }

    const purchaseCount = BigInt(count);
    const totalCost = unitCost * purchaseCount;
    const balance = BigInt(balances.get(currencyId) || '0');
    if (balance < totalCost) {
        throw businessError('INSUFFICIENT_STAR_SAND', '星砂余额不足，无法完成本次兑换');
    }

    const request = types.ExchangeShopRequest.create({
        activity_id: shopActivity.activity_id,
        operate_type: EXCHANGE_SHOP_OPERATE_TYPE,
        exchange_shop_operate: {
            goods_id: goodsId,
            count,
        },
    });
    const body = Buffer.from(types.ExchangeShopRequest.encode(request).finish());
    // 写操作只发送一次；任何超时或网络错误均直接返回，不自动重试。
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    const reply = types.ActivityOperateReply.decode(replyBody);
    if (int64String(reply.activity_id) !== int64String(shopActivity.activity_id)) {
        throw businessError('SHOP_RESPONSE_INVALID', '活动商店兑换返回了不匹配的活动 ID');
    }
    if (int64String(reply.operate_type) !== String(EXCHANGE_SHOP_OPERATE_TYPE)) {
        throw businessError('SHOP_RESPONSE_INVALID', `活动商店兑换返回了未知操作类型: ${int64String(reply.operate_type)}`);
    }
    if (!reply.data?.catalog || !Array.isArray(reply.data.catalog.goods)) {
        throw businessError('SHOP_RESPONSE_INVALID', '活动商店兑换回包缺少最新商品目录');
    }

    const responseCurrencyIds: string[] = Array.from(new Set<string>(reply.data.catalog.goods
        .map((entry: any) => int64String(entry?.cost?.item_id))
        .filter((id: string) => id !== '0')));
    let latestBalances: Map<string, string> | null = null;
    try {
        latestBalances = readBagBalances(await getBag(), responseCurrencyIds);
    } catch {
        // 兑换已经由服务端确认成功；刷新背包失败不能把写操作伪装成失败，以免诱导重试。
    }
    const shop = normalizeShopFromReply(seasonReply, shopActivity, reply, latestBalances);
    const snapshot = await getActivityCenterSnapshot(shop);
    const unitItemCount = BigInt(int64String(rawGoods?.item?.count));
    const totalItemCount = (unitItemCount > 0n ? unitItemCount * purchaseCount : 0n).toString();
    const receivedItem = itemDto({
        item_id: rawGoods?.item?.item_id,
        count: totalItemCount,
    });
    const rewards = receivedItem.id !== '0' && totalItemCount !== '0' ? [receivedItem] : [];
    return {
        purchaseCount: count,
        totalItemCount,
        totalCost: totalCost.toString(),
        rewards,
        receivedItems: rewards,
        message: `兑换成功，共消耗 ${totalCost.toString()} ${normalizedGoods.cost.name || '星砂'}`,
        shop,
        snapshot,
    };
}

module.exports = {
    normalizeShopFromReply,
    queryShopCatalog,
    queryShopFromSeason,
    exchangeStarSandGoods,
};
