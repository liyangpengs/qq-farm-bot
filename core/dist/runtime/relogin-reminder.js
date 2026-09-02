"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function createReloginReminderService(options) {
    const { store, sendPushooMessage, log } = options;
    function getOfflineAutoDeleteMs() {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        const sec = Math.max(0, Number.parseInt(cfg?.offlineDeleteSec, 10) || 0);
        return sec === 0 ? Infinity : sec * 1000;
    }
    function resolvePushChannel() {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        if (!cfg)
            return { ok: false, reason: '未找到下线提醒配置' };
        const channel = String(cfg.channel || '').trim().toLowerCase();
        const endpoint = String(cfg.endpoint || '').trim();
        const token = String(cfg.token || '').trim();
        const secret = String(cfg.secret || '').trim();
        if (!channel)
            return { ok: false, reason: '下线提醒配置不完整' };
        if (channel === 'webhook' && !endpoint)
            return { ok: false, reason: 'Webhook 渠道未设置接口地址' };
        if (channel === 'dingtalk' && !endpoint && !token)
            return { ok: false, reason: '钉钉渠道未设置 Webhook 地址' };
        if (channel !== 'webhook' && channel !== 'dingtalk' && !token)
            return { ok: false, reason: '下线提醒渠道未设置 Token' };
        return { ok: true, channel, endpoint, token, secret };
    }
    async function sendConfiguredPush(payload = {}) {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const baseTitle = String(payload.title || '').trim();
        const content = String(payload.content || '').trim();
        const title = accountName ? `${baseTitle} ${accountName}` : baseTitle;
        const logLabel = String(payload.logLabel || '事件提醒').trim() || '事件提醒';
        try {
            const channelCfg = resolvePushChannel();
            if (channelCfg.ok === false) {
                log('错误', channelCfg.reason);
                return;
            }
            if (!title || !content) {
                log('错误', '推送标题或内容为空');
                return;
            }
            const result = await sendPushooMessage({
                channel: channelCfg.channel,
                endpoint: channelCfg.endpoint,
                token: channelCfg.token,
                secret: channelCfg.secret,
                title,
                content,
            });
            if (result?.ok) {
                log('系统', `${logLabel}发送成功: ${accountName || accountId || title}`);
            }
            else {
                log('错误', `${logLabel}发送失败: ${result?.msg || 'unknown'}`);
            }
        }
        catch (e) {
            log('错误', `${logLabel}发送异常: ${e.message}`);
        }
    }
    async function triggerOfflineReminder(payload = {}) {
        try {
            const accountId = String(payload.accountId || '').trim();
            const accountName = String(payload.accountName || '').trim();
            const reason = String(payload.reason || 'unknown');
            log('系统', `触发下线提醒: 账号=${accountName || accountId}, 原因=${reason}`, { accountId, accountName, reason });
            const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
            if (!cfg) {
                log('错误', '未找到下线提醒配置');
                return;
            }
            const baseTitle = String(cfg.title || '').trim();
            const content = String(cfg.msg || '').trim();
            if (!baseTitle || !content) {
                log('错误', '下线提醒配置不完整');
                return;
            }
            await sendConfiguredPush({ title: baseTitle, content, accountId, accountName, logLabel: '下线提醒' });
        }
        catch (e) {
            log('错误', `下线提醒发送异常: ${e.message}`);
        }
    }
    return { getOfflineAutoDeleteMs, triggerOfflineReminder, sendConfiguredPush };
}
module.exports = { createReloginReminderService };
//# sourceMappingURL=relogin-reminder.js.map