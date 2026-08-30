export {};
/**
 * 青酿换万金 - 每日种子、投料酿造与分享结算。
 */

const { sendMsgAsync, GatewayError } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { getMutantEffectsByIds } = require('../../config/gameConfig');
const { getSystemDateKey } = require('../../utils/utils');
const { getBag, getBagItems } = require('../warehouse');
const { getActivityWindows } = require('../activity-windows');
const { reportActivityShare } = require('../share');
const {
    int64String,
    int64Number,
    itemDto,
    bytesToText,
    textContent,
    businessError,
    positiveDecimal,
    activityWindowIsActive,
} = require('./shared');

const QINGMEI_DAILY_ACTIVITY_ID = '2026081201';
const QINGMEI_BREW_ACTIVITY_ID = '2026081202';
const QINGMEI_ITEM_ID = 41221;
const QINGMEI_DAILY_GRANT_ID = 3;
const QUERY_QINGMEI_OPERATE_TYPE = 7;
const CLAIM_QINGMEI_SEED_OPERATE_TYPE = 4;
const START_QINGMEI_BREW_OPERATE_TYPE = 14;
const CONTINUE_QINGMEI_BREW_OPERATE_TYPE = 15;
const SELL_QINGMEI_BREW_OPERATE_TYPE = 16;
const QINGMEI_SHARE_SOURCE = 11;
const QINGMEI_SHARE_SCENE = 215;
const QINGMEI_SHARED_SETTLEMENT_MODE = 2;
const QINGMEI_DAILY_ALREADY_CLAIMED_CODE = 1034014;

let qingMeiSeedClaimedDateKey = '';

// snapshot 依赖本模块，写操作又要回传最新快照；延迟 require 打破循环依赖。
function getActivityCenterSnapshot(shopOverride: any = null) {
    return require('./snapshot').getActivityCenterSnapshot(shopOverride);
}

async function operateQingMei(requestType: any, payload: any, expectedErrorCodes: number[] = []): Promise<any> {
    const body = Buffer.from(requestType.encode(requestType.create(payload)).finish());
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.activitypb.ActivityService',
        'Operate',
        body,
        { expectedErrorCodes },
    );
    return types.ActivityOperateReply.decode(replyBody);
}

async function queryQingMeiReply(): Promise<any> {
    return operateQingMei(types.QueryActivityRequest, {
        activity_id: QINGMEI_BREW_ACTIVITY_ID,
        operate_type: QUERY_QINGMEI_OPERATE_TYPE,
    });
}

function qingMeiIngredients(bagReply: any): any[] {
    return getBagItems(bagReply)
        .filter((item: any) => int64Number(item?.id) === QINGMEI_ITEM_ID && BigInt(int64String(item?.count)) > 0n)
        .map((item: any) => {
            const mutantTypes = (Array.isArray(item?.mutant_types) ? item.mutant_types : (Array.isArray(item?.mutantTypes) ? item.mutantTypes : []))
                .map(int64String)
                .filter((value: string) => value !== '0');
            const mutantEffects = getMutantEffectsByIds(mutantTypes);
            const uid = int64String(item?.uid);
            return {
                ...itemDto(item),
                uid,
                mutantTypes,
                mutantEffects,
                mutantTypeNames: mutantEffects.map((effect: any) => effect.name),
                key: `${uid}:${mutantTypes.join(',')}`,
            };
        });
}

