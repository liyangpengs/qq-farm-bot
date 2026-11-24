import type { OfflineReminder, OfflineReminderChannel } from '../types/config';

export const PUSHOO_CHANNELS = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher', 'meow',
]);

export function normalizePushChannel(input: Partial<OfflineReminderChannel>): OfflineReminderChannel {
    const channel = String(input.channel ?? '').trim().toLowerCase();
    let endpoint = String(input.endpoint ?? '').trim();
    let token = String(input.token ?? '').trim();
    const secret = String(input.secret ?? '').trim();
    if (channel === 'dingtalk' && token) {
        endpoint ||= /^https?:\/\//i.test(token) ? token : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}`;
        token = '';
    }
    return { channel, endpoint, token, secret, enabled: input.enabled === true };
}

export function isPushChannelConfigured(entry: OfflineReminderChannel): boolean {
    return Boolean(entry.channel === 'webhook' || entry.channel === 'dingtalk' ? entry.endpoint : entry.token);
}

export function readPushChannels(config: Partial<OfflineReminder>): OfflineReminderChannel[] {
    // 早期配置把渠道名存放在 endpoint，钉钉则可能只保存了 access token。
    const oldName = String(config.endpoint ?? '').trim().toLowerCase();
    const namedEndpoint = !config.channel && PUSHOO_CHANNELS.has(oldName);
    const entries = Array.isArray(config.channels) ? config.channels : [{
        ...config, channel: config.channel || (namedEndpoint ? oldName : 'webhook'),
        endpoint: namedEndpoint ? '' : config.endpoint, enabled: true,
    }];
    const channels = new Map<string, OfflineReminderChannel>();
    for (const raw of entries) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = normalizePushChannel(raw);
        if (!PUSHOO_CHANNELS.has(entry.channel) || !(entry.endpoint || entry.token || entry.secret)) continue;
        entry.enabled &&= isPushChannelConfigured(entry);
        channels.set(entry.channel, entry);
    }
    return [...channels.values()];
}

export function singlePushChannel(saved: OfflineReminder, update: Partial<OfflineReminderChannel>): OfflineReminderChannel {
    const channel = String(update.channel ?? saved.channel).trim().toLowerCase();
    const existing = saved.channels.find(entry => entry.channel === channel);
    return normalizePushChannel({ ...existing, ...update, channel, enabled: update.enabled ?? true });
}
