export {};
/**
 * 邀请码处理模块 - 处理主进程分配的 share.txt 批次
 * 注意：此功能仅在微信环境下有效
 *
 * 原理：
 * 1. 首次登录时，游戏会在 LoginRequest 中携带 sharer_id 和 sharer_open_id
 * 2. 已登录状态下点击分享链接，游戏会发送 ReportArkClickRequest
 * 3. 服务器收到后会自动向分享者发送好友申请
 *
 * 我们使用 ReportArkClickRequest 来模拟已登录状态下的分享链接点击
 */

const { CONFIG } = require('../config/config');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, log, logWarn, sleep } = require('../utils/utils');

interface ParsedShareLink {
    uid: string;
    openid: string;
    shareSource: string;
}

/**
 * 发送 ReportArkClick 请求
 * 模拟已登录状态下点击分享链接，触发服务器向分享者发送好友申请
 */
async function sendReportArkClick(sharerId: string | null, sharerOpenId: string | null, shareSource: string | null): Promise<any> {
    const body: Uint8Array = types.ReportArkClickRequest.encode(types.ReportArkClickRequest.create({
        sharer_id: toLong(sharerId),
        sharer_open_id: sharerOpenId,
        share_cfg_id: toLong(shareSource || 0),
        scene_id: '1256',  // 模拟微信场景
    })).finish();

    const { body: replyBody } = await sendMsgAsync('gamepb.userpb.UserService', 'ReportArkClick', body);
    return types.ReportArkClickReply.decode(replyBody);
}

// 请求间隔时间（毫秒）
const INVITE_REQUEST_DELAY: number = 2000;

/**
 * 处理邀请码列表
 * 仅在微信环境下执行
 */
async function processInviteCodes(invitesInput: unknown): Promise<void> {
    // 检查是否为微信环境
    if (CONFIG.platform !== 'wx') {
        log('邀请', '当前为 QQ 环境，跳过邀请码处理（仅微信支持）');
        return;
    }

    const invites: ParsedShareLink[] = Array.isArray(invitesInput)
        ? invitesInput.map((invite: any) => ({
            uid: String(invite?.uid || '').trim(),
            openid: String(invite?.openid || '').trim(),
            shareSource: String(invite?.shareSource || '').trim(),
        })).filter((invite: ParsedShareLink) => invite.uid && invite.openid)
        : [];
    if (invites.length === 0) {
        return;
    }

    log('邀请', `接收到 ${invites.length} 个邀请码（已去重），开始逐个处理...`);

    let successCount: number = 0;
    let failCount: number = 0;

    for (let i = 0; i < invites.length; i++) {
        const invite: ParsedShareLink = invites[i];

        try {
            // 发送 ReportArkClick 请求，模拟点击分享链接
            await sendReportArkClick(invite.uid, invite.openid, invite.shareSource);
            successCount++;
            log('邀请', `[${i + 1}/${invites.length}] 已向 uid=${invite.uid} 发送好友申请`);
        } catch (e: any) {
            failCount++;
            logWarn('邀请', `[${i + 1}/${invites.length}] 向 uid=${invite.uid} 发送申请失败: ${e.message}`);
        }

        // 每个请求之间延迟，避免请求过快被限流
        if (i < invites.length - 1) {
            await sleep(INVITE_REQUEST_DELAY);
        }
    }

    log('邀请', `处理完成: 成功 ${successCount}, 失败 ${failCount}`);

}

module.exports = {
    sendReportArkClick,
    processInviteCodes,
};
