"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * QQ 会员每日礼包
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum, getSystemDateKey } = require('../utils/utils');
const DAILY_KEY = 'vip_daily_gift';
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;
const NOT_QQ_VIP_ERROR_CODE = 1021001;
const ALREADY_CLAIMED_ERROR_CODE = 1021002;
let doneDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;
let lastResult = '';
let lastHasGift = null;
let lastCanClaim = null;
function markDoneToday() {
    doneDateKey = getSystemDateKey();
}
function isDoneToday() {
    return doneDateKey === getSystemDateKey();
}
function getRewardSummary(items) {
    const list = Array.isArray(items) ? items : [];
    const summary = [];
    for (const it of list) {
        const id = toNum(it.id);
        const count = toNum(it.count);
        if (count <= 0)
            continue;
        if (id === 1 || id === 1001)
            summary.push(`金币${count}`);
        else if (id === 2 || id === 1101)
            summary.push(`经验${count}`);
        else if (id === 1002)
            summary.push(`点券${count}`);
        else
            summary.push(`物品#${id}x${count}`);
    }
    return summary.join('/');
}
function hasErrorCode(err, code) {
    if (Number(err && err.code) === code)
        return true;
    return new RegExp(`\\bcode=${code}\\b`).test(String((err && err.message) || err || ''));
}
function isNotQQVipError(err) {
    return hasErrorCode(err, NOT_QQ_VIP_ERROR_CODE);
}
function isAlreadyClaimedError(err) {
    const msg = String((err && err.message) || '');
    return hasErrorCode(err, ALREADY_CLAIMED_ERROR_CODE) || msg.includes('今日已领取') || msg.includes('已领取');
}
async function getQQVipRewardsStatus() {
    const body = types.GetQQVipRewardsStatusRequest.encode(types.GetQQVipRewardsStatusRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.qqvippb.QQVipService', 'GetQQVipRewardsStatus', body);
    return types.GetQQVipRewardsStatusReply.decode(replyBody);
}
async function refreshVipInfo() {
    const body = types.RefreshVipInfoRequest.encode(types.RefreshVipInfoRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.qqvippb.QQVipService', 'RefreshVipInfo', body);
    types.RefreshVipInfoReply.decode(replyBody);
}
async function claimQQVipRewards(rewardTypes) {
    const body = types.ClaimQQVipRewardsRequest.encode(types.ClaimQQVipRewardsRequest.create({
        reward_types: rewardTypes,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.qqvippb.QQVipService', 'ClaimQQVipRewards', body, { expectedErrorCodes: [NOT_QQ_VIP_ERROR_CODE, ALREADY_CLAIMED_ERROR_CODE] });
    return types.ClaimQQVipRewardsReply.decode(replyBody);
}
async function performDailyVipGift(force = false) {
    const now = Date.now();
    if (!force && isDoneToday())
        return false;
    if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS)
        return false;
    lastCheckAt = now;
    try {
        await refreshVipInfo();
        const status = await getQQVipRewardsStatus();
        const rewardStatuses = Array.isArray(status && status.reward_statuses)
            ? status.reward_statuses
            : [];
        const rewardTypes = rewardStatuses
            .filter((item) => item && item.enabled === true && item.can_claim === true)
            .map((item) => toNum(item.reward_type))
            .filter((rewardType) => rewardType > 0);
        lastHasGift = rewardStatuses.some((item) => item && item.enabled === true);
        lastCanClaim = rewardTypes.length > 0;
        if (rewardTypes.length === 0) {
            markDoneToday();
            lastResult = 'none';
            log('会员', '今日暂无可领取会员礼包', {
                module: 'task',
                event: DAILY_KEY,
                result: 'none',
            });
            return false;
        }
        const rep = await claimQQVipRewards(rewardTypes);
        const items = Array.isArray(rep && rep.items) ? rep.items : [];
        const reward = getRewardSummary(items);
        log('会员', reward ? `领取成功 → ${reward}` : '领取成功', {
            module: 'task',
            event: DAILY_KEY,
            result: 'ok',
            count: items.length,
            rewardTypes,
        });
        lastClaimAt = Date.now();
        markDoneToday();
        lastResult = 'ok';
        return true;
    }
    catch (e) {
        if (isNotQQVipError(e)) {
            markDoneToday();
            lastResult = 'none';
            lastHasGift = false;
            lastCanClaim = false;
            log('会员', '非QQ会员，跳过会员礼包', {
                module: 'task',
                event: DAILY_KEY,
                result: 'none',
                reason: 'not_qq_vip',
            });
            return false;
        }
        if (isAlreadyClaimedError(e)) {
            markDoneToday();
            lastClaimAt = Date.now();
            lastResult = 'ok';
            log('会员', '今日会员礼包已领取', {
                module: 'task',
                event: DAILY_KEY,
                result: 'ok',
            });
            return false;
        }
        lastResult = 'error';
        log('会员', `领取会员礼包失败: ${e.message}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'error',
        });
        return false;
    }
}
module.exports = {
    performDailyVipGift,
    getVipDailyState: () => ({
        key: DAILY_KEY,
        doneToday: isDoneToday(),
        lastCheckAt,
        lastClaimAt,
        result: lastResult,
        hasGift: lastHasGift,
        canClaim: lastCanClaim,
    }),
};
//# sourceMappingURL=qqvip.js.map