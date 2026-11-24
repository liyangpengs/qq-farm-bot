import type { QqBotPushConfig, QqBotPushUser } from '../types/config';

/** QQ 机器人事件白名单（键为日志 meta.event，值为推送面板展示名）。 */
export const QQ_BOT_EVENT_LABELS: Record<string, string> = {
    // 出售
    sell_success: '出售成功',
    '出售成功': '出售成功',
    sell_done: '仓库出售',
    // 照顾好友
    '照顾好友': '照顾好友',
    friend_care: '照顾好友',
    // 农场任务
    '领取任务': '农场任务',
    '扫描任务': '农场任务',
    farm_task: '农场任务',
    // 牧场任务
    ranch_task_claim: '牧场任务',
    ranch_task_report: '牧场任务',
    '牧场任务': '牧场任务',
    // 偷取好友牧场
    ranch_steal: '偷取牧场',
    '偷取牧场': '偷取牧场',
    // 清理好友牧场
    ranch_cleanFriend: '清理好友牧场',
    '清理好友牧场': '清理好友牧场',
    // 收获作物
    '收获作物': '收获作物',
    harvest_crop: '收获作物',
    '施肥后收获作物': '收获作物',
    // 神秘商人
    '神秘商人自动购买': '神秘商人',
    mystery_shop_purchase: '神秘商人',
};

export const QQ_BOT_EVENT_KEYS = new Set(Object.keys(QQ_BOT_EVENT_LABELS));

/** 面板默认勾选的事件（与前端 QQ_BOT_EVENT_OPTIONS 保持一致）。 */
export const DEFAULT_QQ_BOT_EVENT_KEYS = [
    'sell_success', '照顾好友', '领取任务', 'ranch_task_claim',
    'ranch_steal', '收获作物', '神秘商人自动购买',
];

export function defaultQqBotPushConfig(): QqBotPushConfig {
    return {
        // 渠道总开关默认关闭：面板里打开「推送渠道 → QQ 机器人推送」才会出现设置卡片
        channelEnabled: false,
        enabled: false,
        appId: '',
        appSecret: '',
        openid: '',
        eventKeys: [...DEFAULT_QQ_BOT_EVENT_KEYS],
        batchWindowSec: 60,
        dailyLimit: 800,
        minuteLimit: 8,
        includeIcons: true,
        includeAvatars: true,
        showAccount: true,
        offlineNotify: true,
        // 机器人扫码重登暂未开放，默认关闭（入口处也已统一拦截）
        reloginEnabled: false,
        accountRoutes: {},
    };
}

const LIMITS = {
    batchWindowSec: [5, 600],
    dailyLimit: [1, 1000],
    minuteLimit: [1, 20],
} as const;

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizeAccountRoutes(input: unknown): Record<string, string[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, value]) => [
        String(key),
        Array.isArray(value) ? value.map(item => String(item)) : [],
    ]));
}

function normalizeUsers(input: unknown): QqBotPushUser[] | undefined {
    if (!Array.isArray(input)) return undefined;
    return input
        .filter(item => item && typeof item === 'object')
        .map(item => ({
            openid: String((item as any).openid ?? '').trim(),
            nickname: String((item as any).nickname ?? '').trim(),
            avatar: String((item as any).avatar ?? '').trim(),
            lastSeenAt: Number((item as any).lastSeenAt) || 0,
        }))
        .filter(item => Boolean(item.openid));
}

/** 归一化 QQ 机器人推送配置；非法值与越界数值回落默认值。 */
export function normalizeQqBotPushConfig(input?: Partial<QqBotPushConfig> | null): QqBotPushConfig {
    const defaults = defaultQqBotPushConfig();
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const rawKeys = Array.isArray(src.eventKeys) ? src.eventKeys : defaults.eventKeys;
    const eventKeys = rawKeys
        .map((key: unknown) => String(key))
        .filter((key: string) => QQ_BOT_EVENT_KEYS.has(key));

    return {
        channelEnabled: typeof src.channelEnabled === 'boolean' ? src.channelEnabled : defaults.channelEnabled,
        enabled: typeof src.enabled === 'boolean' ? src.enabled : defaults.enabled,
        appId: String(src.appId ?? defaults.appId).trim(),
        appSecret: String(src.appSecret ?? defaults.appSecret).trim(),
        openid: String(src.openid ?? defaults.openid).trim(),
        eventKeys: eventKeys.length ? Array.from(new Set(eventKeys)) : [...defaults.eventKeys],
        batchWindowSec: clampInt(src.batchWindowSec, LIMITS.batchWindowSec, defaults.batchWindowSec),
        dailyLimit: clampInt(src.dailyLimit, LIMITS.dailyLimit, defaults.dailyLimit),
        minuteLimit: clampInt(src.minuteLimit, LIMITS.minuteLimit, defaults.minuteLimit),
        includeIcons: typeof src.includeIcons === 'boolean' ? src.includeIcons : defaults.includeIcons,
        includeAvatars: typeof src.includeAvatars === 'boolean' ? src.includeAvatars : defaults.includeAvatars,
        showAccount: typeof src.showAccount === 'boolean' ? src.showAccount : defaults.showAccount,
        offlineNotify: typeof src.offlineNotify === 'boolean' ? src.offlineNotify : defaults.offlineNotify,
        reloginEnabled: typeof src.reloginEnabled === 'boolean' ? src.reloginEnabled : defaults.reloginEnabled,
        accountRoutes: normalizeAccountRoutes(src.accountRoutes),
        discoveredUsers: normalizeUsers(src.discoveredUsers),
    };
}
