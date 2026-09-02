"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 邮箱系统 - 自动领取邮箱奖励
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum, getSystemDateKey } = require('../utils/utils');
const DAILY_KEY = 'email_rewards';
let doneDateKey = '';
let lastCheckAt = 0;
const CHECK_COOLDOWN_MS = 5 * 60 * 1000;
function isEmailCheckDue(previousCheckAt, now, force = false) {
    return force || now - previousCheckAt >= CHECK_COOLDOWN_MS;
}
function markDoneToday() {
    doneDateKey = getSystemDateKey();
}
function isDoneToday() {
    return doneDateKey === getSystemDateKey();
}
async function getEmailList(boxType = 1) {
    const body = types.GetEmailListRequest.encode(types.GetEmailListRequest.create({
        box_type: normalizeBoxType(boxType),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.emailpb.EmailService', 'GetEmailList', body);
    return types.GetEmailListReply.decode(replyBody);
}
async function claimEmail(boxType = 1, emailId = '') {
    const body = types.ClaimEmailRequest.encode(types.ClaimEmailRequest.create({
        box_type: normalizeBoxType(boxType),
        email_id: String(emailId || ''),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.emailpb.EmailService', 'ClaimEmail', body);
    return types.ClaimEmailReply.decode(replyBody);
}
async function batchClaimEmail(boxType = 1, emailIds = []) {
    const body = types.BatchClaimEmailRequest.encode(types.BatchClaimEmailRequest.create({
        box_type: normalizeBoxType(boxType),
        email_ids: emailIds.map(String).filter(Boolean),
    })).finish();
    // BatchClaimEmail 有正式响应。等待回包后才能把邮件计入已领取，
    // 否则发送成功但网关返回业务错误时会被误判为成功。
    const { body: replyBody } = await sendMsgAsync('gamepb.emailpb.EmailService', 'BatchClaimEmail', body);
    return types.BatchClaimEmailReply.decode(replyBody);
}
function collectClaimableEmails(reply) {
    const emails = (reply && Array.isArray(reply.emails)) ? reply.emails : [];
    return emails.filter((x) => x && x.id && x.has_reward === true && x.claimed !== true);
}
function normalizeBoxType(v) {
    const n = Number(v);
    return (n === 1 || n === 2) ? n : 1;
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
async function checkAndClaimEmails(force = false) {
    const now = Date.now();
    if (!isEmailCheckDue(lastCheckAt, now, force))
        return { claimed: 0, rewardItems: 0 };
    lastCheckAt = now;
    try {
        const [box1, box2] = await Promise.all([
            getEmailList(1).catch(() => ({ emails: [] })),
            getEmailList(2).catch(() => ({ emails: [] })),
        ]);
        const fromBox1 = (box1.emails || []).map((x) => ({ ...x, __boxType: 1 }));
        const fromBox2 = (box2.emails || []).map((x) => ({ ...x, __boxType: 2 }));
        const claimable = collectClaimableEmails({ emails: [...fromBox1, ...fromBox2] });
        if (claimable.length === 0) {
            markDoneToday();
            log('邮箱', '当前暂无可领取邮箱奖励', {
                module: 'task',
                event: DAILY_KEY,
                result: 'none',
            });
            return { claimed: 0, rewardItems: 0 };
        }
        const rewards = [];
        let claimed = 0;
        // 先按邮箱类型尝试批量领取，失败则继续单领
        const byBox = new Map();
        const batchClaimed = new Set();
        for (const m of claimable) {
            const boxType = normalizeBoxType(m && m.__boxType);
            if (!byBox.has(boxType))
                byBox.set(boxType, []);
            byBox.get(boxType).push(m);
        }
        for (const [boxType, list] of byBox.entries()) {
            try {
                const emailIds = list.map((item) => String((item && item.id) || '')).filter(Boolean);
                if (emailIds.length > 0) {
                    await batchClaimEmail(boxType, emailIds);
                    for (const emailId of emailIds)
                        batchClaimed.add(`${boxType}:${emailId}`);
                    claimed += emailIds.length;
                }
            }
            catch {
                // 批量失败静默，继续单领
            }
        }
        for (const m of claimable) {
            const boxType = normalizeBoxType(m && m.__boxType);
            if (batchClaimed.has(`${boxType}:${String(m.id || '')}`))
                continue;
            try {
                const rep = await claimEmail(boxType, String(m.id || ''));
                if (Array.isArray(rep.items) && rep.items.length > 0) {
                    rewards.push(...rep.items);
                }
                claimed += 1;
            }
            catch {
                // 单封失败静默
            }
        }
        if (claimed > 0) {
            const rewardStr = getRewardSummary(rewards);
            log('邮箱', rewardStr ? `[邮箱领取] 领取成功 ${claimed} 封 → ${rewardStr}` : `[邮箱领取] 领取成功 ${claimed} 封`, {
                module: 'task',
                event: DAILY_KEY,
                result: 'ok',
                count: claimed,
            });
            markDoneToday();
        }
        return { claimed, rewardItems: rewards.length };
    }
    catch (e) {
        log('邮箱', `领取邮箱奖励失败: ${e.message}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'error',
        });
        return { claimed: 0, rewardItems: 0 };
    }
}
async function batchDeleteEmail(boxType = 1, emailIds = []) {
    const body = types.BatchDeleteEmailRequest.encode(types.BatchDeleteEmailRequest.create({
        box_type: normalizeBoxType(boxType),
        email_ids: emailIds.map(String),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.emailpb.EmailService', 'BatchDeleteEmail', body);
    return types.BatchDeleteEmailReply.decode(replyBody);
}
module.exports = {
    getEmailList,
    claimEmail,
    batchClaimEmail,
    batchDeleteEmail,
    checkAndClaimEmails,
    CHECK_COOLDOWN_MS,
    isEmailCheckDue,
    getEmailDailyState: () => ({
        key: DAILY_KEY,
        doneToday: isDoneToday(),
        lastCheckAt,
    }),
};
//# sourceMappingURL=email.js.map