function qingMeiDto(reply: any, ingredients: any[] | null = null) {
    const activity = reply?.data?.activity;
    const brew = reply?.data?.qingmei_brew || {};
    const quote = reply?.qingmei_quote || reply?.data?.qingmei_quote || null;
    const dailySeed = reply?.data?.qingmei_daily_seed || null;
    const currentRound = int64Number(brew.current_round);
    const started = int64Number(brew.base_gold) > 0;
    const maxRounds = Math.max(1, int64Number(brew.max_rounds) || 3);
    const quotePrices = (Array.isArray(brew.quote_prices) ? brew.quote_prices : []).map(int64String);
    const quoteTotals = (Array.isArray(brew.quote_totals) ? brew.quote_totals : []).map(int64String);
    const rules = textContent(activity?.extra);
    const dailySeedClaimed = qingMeiSeedClaimedDateKey === getSystemDateKey() || !!dailySeed?.claimed;
    return {
        activityId: int64String(activity?.activity_id) === '0' ? QINGMEI_BREW_ACTIVITY_ID : int64String(activity?.activity_id),
        dailyActivityId: QINGMEI_DAILY_ACTIVITY_ID,
        name: bytesToText(activity?.name) || '青酿换万金',
        startTime: int64String(activity?.begin_time),
        endTime: int64String(activity?.end_time),
        rules,
        ingredient: itemDto({ item_id: QINGMEI_ITEM_ID, count: ingredients?.reduce((sum: bigint, item: any) => sum + BigInt(item.count), 0n).toString() || '0' }),
        ingredients: ingredients || [],
        balance: ingredients === null ? null : ingredients.reduce((sum: bigint, item: any) => sum + BigInt(item.count), 0n).toString(),
        balanceKnown: ingredients !== null,
        baseGold: int64String(brew.base_gold),
        basePrice: int64String(brew.base_price),
        guaranteedPrice: int64String(brew.guaranteed_price),
        currentRound,
        started,
        maxRounds,
        finished: !!brew.finished,
        quotePrices,
        quoteTotals,
        quote: quote ? {
            round: int64Number(quote.round),
            unitPrice: int64String(quote.unit_price),
            totalGold: int64String(quote.total_gold),
            doubled: !!quote.doubled,
        } : null,
        dailySeed: {
            claimed: dailySeedClaimed,
            grantId: dailySeed ? int64String(dailySeed?.grant?.grant_id) : String(QINGMEI_DAILY_GRANT_ID),
            reward: itemDto(dailySeed?.grant?.item),
        },
        actions: {
            claimSeed: { enabled: !dailySeedClaimed, available: !dailySeedClaimed },
            start: { enabled: ingredients === null || ingredients.length > 0, available: ingredients === null || ingredients.length > 0 },
            continue: { enabled: currentRound < maxRounds && !brew.finished && int64Number(brew.base_gold) > 0, available: currentRound < maxRounds && !brew.finished && int64Number(brew.base_gold) > 0 },
            settle: { enabled: quoteTotals.length > 0 || !!brew.finished, available: quoteTotals.length > 0 || !!brew.finished },
        },
    };
}

async function getCurrentQingMeiActivity() {
    const activityWindows = await getActivityWindows();
    const qingMeiWindow = activityWindows.find((activity: any) => (
        [QINGMEI_DAILY_ACTIVITY_ID, QINGMEI_BREW_ACTIVITY_ID, '2026081200'].includes(String(activity?.id || ''))
        && activityWindowIsActive(activity)
    ));
    if (!qingMeiWindow) return null;

    const reply = await queryQingMeiReply();
    let ingredients: any[] | null = null;
    try {
        ingredients = qingMeiIngredients(await getBag());
    } catch {}
    return qingMeiDto(reply, ingredients);
}

async function claimQingMeiDailySeed() {
    let reply: any = null;
    let alreadyClaimed = false;
    try {
        reply = await operateQingMei(types.ClaimQingMeiDailySeedRequest, {
            activity_id: QINGMEI_DAILY_ACTIVITY_ID,
            operate_type: CLAIM_QINGMEI_SEED_OPERATE_TYPE,
            params: { grant_id: QINGMEI_DAILY_GRANT_ID },
        }, [QINGMEI_DAILY_ALREADY_CLAIMED_CODE]);
    } catch (error: any) {
        if (!(error instanceof GatewayError) || error.code !== QINGMEI_DAILY_ALREADY_CLAIMED_CODE) {
            throw error;
        }
        alreadyClaimed = true;
    }
    qingMeiSeedClaimedDateKey = getSystemDateKey();
    return {
        rewards: (Array.isArray(reply?.rewards) ? reply.rewards : []).map(itemDto),
        message: alreadyClaimed ? '今日青梅种子已经领取，无需重复领取' : '青梅种子领取成功',
        snapshot: await getActivityCenterSnapshot(),
    };
}

