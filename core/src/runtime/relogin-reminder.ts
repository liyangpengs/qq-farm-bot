import type { PushNotification } from '../config/notification-types';
import { normalizeNotificationTypes } from '../config/notification-types';
import { readPushChannels } from '../config/push-channels';
const { sendPushChannels } = require('../services/push');

interface ReloginReminderOptions {
    store: any;
    sendPushooMessage: (payload: any) => Promise<any>;
    log: (tag: string, msg: string, extra?: any) => void;
}

interface OfflineReminderPayload {
    accountId?: string;
    accountName?: string;
    reason?: string;
    offlineMs?: number;
}

function createReloginReminderService(options: ReloginReminderOptions) {
    const { store, sendPushooMessage, log } = options;

    function getOfflineAutoDeleteMs(): number {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        const sec = Math.max(0, Number.parseInt(cfg?.offlineDeleteSec, 10) || 0);
        return sec === 0 ? Infinity : sec * 1000;
    }

    async function sendConfiguredPush(payload: { candidates?: PushNotification[]; title?: string; content?: string; accountId?: string; accountName?: string; logLabel?: string } = {}): Promise<void> {
        const cfg = store.getOfflineReminder();
        const enabled = normalizeNotificationTypes(cfg?.notificationTypes);
        // 同一轮仅发送第一条允许的提醒，优先保留原有的合并购买消息。
        const notification = payload.candidates ? payload.candidates.find(item => item && enabled[item.type] === true) : payload;
        if (!notification) return;
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const baseTitle = String(notification.title || '').trim();
        const content = String(notification.content || '').trim();
        const title = accountName ? `${baseTitle} ${accountName}` : baseTitle;
        const logLabel = String(payload.logLabel || '事件提醒').trim() || '事件提醒';
        try {
            const targets = readPushChannels(cfg || {}).filter(entry => entry.enabled);
            if (!targets.length) {
                log('错误', '未启用已配置的推送渠道');
                return;
            }
            if (!title || !content) {
                log('错误', '推送标题或内容为空');
                return;
            }
            const results = await sendPushChannels(targets, { title, content }, sendPushooMessage);
            for (const result of results) {
                const suffix = targets.length > 1 ? `（${result.channel}）` : '';
                if (result.ok) log('系统', `${logLabel}发送成功${suffix}: ${accountName || accountId || title}`);
                else log('错误', `${logLabel}发送失败${suffix}: ${result.msg}`);
            }
        } catch (e: any) {
            log('错误', `${logLabel}发送异常: ${e.message}`);
        }
    }

    async function triggerOfflineReminder(payload: OfflineReminderPayload = {}): Promise<void> {
        try {
            const accountId = String(payload.accountId || '').trim();
            const accountName = String(payload.accountName || '').trim();
            const reason = String(payload.reason || 'unknown');

            const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
            if (!cfg) {
                log('错误', '未找到下线提醒配置');
                return;
            }

            if (cfg.notificationTypes?.offline === false) return;
            log('系统', `触发下线提醒: 账号=${accountName || accountId}, 原因=${reason}`, { accountId, accountName, reason });
            const baseTitle = String(cfg.title || '').trim();
            const content = String(cfg.msg || '').trim();
            if (!baseTitle || !content) {
                log('错误', '下线提醒配置不完整');
                return;
            }

            await sendConfiguredPush({ title: baseTitle, content, accountId, accountName, logLabel: '下线提醒' });
        } catch (e: any) {
            log('错误', `下线提醒发送异常: ${e.message}`);
        }
    }

    return { getOfflineAutoDeleteMs, triggerOfflineReminder, sendConfiguredPush };
}

module.exports = { createReloginReminderService };
