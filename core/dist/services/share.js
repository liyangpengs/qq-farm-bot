"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 每日分享礼包
 */
const { sendMsgAsync, sendMsgNoReply } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, getSystemDateKey } = require('../utils/utils');
const DAILY_KEY = 'daily_share';
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;
let checkedDateKey = '';
let claimedDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;
let checkStatus = 'unchecked';
let canShare = null;
function isCheckedToday() {
    return checkedDateKey === getSystemDateKey();
}
function isAlreadyClaimedError(error) {
    return Number(error?.code) === 1009001 || /\bcode=1009001\b/.test(String(error?.message || error || ''));
}
async function checkCanShare() {
    const body = types.CheckCanShareRequest.encode(types.CheckCanShareRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', body);
    return types.CheckCanShareReply.decode(replyBody);
}
async function getInviteInfo() {
    const body = types.GetInviteInfoRequest.encode(types.GetInviteInfoRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'GetInviteInfo', body);
    return types.GetInviteInfoReply.decode(replyBody);
}
async function reportShare() {
    const body = types.ReportShareRequest.encode(types.ReportShareRequest.create({
        field_1: 1,
        field_4: 42,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', body);
    types.ReportShareReply.decode(replyBody);
}
async function claimShareReward() {
    const body = types.ClaimShareRewardRequest.encode(types.ClaimShareRewardRequest.create({
        field_1: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ClaimShareReward', body);
    return types.ClaimShareRewardReply.decode(replyBody);
}
async function reportActivityShare(source, scene) {
    const body = types.ReportShareRequest.encode(types.ReportShareRequest.create({
        field_1: source,
        field_4: scene,
    })).finish();
    await sendMsgNoReply('gamepb.sharepb.ShareService', 'ReportShare', body);
}
async function checkDailyShareStatus(force = false) {
    const now = Date.now();
    if (claimedDateKey === getSystemDateKey())
        return false;
    if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS)
        return false;
    lastCheckAt = now;
    try {
        const reply = await checkCanShare();
        canShare = !!(reply && reply.can_share);
        checkStatus = canShare ? 'entry_available' : 'entry_unavailable';
        checkedDateKey = getSystemDateKey();
        if (!canShare) {
            log('分享', '分享入口暂不可用', {
                module: 'task',
                event: DAILY_KEY,
                result: 'checked',
                canShare,
            });
            return true;
        }
        await reportShare();
        const claimReply = await claimShareReward();
        const items = Array.isArray(claimReply?.items) ? claimReply.items : [];
        claimedDateKey = checkedDateKey;
        lastClaimAt = Date.now();
        log('分享', `分享礼包领取成功${items.length > 0 ? `，获得 ${items.length} 种物品` : ''}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'ok',
            canShare,
            items,
        });
        return true;
    }
    catch (e) {
        if (isAlreadyClaimedError(e)) {
            claimedDateKey = getSystemDateKey();
            checkedDateKey = claimedDateKey;
            lastClaimAt = Date.now();
            checkStatus = 'already_claimed';
            log('分享', '分享礼包今日已领取', {
                module: 'task',
                event: DAILY_KEY,
                result: 'already_claimed',
            });
            return true;
        }
        canShare = null;
        checkStatus = 'check_failed';
        log('分享', `状态检查失败: ${e.message}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'error',
        });
        return false;
    }
}
module.exports = {
    checkDailyShareStatus,
    reportActivityShare,
    getInviteInfo,
    getShareDailyState: () => ({
        key: DAILY_KEY,
        mode: 'auto_claim',
        checkedToday: isCheckedToday(),
        checkStatus,
        canShare,
        doneToday: claimedDateKey === getSystemDateKey(),
        lastCheckAt,
        lastClaimAt,
    }),
};
//# sourceMappingURL=share.js.map