async function startQingMeiBrew(input: unknown) {
    const bagReply = await getBag();
    const candidates = qingMeiIngredients(bagReply);
    let requested: any[];
    if (Array.isArray(input)) {
        requested = input;
    } else {
        const legacyCount = positiveDecimal(input, 'INVALID_QINGMEI_COUNT', 'count');
        const candidate = candidates.find((item: any) => BigInt(item.count) >= BigInt(legacyCount));
        requested = [{ uid: candidate?.uid, count: legacyCount }];
    }
    if (requested.length === 0) throw businessError('INVALID_QINGMEI_INGREDIENTS', '至少选择一组青梅');
    const seenUids = new Set<string>();
    const ingredients = requested.map((entry: any) => {
        const uid = positiveDecimal(entry?.uid, 'INVALID_QINGMEI_UID', 'uid');
        const count = positiveDecimal(entry?.count, 'INVALID_QINGMEI_COUNT', 'count');
        if (seenUids.has(uid)) throw businessError('DUPLICATE_QINGMEI_UID', `青梅 UID ${uid} 重复`);
        seenUids.add(uid);
        const candidate = candidates.find((item: any) => item.uid === uid);
        if (!candidate || BigInt(candidate.count) < BigInt(count)) {
            throw businessError('INSUFFICIENT_QINGMEI', `青梅 UID ${uid} 数量不足`);
        }
        return { uid, count };
    });
    const totalCount = ingredients.reduce((sum: bigint, item: any) => sum + BigInt(item.count), 0n).toString();
    const reply = await operateQingMei(types.StartQingMeiBrewRequest, {
        activity_id: QINGMEI_BREW_ACTIVITY_ID,
        operate_type: START_QINGMEI_BREW_OPERATE_TYPE,
        params: { ingredients },
    });
    return {
        activity: qingMeiDto(reply),
        message: `已投入 ${totalCount} 个青梅开始酿造`,
        snapshot: await getActivityCenterSnapshot(),
    };
}

async function continueQingMeiBrew() {
    const reply = await operateQingMei(types.ContinueQingMeiBrewRequest, {
        activity_id: QINGMEI_BREW_ACTIVITY_ID,
        operate_type: CONTINUE_QINGMEI_BREW_OPERATE_TYPE,
        params: {},
    });
    const quote = reply?.qingmei_quote || reply?.data?.qingmei_quote;
    return {
        quote: quote ? {
            round: int64Number(quote.round),
            unitPrice: int64String(quote.unit_price),
            totalGold: int64String(quote.total_gold),
            doubled: !!quote.doubled,
        } : null,
        message: quote ? `第 ${int64Number(quote.round)} 轮报价：${int64String(quote.total_gold)} 金币` : '酿造进度已更新',
        snapshot: await getActivityCenterSnapshot(),
    };
}

async function settleQingMeiBrew() {
    await reportActivityShare(QINGMEI_SHARE_SOURCE, QINGMEI_SHARE_SCENE);
    const reply = await operateQingMei(types.SettleQingMeiBrewRequest, {
        activity_id: QINGMEI_BREW_ACTIVITY_ID,
        operate_type: SELL_QINGMEI_BREW_OPERATE_TYPE,
        params: { settlement_mode: QINGMEI_SHARED_SETTLEMENT_MODE },
    });
    const settlement = reply?.qingmei_settlement || null;
    const settlementReward = settlement?.reward ? [itemDto(settlement.reward)] : [];
    return {
        rewards: settlementReward.length > 0 ? settlementReward : (Array.isArray(reply.rewards) ? reply.rewards : []).map(itemDto),
        settlement: settlement ? {
            mode: int64Number(settlement.settlement_mode),
            totalGold: int64String(settlement.total_gold),
        } : { mode: QINGMEI_SHARED_SETTLEMENT_MODE, totalGold: '0' },
        message: settlement
            ? `分享出售成功（1.5倍），获得 ${int64String(settlement.total_gold)} 金币`
            : '青梅酿已按分享奖励出售（1.5倍）',
        snapshot: await getActivityCenterSnapshot(),
    };
}

module.exports = {
    getCurrentQingMeiActivity,
    claimQingMeiDailySeed,
    startQingMeiBrew,
    continueQingMeiBrew,
    settleQingMeiBrew,
};
