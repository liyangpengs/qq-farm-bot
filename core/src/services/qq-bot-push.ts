export {};
/**
 * QQ 机器人单聊推送服务
 *
 * 负责：
 *  - access_token 获取与缓存（提前刷新）
 *  - WebSocket 网关连接，捕获用户单聊 openid（intents 1<<25）
 *  - 重要日志聚合、Markdown 组装、频控（每好友 20/qpm、1000/天）
 *  - 事件图标（游戏真实物品图）与好友头像图片的素材上传与 LRU 缓存
 *
 * 所有网络调用只依赖 core/package.json 已有的 axios 与 ws。
 * 事件白名单见 config/qq-bot-push.ts；配置持久化走 models/store。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');
const { WebSocket } = require('ws');
const { getResourcePath, getDataDir } = require('../config/runtime-paths');

const API_BASE = 'https://api.bot.qq.com';
const TOKEN_URL = `${API_BASE}/app/getAppAccessToken`;
const GATEWAY_URL = `${API_BASE}/gateway`;
const C2C_INTENTS = (1 << 25) | (1 << 26); // 1<<25: C2C_MESSAGE_CREATE; 1<<26: INTERACTION_CREATE（按钮回调）
const MAX_MEDIA_IMAGES = 90;  // 平台单机器人上限 100，留 10 张余量
const ICON_QUEUE_RETRY_LIMIT = 3;  // 图标未就绪时消息最多重排队次数
const MEDIA_DIR_NAME = 'qq-bot-media';
const WX_TARGET_APP_ID = 'wx5306c5978fdb76e4';
const RECORDS_FILE = 'qq-bot-records.json';
const MAX_PUSH_RECORDS = 500;

// 事件表与默认约定集中在 config/qq-bot-push.ts，避免多处维护
const { QQ_BOT_EVENT_LABELS: EVENT_LABELS, QQ_BOT_EVENT_KEYS } = require('../config/qq-bot-push');

const SUPPORTED_EVENTS: string[] = Array.from(QQ_BOT_EVENT_KEYS as Set<string>);

// 在消息文本里的每个物品名后插入图标（独立纯函数，便于测试）。
// 用单次正则扫描：按长度降序匹配，长词优先（避免"狐狸"拆掉"狐狸崽"），重复词全部命中。
const ICON_UPLOAD_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function decorateMessageWithIcons(
    msg: string,
    map: Map<string, string>,
    uploader: (localPath: string) => Promise<string>,
    onMissing?: (names: string[]) => void,
): Promise<string> {
    if (!msg || !map.size) { if (onMissing) onMissing([]); return msg; }
    // 这些名字在 gameConfig 里存在，但日志里多数是动词/单位，插图标会显得很怪
    const NON_ITEM_WORDS = new Set(['钻石', '点券', '牧草', '收获', '浇水']);
    const names = Array.from(map.keys())
        .filter(name => name && name.length >= 2 && !NON_ITEM_WORDS.has(name) && msg.includes(name))
        .sort((a, b) => b.length - a.length);
    if (!names.length) { if (onMissing) onMissing([]); return msg; }
    const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(escaped.join('|'), 'g');
    const hits: Array<{ token: string; name: string }> = [];
    const nameSet = new Set(names);
    const scanned = msg.replace(re, (matched: string) => {
        if (!nameSet.has(matched)) return matched;
        const token = `__QQBOT_ICON_${hits.length}__`;
        hits.push({ token, name: matched });
        return matched + token;
    });
    if (!hits.length) { if (onMissing) onMissing([]); return msg; }
    const uniqueNames = Array.from(new Set(hits.map(h => h.name)));
    const urlCache = new Map<string, string>();
    const missing: string[] = [];
    // 串行上传 + 有限退避重试：QQ 素材库并发上传会限流（status 400）。
    // 上传失败的名字汇总给 onMissing，让调用方决定重排队而不是静默丢图标。
    for (const name of uniqueNames) {
        const local = map.get(name) || '';
        if (!local) { urlCache.set(name, ''); missing.push(name); continue; }
        let url = '';
        for (let attempt = 0; attempt < ICON_UPLOAD_ATTEMPTS && !url; attempt++) {
            if (attempt > 0) await sleep(450 * attempt);
            url = await uploader(local);
        }
        urlCache.set(name, url);
        if (!url) missing.push(name);
    }
    if (onMissing) onMissing(missing);
    let result = scanned;
    for (const hit of hits) {
        const url = urlCache.get(hit.name) || '';
        result = result.replace(hit.token, url ? `![${hit.name} #20px #20px](${url})` : '');
    }
    return result;
}

interface QqBotUser {
  openid: string;
  nickname: string;
  avatar: string;
  lastSeenAt: number;
}

interface QqBotPushConfig {
    channelEnabled: boolean;
    enabled: boolean;
    appId: string;
    appSecret: string;
    openid: string;
    eventKeys: string[];
    batchWindowSec: number;
    dailyLimit: number;
    minuteLimit: number;
    includeIcons: boolean;
    includeAvatars: boolean;
    showAccount: boolean;
    offlineNotify: boolean;   // 账号下线时推送
    reloginEnabled: boolean;  // 下线消息是否带重新登录按钮
    accountRoutes: Record<string, string[]>;  // 账号ID -> 接收用户 openid 列表
}

interface RuntimeStatus {
    connected: boolean;
    connecting: boolean;
    openid: string;
    lastError: string;
    lastCaptchaAt: number;
    tokenReady: boolean;
    sentToday: number;
    sentThisMinute: number;
    queued: number;
    mediaCount: number;
    users: QqBotUser[];
    // 支持多账号同时等待扫码（按账号隔离），因此改为列表
    relogin: Array<{ active: boolean; accountId: string; stage: string; startedAt: number }>;
}

interface PushRecord {
    id: string;
    time: string;      // ISO 时间
    dateKey: string;   // YYYY-MM-DD，便于按天筛选
    accountId: string;
    accountName: string;
    recipientOpenid: string;
    recipientName: string;
    content: string;   // 发出的 markdown
    itemCount: number;
}

interface ReloginSession {
    accountId: string;
    accountName: string;
    stage: string;
    startedAt: number;
    session: any;
    wx: any;
}

// 活动实例引用：供 admin 路由访问（无需改动 provider/context 链路）
let activeService: any = null;

const DEFAULT_APP_ID = '';
const DEFAULT_EVENT_KEYS = ['sell_success', '照顾好友', '领取任务', 'ranch_task_claim', 'ranch_steal', 'ranch_cleanFriend', '收获作物', '神秘商人自动购买'];

function createQqBotPushService(options: any = {}) {
    const store = options.store;
    const log: (tag: string, msg: string, extra?: any) => void = typeof options.log === 'function'
        ? options.log
        : () => {};
    // 重新登录依赖：由 runtime-engine 注入
    const deps = {
        getAccount: typeof options.getAccount === 'function' ? options.getAccount : (id: string) => null,
        reloginAccount: typeof options.reloginAccount === 'function' ? options.reloginAccount : null,
        wxRelogin: typeof options.wxRelogin === 'function' ? options.wxRelogin : null,
        wxReloginHasBuffer: typeof options.wxReloginHasBuffer === 'function' ? options.wxReloginHasBuffer : null,
    };

    let config: QqBotPushConfig = normalizeConfig(store && store.getQqBotPush ? store.getQqBotPush() : {});
    let timer: any = null;
    let ws: any = null;
    let stopped = true;
    let reconnectDelayMs = 3000;
    let heartbeatTimer: any = null;
    let lastSeq: number | null = null;
    let sessionId = '';
    let tokenCache: { token: string; expiresAt: number } | null = null;
    let useLegacyTokenFormat = false; // op=9 时切换为 Bot {appid}.{token} 格式

    // 已发现用户（给机器人发过消息的人），持久化到 store
    const rawConfig: any = store && store.getQqBotPush ? store.getQqBotPush() : {};
    let discoveredUsers: QqBotUser[] = Array.isArray(rawConfig.discoveredUsers) ? rawConfig.discoveredUsers : [];
    // 当前进行中的扫码重新登录会话：按账号 ID 隔离，避免多账号互相顶掉二维码
    const reloginSessions = new Map<string, ReloginSession>();
    // 等待扫码最长时长：到点后直接停止等待并清理会话
    const QR_WAIT_TIMEOUT_MS = 110_000;

    const queue: any[] = [];
    const minuteBuckets: number[] = []; // 最近 60 秒发送时间戳
    let sentToday = 0;
    let sentDayKey = '';

    const mediaCache: Map<string, string> = new Map(); // key -> qqbot-media:// url
    const mediaMeta: Map<string, { imageId: string; file: string; lastUsed: number; localPath?: string }> = new Map();
    let mediaLoaded = false;

    // 推送记录（供面板「推送统计」查看）：持久化到 data/qq-bot-records.json
    let pushRecords: PushRecord[] = loadPushRecords();

    // 用本地时区生成 YYYY-MM-DD（toISOString 是 UTC，东八区 08:00 前会差一天）
    function toLocalDateKey(date: Date): string {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function loadPushRecords(): PushRecord[] {
        try {
            const { readJsonFileStrict } = require('../services/json-db');
            const nodePath = require('node:path');
            const file = nodePath.join(require('../config/runtime-paths').getDataDir(), RECORDS_FILE);
            const data = readJsonFileStrict(file, () => ({ records: [] }));
            if (!Array.isArray(data?.records)) return [];
            // 存量记录的 dateKey 可能是 UTC 日期，按 time 重新推导本地日期修正
            return data.records.map((r: any) => {
                const fixed = r?.time ? toLocalDateKey(new Date(r.time)) : r?.dateKey;
                return fixed && fixed !== r.dateKey ? { ...r, dateKey: fixed } : r;
            }).slice(-MAX_PUSH_RECORDS);
        } catch { return []; }
    }

    function savePushRecords(): void {
        try {
            const { writeJsonFileAtomic } = require('../services/json-db');
            const path = require('node:path');
            const file = path.join(require('../config/runtime-paths').getDataDir(), RECORDS_FILE);
            writeJsonFileAtomic(file, { records: pushRecords.slice(-MAX_PUSH_RECORDS) });
        } catch {}
    }

    function recordSent(payload: Omit<PushRecord, 'id' | 'time' | 'dateKey'>): void {
        const now = new Date();
        pushRecords.push({
            ...payload,
            id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
            time: now.toISOString(),
            dateKey: toLocalDateKey(now),
        });
        if (pushRecords.length > MAX_PUSH_RECORDS) pushRecords = pushRecords.slice(-MAX_PUSH_RECORDS);
        savePushRecords();
    }

    const status: RuntimeStatus = {
        connected: false,
        connecting: false,
        openid: config.openid || '',
        lastError: '',
        lastCaptchaAt: 0,
        tokenReady: false,
        sentToday: 0,
        sentThisMinute: 0,
        queued: 0,
        mediaCount: 0,
        users: [],
        relogin: [],
    };

    function normalizeConfig(input: any): QqBotPushConfig {
        const src = input && typeof input === 'object' ? input : {};
        const windowSec = Number.parseInt(src.batchWindowSec, 10);
        const daily = Number.parseInt(src.dailyLimit, 10);
        const minute = Number.parseInt(src.minuteLimit, 10);
        const eventKeys = Array.isArray(src.eventKeys)
            ? src.eventKeys.map((k: any) => String(k)).filter((k: string) => SUPPORTED_EVENTS.includes(k))
            : DEFAULT_EVENT_KEYS.slice();
        return {
            // 渠道总开关：关闭时卡片隐藏、服务不启动
            channelEnabled: typeof src.channelEnabled === 'boolean' ? src.channelEnabled : false,
            enabled: typeof src.enabled === 'boolean' ? src.enabled : false,
            appId: String(src.appId ?? DEFAULT_APP_ID).trim(),
            appSecret: String(src.appSecret ?? '').trim(),
            openid: String(src.openid ?? '').trim(),
            eventKeys: eventKeys.length ? Array.from(new Set(eventKeys)) : DEFAULT_EVENT_KEYS.slice(),
            batchWindowSec: Number.isFinite(windowSec) && windowSec >= 5 && windowSec <= 600 ? windowSec : 60,
            dailyLimit: Number.isFinite(daily) && daily >= 1 && daily <= 1000 ? daily : 800,
            minuteLimit: Number.isFinite(minute) && minute >= 1 && minute <= 20 ? minute : 8,
            includeIcons: typeof src.includeIcons === 'boolean' ? src.includeIcons : true,
            includeAvatars: typeof src.includeAvatars === 'boolean' ? src.includeAvatars : true,
            showAccount: typeof src.showAccount === 'boolean' ? src.showAccount : true,
            offlineNotify: typeof src.offlineNotify === 'boolean' ? src.offlineNotify : true,
            // 机器人扫码重登暂未开放，默认关闭（入口处也已统一拦截）
            reloginEnabled: typeof src.reloginEnabled === 'boolean' ? src.reloginEnabled : false,
            accountRoutes: (src.accountRoutes && typeof src.accountRoutes === 'object' && !Array.isArray(src.accountRoutes))
                ? Object.fromEntries(Object.entries(src.accountRoutes).map(([k, v]) => [String(k), Array.isArray(v) ? v.map((x: any) => String(x)) : []]))
                : {},
        };
    }

    function persistUsers(): void {
        if (!store || !store.setQqBotPush) return;
        try {
            store.setQqBotPush({ ...config, discoveredUsers } as any);
        } catch {}
    }

    function getConfig(): QqBotPushConfig {
        return { ...config, eventKeys: [...config.eventKeys] };
    }

    // 账号的接收用户列表：优先用 accountRoutes 配置，否则用默认 openid
    function getRecipientsForAccount(accountId: string): string[] {
        const key = String(accountId || '');
        const routed = config.accountRoutes[key];
        if (Array.isArray(routed) && routed.length) return routed.filter(o => !!o);
        return config.openid ? [config.openid] : [];
    }

    function setConfig(input: any): QqBotPushConfig {
        const next = normalizeConfig({ ...config, ...(input || {}) });
        const secretChanged = next.appSecret !== config.appSecret || next.appId !== config.appId;
        config = next;
        status.openid = config.openid || '';
        if (store && store.setQqBotPush) {
            try { store.setQqBotPush({ ...config, discoveredUsers }); } catch (e: any) { log('QQ机器人', `保存配置失败: ${e.message}`); }
        }
        if (secretChanged) {
            tokenCache = null;
            status.tokenReady = false;
        }
        if (config.enabled && config.channelEnabled) start(); else stop();
        return getConfig();
    }

    function getDayKey(): string {
        const d = new Date();
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    }

    function checkDayReset(): void {
        const key = getDayKey();
        if (key !== sentDayKey) {
            sentDayKey = key;
            sentToday = 0;
        }
        status.sentToday = sentToday;
        const now = Date.now();
        while (minuteBuckets.length && now - minuteBuckets[0] > 60000) minuteBuckets.shift();
        status.sentThisMinute = minuteBuckets.length;
    }

    async function getToken(force: boolean = false): Promise<string> {
        if (!config.appId || !config.appSecret) throw new Error('请先填写 AppID 和 AppSecret');
        const now = Date.now();
        if (!force && tokenCache && tokenCache.expiresAt - now > 60 * 1000) return tokenCache.token;
        const resp = await axios.post(TOKEN_URL, {
            appId: config.appId,
            clientSecret: config.appSecret,
        }, { timeout: 15000, proxy: false });
        const token = resp?.data?.access_token;
        if (!token) throw new Error(`获取 access_token 失败: ${JSON.stringify(resp?.data || {})}`);
        const expiresIn = Number(resp?.data?.expires_in || 7200);
        tokenCache = { token, expiresAt: now + expiresIn * 1000 };
        status.tokenReady = true;
        return token;
    }

    function authHeaders(token: string): Record<string, string> {
        return {
            'Authorization': `QQBot ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
        };
    }

    // ---------- 用户识别 ----------
    function recordUser(user: QqBotUser): void {
        if (!user.openid) return;
        const idx = discoveredUsers.findIndex(u => u.openid === user.openid);
        if (idx >= 0) {
            discoveredUsers[idx] = { ...discoveredUsers[idx], ...user };
        } else {
            discoveredUsers.push(user);
        }
        // 只保留最近 50 个用户
        if (discoveredUsers.length > 50) discoveredUsers = discoveredUsers.slice(-50);
        status.users = getUsers();
        persistUsers();
    }

    function getUsers(): QqBotUser[] {
        return discoveredUsers.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }

    // 删除接收用户：同时清理账号路由与默认用户引用
    function deleteUser(openid: string): { defaultChanged: boolean; newDefault: string } {
        const target = String(openid || '');
        if (!target) throw new Error('openid 不能为空');
        const before = discoveredUsers.length;
        discoveredUsers = discoveredUsers.filter(u => u.openid !== target);
        if (discoveredUsers.length === before) throw new Error('未找到该用户');

        // 清理账号路由里对该用户的引用
        const routes: Record<string, string[]> = {};
        for (const [accountId, list] of Object.entries(config.accountRoutes || {})) {
            routes[accountId] = (list || []).filter(o => o !== target);
        }
        config = { ...config, accountRoutes: routes };

        // 若删除的是默认用户，改用剩余最近的一个用户
        let defaultChanged = false;
        let newDefault = config.openid;
        if (config.openid === target) {
            const next = getUsers()[0];
            newDefault = next ? next.openid : '';
            config = { ...config, openid: newDefault };
            status.openid = newDefault;
            defaultChanged = true;
        }
        status.users = getUsers();
        persistUsers();
        return { defaultChanged, newDefault };
    }

    function openidFromInteraction(d: any): string {
        return String(d?.user_openid || '').trim();
    }

    // ---------- 互动回调（重新登录按钮） ----------
    async function acknowledgeInteraction(interactionId: string, code: number = 0): Promise<void> {
        if (!interactionId) return;
        try {
            const token = await getToken();
            await axios.put(`${API_BASE}/interactions/${encodeURIComponent(interactionId)}`,
                { code }, { headers: authHeaders(token), timeout: 10000 });
        } catch (e: any) {
            log('QQ机器人', `互动回应失败: ${e?.message || '未知错误'}`);
        }
    }

    async function handleInteraction(d: any, fromOpenid: string): Promise<void> {
        const interactionId = String(d?.id || '').replace(/^INTERACTION_CREATE:/, '');
        const resolved = d?.data?.resolved || {};
        const buttonData = String(resolved.button_data || '');
        const type = Number(d?.type || 0);
        if (type !== 11) return; // 仅处理消息按钮
        // 仅指定接收用户可操作
        if (config.openid && fromOpenid && fromOpenid !== config.openid) {
            await acknowledgeInteraction(interactionId, 4); // 无权限
            return;
        }
        await acknowledgeInteraction(interactionId, 0);

        let payload: any = {};
        try {
            const decoded = buttonData.startsWith('{') ? JSON.parse(buttonData) : JSON.parse(Buffer.from(buttonData, 'base64').toString('utf8'));
            payload = decoded || {};
        } catch {
            payload = { action: buttonData };
        }
        const action = String(payload.action || '');
        if (action === 'relogin' || action === 'refreshQr') {
            const accountId = String(payload.accountId || '');
            const account = deps.getAccount(accountId) || {};
            if (String(account.platform || '') !== 'wx') {
                await sendText('QQ 账号暂不支持机器人一键重新登录，请在 Web 面板处理。').catch(() => {});
                return;
            }
            // 先探测是否已有可用凭据；没有凭据或当前环境不支持免扫码换码时，直接推二维码
            let hasBuffer = false;
            try {
                if (deps.wxReloginHasBuffer) hasBuffer = await deps.wxReloginHasBuffer(accountId);
            } catch {}
            if (!deps.wxRelogin || !hasBuffer) {
                await sendText(
                    deps.wxRelogin
                        ? `账号「${account.name || accountId}」尚未保存扫码凭据，正在推送登录二维码…`
                        : `正在为账号「${account.name || accountId}」推送登录二维码…`,
                ).catch(() => {});
                await startQrRelogin(accountId, true);
                return;
            }

            await sendText(`正在为账号「${account.name || accountId}」重新获取登录 Code…`).catch(() => {});
            try {
                const result = await deps.wxRelogin(accountId);
                if (result?.ok) {
                    await sendText(`✅ 账号「${account.name || accountId}」已重新获取登录 Code 并上线。`).catch(() => {});
                } else if (result?.reason === 'no_buffer' || result?.reason === 'code_failed') {
                    // 凭据缺失或换 Code 失败（重启后 ticket 失效）：直接推二维码扫码
                    await sendText(`账号「${account.name || accountId}」扫码凭据已失效，正在推送登录二维码…`).catch(() => {});
                    await startQrRelogin(accountId, true);
                } else {
                    await sendText(`❌ 一键重新登录失败：${result?.message || '请稍后重试或在 Web 面板处理。'}`).catch(() => {});
                }
            } catch (e: any) {
                await sendText(`❌ 一键重新登录异常：${e?.message || '未知错误'}`).catch(() => {});
            }
            return;
        }
    }

    // ---------- 二维码重新登录（按账号隔离，入口暂未开放） ----------
    function syncReloginStatus(): void {
        status.relogin = Array.from(reloginSessions.values()).map(s => ({
            active: true,
            accountId: s.accountId,
            stage: s.stage,
            startedAt: s.startedAt,
        }));
    }

    // 只清理指定账号的会话，不影响其他正在等待扫码的账号
    function clearReloginSession(accountId: string, session?: any): boolean {
        const current = reloginSessions.get(accountId);
        if (!current || (session && current.session !== session)) return false;
        try { current.wx?.destroy(current.session); } catch {}
        reloginSessions.delete(accountId);
        syncReloginStatus();
        return true;
    }

    async function startQrRelogin(accountId: string, force: boolean = false): Promise<void> {
        if (!deps.reloginAccount) {
            await sendText('当前运行环境不支持从机器人重新登录，请在面板手动操作。');
            return;
        }
        const key = String(accountId || '');
        if (!key) return;
        const account = deps.getAccount(key) || {};
        const accountName = String(account.name || key);
        const existing = reloginSessions.get(key);
        // 同一账号重复请求时仍等待中不重复创建；其他账号请求不受影响
        if (!force && existing && Date.now() - existing.startedAt < QR_WAIT_TIMEOUT_MS - 10_000) {
            await sendText(`账号「${accountName}」的登录二维码仍在等待扫码，请勿重复点击。`, buildRefreshQrKeyboard(key));
            return;
        }
        clearReloginSession(key);

        const { WxLoginService } = require('../services/wx-login/service');
        const wx = new WxLoginService();
        const { session, qr } = await wx.createQrSession();
        reloginSessions.set(key, {
            accountId: key,
            accountName,
            stage: 'waiting',
            startedAt: Date.now(),
            session,
            wx,
        });
        syncReloginStatus();

        // 上传二维码图片到素材库
        const qrUrl = await uploadImageBuffer(qr, 'qr');
        const qrMarkdown = [
            `## 🔄 重新登录：${accountName}`,
            '> 请用微信扫描下方二维码完成登录',
            '',
            qrUrl ? `![扫码登录 #240px #240px](${qrUrl})` : '> 二维码图片生成失败，请在面板手动登录',
            '',
            '扫码并在手机上确认后，账号将自动重新上线。二维码过期可点击下方按钮刷新。',
        ].join('\n');
        await sendMarkdown(qrUrl ? qrMarkdown : qrMarkdown.replace(/!\[[^\n]*\]\([^\n]*\)/g, ''), buildRefreshQrKeyboard(key));
        log('QQ机器人', `已推送账号「${accountName}」的重登二维码，等待扫码`);

        // 每个账号的轮询相互独立，失败/超时只清理自己
        void pollQrRelogin(key, accountName, wx, session).catch(async (e: any) => {
            // 会话已被同账号的新请求替换：旧轮询的报错静默丢弃，避免误发失败提示
            if (reloginSessions.get(key)?.session !== session) return;
            clearReloginSession(key, session);
            log('QQ机器人', `账号「${accountName}」扫码登录流程失败: ${e?.message || '未知错误'}`);
            await sendText(`账号「${accountName}」扫码登录失败：${e?.message || '未知错误'}。点击下方按钮重试：`, buildRefreshQrKeyboard(key)).catch(() => {});
        });
    }

    async function pollQrRelogin(accountId: string, accountName: string, wx: any, session: any): Promise<void> {
        const deadline = Date.now() + QR_WAIT_TIMEOUT_MS;
        let scanStatus = 'waiting';
        while (Date.now() < deadline) {
            // 本账号会话已被替换/清理：立即停止等待，不影响其他账号
            if (!reloginSessions.has(accountId) || reloginSessions.get(accountId)!.session !== session) return;
            // poll 是长轮询（最长 35s），这里不再额外 sleep
            scanStatus = await wx.poll(session);
            const after = reloginSessions.get(accountId);
            if (!after || after.session !== session) return;
            after.stage = scanStatus;
            syncReloginStatus();
            if (scanStatus === 'authorized') break;
            if (scanStatus === 'cancelled' || scanStatus === 'expired') {
                clearReloginSession(accountId, session);
                const reason = scanStatus === 'cancelled' ? '扫码已取消' : '二维码已过期';
                await sendText(`账号「${accountName}」${reason}。点击下方按钮获取最新二维码：`, buildRefreshQrKeyboard(accountId)).catch(() => {});
                return;
            }
        }
        // 超时：直接停止等待并清理本账号会话
        if (scanStatus !== 'authorized') {
            clearReloginSession(accountId, session);
            await sendText(`账号「${accountName}」扫码超时，已停止等待。点击下方按钮获取最新二维码：`, buildRefreshQrKeyboard(accountId)).catch(() => {});
            return;
        }
        // 确认并换取 code（确认前再校验一次，避免与新请求竞态）
        if (reloginSessions.get(accountId)?.session !== session) return;
        reloginSessions.get(accountId)!.stage = 'confirming';
        syncReloginStatus();
        await wx.confirm(session);
        const code = await wx.issueCode(session, WX_TARGET_APP_ID);
        // 用新 code 更新账号并重新上线；同时保存 loginBuffer，以后可免扫码
        const account = deps.getAccount(accountId) || {};
        const success = await deps.reloginAccount(accountId, {
            code,
            platform: 'wx',
            loginType: 'manual',
            name: account.name || accountName,
            wxLoginBuffer: session.loginBuffer || '',
        });
        clearReloginSession(accountId, session);
        if (success) {
            await sendText(`✅ 账号「${accountName}」扫码登录成功，已重新上线。登录凭据已保存，下次掉线可直接点「重新登录」免扫码上线。`);
            log('QQ机器人', `账号「${accountName}」扫码登录成功并重新上线（已保存登录凭据）`);
        } else {
            await sendText(`账号「${accountName}」登录信息已更新，但自动上线失败，请在面板启动账号。`);
        }
    }

    // ---------- WebSocket 网关：捕获用户 openid ----------
    async function connectGateway(): Promise<void> {
        if (!config.enabled || !config.appId || !config.appSecret) return;
        if (stopped || ws || status.connecting) return;
        status.connecting = true;
        try {
            const token = await getToken();
            if (stopped) { status.connecting = false; return; }
            const gwResp = await axios.get(GATEWAY_URL, { headers: authHeaders(token), timeout: 15000 });
            const url = gwResp?.data?.url || 'wss://api.bot.qq.com/websocket/';
            log('QQ机器人', '正在连接网关以捕获单聊 openid...');
            const socket = new WebSocket(url);
            ws = socket;
            let helloReceived = false;

            const clearHeartbeat = () => {
                if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
            };

            socket.on('open', () => { /* wait for Hello */ });

            socket.on('message', (raw: any) => {
                let pkt: any;
                try { pkt = JSON.parse(raw.toString()); } catch { return; }
                const op = pkt.op;
                const d = pkt.d || {};
                if (op === 10) {
                    if (helloReceived) return;
                    helloReceived = true;
                    status.connected = true;
                    status.connecting = false;
                    status.lastError = '';
                    reconnectDelayMs = 3000;
                    const tokenValue = useLegacyTokenFormat
                        ? `Bot ${config.appId}.${token}`
                        : `QQBot ${token}`;
                    if (sessionId && lastSeq !== null) {
                        socket.send(JSON.stringify({ op: 6, d: { token: tokenValue, session_id: sessionId, seq: lastSeq } }));
                    } else {
                        socket.send(JSON.stringify({
                            op: 2,
                            d: {
                                token: tokenValue,
                                intents: C2C_INTENTS,
                                shard: [0, 1],
                                properties: { $os: 'windows', $browser: 'qq-farm-bot', $device: 'qq-farm-bot' },
                            },
                        }));
                    }
                    const interval = Number(d.heartbeat_interval || 45000);
                    clearHeartbeat();
                    heartbeatTimer = setInterval(() => {
                        if (socket.readyState === socket.OPEN) {
                            socket.send(JSON.stringify({ op: 1, d: lastSeq }));
                        }
                    }, Math.max(5000, interval - 5000));
                    log('QQ机器人', '网关已连接');
                    return;
                }
                if (typeof pkt.s === 'number') lastSeq = pkt.s;
                if (op === 0) {
                    if (pkt.t === 'READY') {
                        sessionId = String(d.session_id || '');
                    } else if (pkt.t === 'C2C_MESSAGE_CREATE' || pkt.t === 'C2C_MSG_RECEIVE') {
                        const author = d.author || {};
                        const openid = String(author.user_openid || author.id || '').trim();
                        if (openid) {
                            recordUser({
                                openid,
                                nickname: String(author.username || '').trim(),
                                avatar: String(author.avatar || '').trim(),
                                lastSeenAt: Date.now(),
                            });
                            // 仅在尚未指定接收用户时，自动绑定第一个发消息的人
                            if (!config.openid) {
                                config = { ...config, openid };
                                status.openid = openid;
                                persistUsers();
                                log('QQ机器人', `已捕获单聊 openid: ${openid.slice(0, 8)}...`);
                            }
                        }
                    } else if (pkt.t === 'C2C_MSG_REJECT') {
                        status.lastCaptchaAt = Date.now();
                        log('QQ机器人', '用户关闭了主动消息推送');
                    } else if (pkt.t === 'INTERACTION_CREATE') {
                        handleInteraction(d, openidFromInteraction(d)).catch(() => {});
                    }
                } else if (op === 1) {
                    socket.send(JSON.stringify({ op: 11 }));
                } else if (op === 7) {
                    clearHeartbeat();
                    try { socket.close(); } catch {}
                } else if (op === 9) {
                    // 鉴权失败：切换 token 格式后重连（仅切换一次，避免死循环）
                    if (!useLegacyTokenFormat) {
                        useLegacyTokenFormat = true;
                        log('QQ机器人', '网关鉴权格式不兼容，已切换为兼容格式重试');
                    }
                    sessionId = '';
                    lastSeq = null;
                    clearHeartbeat();
                    helloReceived = false;
                    try { socket.close(); } catch {}
                }
            });

            socket.on('error', (err: any) => {
                status.lastError = String(err?.message || '网关连接错误');
                log('QQ机器人', `网关错误: ${status.lastError}`);
            });

            socket.on('close', () => {
                clearHeartbeat();
                if (ws === socket) ws = null;
                status.connected = false;
                status.connecting = false;
                if (!stopped && config.enabled) {
                    const delay = reconnectDelayMs;
                    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 120000);
                    setTimeout(() => { connectGateway().catch(() => {}); }, delay);
                }
            });
        } catch (e: any) {
            status.connecting = false;
            status.connected = false;
            status.lastError = String(e?.message || '网关连接失败');
            log('QQ机器人', `网关连接失败: ${status.lastError}`);
            if (!stopped && config.enabled) {
                setTimeout(() => { connectGateway().catch(() => {}); }, reconnectDelayMs);
                reconnectDelayMs = Math.min(reconnectDelayMs * 2, 120000);
            }
        }
    }

    function disconnectGateway(): void {
        status.connected = false;
        status.connecting = false;
        if (ws) {
            try { ws.close(); } catch {}
            ws = null;
        }
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    // ---------- 素材管理：上传图片换 qqbot-media:// ----------
    function mediaFilePath(key: string): string {
        return path.join(getDataDir(), MEDIA_DIR_NAME, `${key}.json`);
    }

    function loadMediaCache(): void {
        if (mediaLoaded) return;
        mediaLoaded = true;
        try {
            const dir = path.join(getDataDir(), MEDIA_DIR_NAME);
            if (!fs.existsSync(dir)) return;
            for (const name of fs.readdirSync(dir)) {
                if (!name.endsWith('.json')) continue;
                try {
                    const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
                    if (!meta || !meta.key || !meta.url || !meta.imageId) continue;
                    mediaCache.set(meta.key, meta.url);
                    mediaMeta.set(meta.key, { imageId: meta.imageId, file: path.join(dir, name), lastUsed: Number(meta.lastUsed || Date.now()), localPath: meta.localPath || '' });
                } catch {}
            }
            status.mediaCount = mediaCache.size;
        } catch (e: any) {
            log('QQ机器人', `读取图片缓存失败: ${e.message}`);
        }
    }

    function persistMediaMeta(key: string, url: string, imageId: string, localPath = ''): void {
        try {
            const dir = path.join(getDataDir(), MEDIA_DIR_NAME);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const file = mediaFilePath(key);
            const meta = { key, url, imageId, localPath, lastUsed: Date.now() };
            fs.writeFileSync(file, JSON.stringify(meta), 'utf8');
            mediaMeta.set(key, { imageId, file, lastUsed: meta.lastUsed, localPath });
        } catch (e: any) {
            log('QQ机器人', `保存图片缓存失败: ${e.message}`);
        }
    }

    async function evictMediaIfNeeded(): Promise<void> {
        if (mediaCache.size < MAX_MEDIA_IMAGES) return;
        const entries = Array.from(mediaMeta.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        // 一次多淘汰几张，给平台配额留缓冲；等平台删除确认后再删本地缓存，
        // 避免「本地删了但平台配额没释放」导致后续新图上传 400。
        const toRemove = Math.max(5, mediaCache.size - MAX_MEDIA_IMAGES + 1);
        for (let i = 0; i < toRemove && i < entries.length; i++) {
            const [key, meta] = entries[i];
            let platformDeleted = true;
            try {
                const token = await getToken();
                await axios.delete(`${API_BASE}/v2/media-images/${encodeURIComponent(meta.imageId)}/delete`, {
                    headers: authHeaders(token), timeout: 10000, proxy: false,
                });
            } catch (e: any) {
                platformDeleted = false;
                log('QQ机器人', `平台素材删除失败(保留本地缓存): ${e?.message || e}`);
            }
            if (platformDeleted) {
                mediaCache.delete(key);
                mediaMeta.delete(key);
                try { if (fs.existsSync(meta.file)) fs.unlinkSync(meta.file); } catch {}
            }
        }
        status.mediaCount = mediaCache.size;
    }

    function resolveImageFile(localPath: string): string {
        if (!localPath) return '';
        // 注意：Windows 下 path.isAbsolute('/game-config/...') 会返回 true，
        // 必须先处理项目内的虚拟路径前缀，再判断真实绝对路径。
        if (localPath.startsWith('/game-config/')) {
            return getResourcePath('gameConfig', localPath.slice('/game-config/'.length));
        }
        if (path.isAbsolute(localPath)) return localPath;
        return getResourcePath(localPath.replace(/^\/+/, ''));
    }

    async function uploadBuffer(buf: Buffer, key: string, ext: string, contentType: string, label: string, localPath = ''): Promise<string> {
        loadMediaCache();
        const cached = mediaCache.get(key);
        if (cached) {
            const meta = mediaMeta.get(key);
            if (meta) { meta.lastUsed = Date.now(); }
            return cached;
        }
        if (!buf.length || buf.length > 10 * 1024 * 1024) return '';
        // 先腾出平台配额再上传：素材满时直接上传会 400
        await evictMediaIfNeeded();
        try {
            const token = await getToken();
            const md5 = crypto.createHash('md5').update(buf).digest('hex');
            const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
            const fileName = `${key}${ext}`;
            const prep = await axios.post(`${API_BASE}/v2/media-images/prepare`, {
                file_name: fileName,
                file_size: buf.length,
                content_type: contentType,
                md5,
                sha1,
            }, { headers: authHeaders(token), timeout: 15000, proxy: false });
            const uploadId = prep?.data?.upload_id;
            const presignedUrl = prep?.data?.presigned_url;
            if (!uploadId || !presignedUrl) return '';
            await axios.put(presignedUrl, buf, {
                headers: { 'Content-Type': contentType },
                timeout: 30000,
                maxBodyLength: Infinity,
                proxy: false,
            });
            const done = await axios.post(`${API_BASE}/v2/media-images/complete`, {
                upload_id: uploadId,
                md5,
            }, { headers: authHeaders(token), timeout: 15000, proxy: false });
            const url = done?.data?.url;
            const imageId = done?.data?.image_id;
            if (!url || !imageId) return '';
            mediaCache.set(key, url);
            persistMediaMeta(key, url, imageId, localPath);
            status.mediaCount = mediaCache.size;
            return url;
        } catch (e: any) {
            let detail = String(e?.message || '未知错误');
            const respData = e?.response?.data;
            if (respData) {
                try { detail += ` body=${typeof respData === 'string' ? respData.slice(0, 200) : JSON.stringify(respData).slice(0, 200)}`; } catch {}
            }
            log('QQ机器人', `图片上传失败(${label}): ${detail}`);
            return '';
        }
    }

    async function uploadImage(localPath: string): Promise<string> {
        if (!localPath) return '';
        const key = crypto.createHash('sha1').update(String(localPath)).digest('hex');
        const file = resolveImageFile(localPath);
        if (!file || !fs.existsSync(file)) return '';
        let buf: Buffer;
        try { buf = fs.readFileSync(file); } catch { return ''; }
        const ext = path.extname(file).toLowerCase();
        const contentTypeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
        const contentType = contentTypeMap[ext];
        if (!contentType) return '';
        return uploadBuffer(buf, key, ext, contentType, path.basename(file), localPath);
    }

    async function uploadImageBuffer(buf: Buffer, prefix: string): Promise<string> {
        if (!buf || !buf.length) return '';
        const key = `${prefix}_${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24)}`;
        // 微信二维码是 JPEG
        const contentType = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
        const ext = contentType === 'image/png' ? '.png' : '.jpg';
        return uploadBuffer(buf, key, ext, contentType, `${prefix} image`);
    }

    // 主进程侧：名称 -> 游戏物品图路径（懒加载查表），不依赖 worker 传递 iconPath
    let mainNameIconMap: Map<string, string> | null = null;
    function getMainNameIconMap(): Map<string, string> {
        if (mainNameIconMap) return mainNameIconMap;
        const map = new Map<string, string>();
        try {
            const g = require('../config/gameConfig');
            for (const p of (g.getAllPlants() as any[])) {
                const seedId = Number(p?.seed_id || 0) || 0;
                const img = seedId > 0 ? g.getSeedImageBySeedId(seedId) : '';
                const name = String(p?.name || '').trim();
                if (name && img && !map.has(name)) map.set(name, img);
            }
            for (const it of (g.getAllItems() as any[])) {
                const img = g.getItemImageById(Number(it?.id || 0) || 0);
                const name = String(it?.name || '').trim();
                if (name && img && !map.has(name)) map.set(name, img);
            }
        } catch {}
        mainNameIconMap = map;
        return map;
    }

    // 在消息文本里的每个物品名后插入对应物品图标（核心算法见 decorateMessageWithIcons）
    async function decorateMsgWithIcons(msg: string, onMissing?: (names: string[]) => void): Promise<string> {
        if (!config.includeIcons || !msg) { if (onMissing) onMissing([]); return msg; }
        return decorateMessageWithIcons(msg, getMainNameIconMap(), uploadImage, onMissing);
    }

    // 从消息文本里提取产物名（"出售 郁金香x37"、"获得 火鸡蛋 ×1"）
    function extractItemNameFromMsg(msg: string): string {
        const text = String(msg || '');
        let m = /出售\s+([^\s,x×，,]+)/.exec(text);
        if (m && m[1]) return m[1];
        m = /获得\s+([^\s,x×，,]+)/.exec(text);
        if (m && m[1]) return m[1];
        return '';
    }

    // 同步查表得到 iconPath（优先 itemId，其次 meta 里的名字，最后从 msg 提取）
    function resolveIconPathSync(meta: any, msg: string): string {
        const g = (() => { try { return require('../config/gameConfig'); } catch { return null; } })();
        if (!g) return '';
        const itemId = Number(meta.itemId || 0) || 0;
        if (itemId) {
            const p = g.getItemImageById(itemId);
            if (p) return p;
        }
        const map = getMainNameIconMap();
        for (const name of [meta.itemName, meta.plantName, meta.name, extractItemNameFromMsg(msg)]) {
            const n = String(name || '').trim();
            if (n && map.has(n)) return map.get(n)!;
        }
        return '';
    }

    // ---------- 日志聚合 ----------
    function enqueueLog(entry: any, accountName?: string, accountId?: string): void {
        if (!config.enabled || !config.channelEnabled) return;
        if (!entry || !entry.meta) return;
        const originalMeta = entry.meta || {};
        const event = String(originalMeta.event || '');
        const label = EVENT_LABELS[event];
        if (!label) return;
        // 只推成功/有效的日志；错误与非 ok 结果跳过，减少噪音
        if (originalMeta.result && !['ok', 'success', 'successful'].includes(String(originalMeta.result))) return;
        if (!config.eventKeys.some((k: string) => EVENT_LABELS[k] === label)) return;
        const msg = String(entry.msg || '').replace(/\s+/g, ' ').trim();
        // 主进程补 iconPath：确保出售/收获/牧场偷取等带真实物品图
        const meta = { ...originalMeta };
        if (config.includeIcons && !meta.iconPath) {
            const iconPath = resolveIconPathSync(meta, msg);
            if (iconPath) meta.iconPath = iconPath;
        }
        queue.push({
            time: entry.time || '',
            tag: entry.tag || '',
            msg,
            label,
            meta,
            accountName: accountName || entry.accountName || '',
            accountId: accountId || entry.accountId || '',
        });
        status.queued = queue.length;
    }

    async function resolveIconUrl(meta: any): Promise<string> {
        if (!config.includeIcons) return Promise.resolve('');
        // 优先用 worker 侧补充的 iconPath（已按 itemId 或名字查表得到真实物品图）
        const iconPath = String(meta.iconPath || '').trim();
        let local = iconPath;
        if (!local) {
            // 回退：主进程按 itemId 反查
            const itemId = Number(meta.itemId || 0) || 0;
            if (!itemId) return Promise.resolve('');
            try {
                const gameConfig = require('../config/gameConfig');
                local = gameConfig.getItemImageById(itemId);
            } catch {}
        }
        if (!local) return Promise.resolve('');
        let url = '';
        for (let attempt = 0; attempt < ICON_UPLOAD_ATTEMPTS && !url; attempt++) {
            if (attempt > 0) await sleep(450 * attempt);
            url = await uploadImage(local);
        }
        if (!url) log('QQ机器人', `图标上传未成功: ${local}`);
        return url;
    }

    async function resolveAvatarUrl(meta: any): Promise<string> {
        if (!config.includeAvatars) return '';
        const avatar = String(meta.avatarUrl || meta.friendAvatar || '').trim();
        if (!avatar) return '';
        // 仅接受 http(s) 公网图片；平台会自动转存
        if (!/^https?:\/\//i.test(avatar)) return '';
        return avatar;
    }

    // 清理好友牧场没有对应的游戏物品图（仓库里没有蚊子/污物素材），用 emoji 标签代替图标
    function formatHazardTags(meta: any): string {
        const tags: string[] = [];
        const mosquito = Number(meta?.hazardMosquito) || 0;
        const dirt = Number(meta?.hazardDirt) || 0;
        if (mosquito > 0) tags.push(`🦟×${mosquito}`);
        if (dirt > 0) tags.push(`💩×${dirt}`);
        return tags.join(' ');
    }

    async function buildMarkdown(items: any[]): Promise<{ content: string; missingIcons: string[] }> {
        // 聚合同账号 + 同 label + 同 msg，避免跨账号合并计数
        const groups = new Map<string, { count: number; item: any }>();
        for (const item of items) {
            const key = `${item.accountId || item.accountName || ''}|${item.label}|${item.msg}`;
            const found = groups.get(key);
            if (found) found.count += 1;
            else groups.set(key, { count: 1, item });
        }

        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const first = items[0] || {};
        const displayName = first.accountName || first.accountId || '未知账号';
        const accountText = config.showAccount ? ` · ${displayName}` : '';
        const totalText = items.length > 1 ? `（${items.length} 条）` : '';
        const lines: string[] = [`## 农场动态${accountText}`, `> ${hh}:${mm} · ${items.length} 项事件${totalText}`, ''];

        const missingIcons = new Set<string>();
        const prepared: any[] = [];
        // 串行处理每个事件：resolveIconUrl 与正文图标上传都走素材库，
        // 并发会触发限流导致图标丢失。头像无需上传，可先取。
        for (const [, g] of groups) {
            const item = g.item;
            const avatarUrl = await resolveAvatarUrl(item.meta);
            const iconUrl = await resolveIconUrl(item.meta);
            // 注意：事件图标（iconUrl）为空是允许的——很多事件（如「照顾好友」）
            // 本来就没有配置物品图，不能当作「上传失败」触发重排队，否则整批消息
            // 会被无限延迟。只校验正文里明确出现的物品图标。
            const decoratedMsg = await decorateMsgWithIcons(item.msg, names => {
                for (const n of names) missingIcons.add(n);
            });
            prepared.push({ ...item, count: g.count, iconUrl, avatarUrl, decoratedMsg });
        }

        for (const item of prepared) {
            const countText = item.count > 1 ? ` ×${item.count}` : '';
            const friendName = String(item.meta.friendName || item.meta.nickname || '').trim();
            // 事件图标放到事件名文字后面（行内）；好友头像缩小放在昵称前
            const iconInline = item.iconUrl ? ` ![图标 #20px #20px](${item.iconUrl})` : '';
            const avatarInline = (item.avatarUrl && friendName) ? `![头像 #28px #28px](${item.avatarUrl})` : '';
            const friendText = friendName ? ` · ${avatarInline}${friendName}` : '';
            const hazardTags = formatHazardTags(item.meta);
            const hazardText = hazardTags ? ` · ${hazardTags}` : '';
            lines.push(`- **${item.label}**${iconInline}${countText}${hazardText}${friendText}`);
            const body = item.decoratedMsg || item.msg;
            if (body && body !== item.label) {
                lines.push(`  ${body}`);
            }
            lines.push('');
        }
        return { content: lines.join('\n').trim(), missingIcons: Array.from(missingIcons) };
    }

    async function sendMarkdown(content: string, keyboard?: any, openid?: string): Promise<any> {
        const token = await getToken();
        const body: any = {
            msg_type: 2,
            markdown: { content },
        };
        if (keyboard) body.keyboard = keyboard;
        const target = String(openid || config.openid || '');
        const resp = await axios.post(`${API_BASE}/v2/users/${encodeURIComponent(target)}/messages`,
            body, { headers: authHeaders(token), timeout: 15000, proxy: false });
        return resp?.data || {};
    }

    async function sendText(content: string, keyboard?: any, openid?: string): Promise<any> {
        const token = await getToken();
        const body: any = { msg_type: 0, content };
        if (keyboard) body.keyboard = keyboard;
        const target = String(openid || config.openid || '');
        const resp = await axios.post(`${API_BASE}/v2/users/${encodeURIComponent(target)}/messages`,
            body, { headers: authHeaders(token), timeout: 15000, proxy: false });
        return resp?.data || {};
    }

    // 通用操作按钮键盘
    function buildActionKeyboard(buttonId: string, label: string, visitedLabel: string, action: string, accountId: string): any {
        const buttonData = JSON.stringify({ action, accountId });
        return {
            content: {
                rows: [
                    {
                        buttons: [
                            {
                                id: buttonId,
                                render_data: { label, visited_label: visitedLabel, style: 1 },
                                action: {
                                    type: 1,
                                    permission: { type: 2 }, // 所有人可操作（回调里按 openid 过滤）
                                    data: buttonData,
                                    unsupport_tips: '当前客户端版本不支持按钮，请在面板手动登录',
                                },
                            },
                        ],
                    },
                ],
            },
        };
    }

    function buildReloginKeyboard(accountId: string): any {
        return buildActionKeyboard('relogin', '🔄 重新登录', '✅ 已触发', 'relogin', accountId);
    }

    function buildRefreshQrKeyboard(accountId: string): any {
        return buildActionKeyboard('refresh_qr', '🔄 重新获取二维码', '⏳ 已刷新', 'refreshQr', accountId);
    }

    // 账号下线推送（含下线原因与重新登录按钮）
    async function sendOfflineNotification(payload: { accountId: string; accountName: string; reason: string; detail?: string }): Promise<void> {
        if (!config.enabled || !config.channelEnabled || !config.offlineNotify) return;
        const recipients = getRecipientsForAccount(payload.accountId);
        if (!recipients.length) return;
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const reasonText = describeOfflineReason(payload.reason);
        const lines: string[] = [
            '## ⚠️ 账号下线提醒',
            `> ${hh}:${mm} · ${payload.accountName}`,
            '',
            `- **账号**：${payload.accountName}`,
            `- **原因**：${reasonText}`,
        ];
        if (payload.detail) lines.push(`- **详情**：${payload.detail}`);
        // 仅微信账号支持一键重新登录：下发按钮；QQ 账号维持纯提醒
        const account = deps.getAccount(payload.accountId) || {};
        const isWx = String(account.platform || '') === 'wx';
        let keyboard: any;
        if (isWx) {
            // 微信账号：一键重新登录不受历史 reloginEnabled 开关限制，掉线即带按钮
            lines.push('', '点击下方「重新登录」可自动重新获取登录 Code 并上线，无需再次扫码。');
            keyboard = buildReloginKeyboard(payload.accountId);
        } else {
            lines.push('', '请在 Web 面板手动处理账号登录。');
        }
        try {
            for (const openid of recipients) {
                await sendMarkdown(lines.join('\n'), keyboard, openid);
            }
            log('QQ机器人', `已推送账号「${payload.accountName}」下线提醒（${reasonText}）`);
        } catch (e: any) {
            log('QQ机器人', `下线提醒推送失败: ${e?.message || '未知错误'}`);
        }
    }

    function describeOfflineReason(reason: string): string {
        const r = String(reason || '');
        if (r === 'offline_timeout') return '持续离线超时';
        if (r.startsWith('kickout:')) return `被踢下线（${r.slice(8)}）`;
        if (r.startsWith('disconnect:')) return `连接断开（${r.split(':').slice(1).join(':')}）`;
        if (r === 'ws_400') return '登录失效，需要更新 Code';
        return r || '未知原因';
    }

    async function flush(): Promise<void> {
        if (!queue.length) { status.queued = 0; return; }
        if (!config.enabled || !config.channelEnabled) {
            queue.length = 0;
            status.queued = 0;
            return;
        }
        checkDayReset();
        if (sentToday >= config.dailyLimit) {
            log('QQ机器人', `今日推送已达上限 ${config.dailyLimit} 条，已跳过`);
            queue.length = 0;
            status.queued = 0;
            return;
        }
        if (minuteBuckets.length >= config.minuteLimit) {
            status.queued = queue.length;
            return; // 等下一个窗口
        }
        const items = queue.splice(0, queue.length);
        status.queued = 0;

        // 先按接收用户、再按账号分组：每个「用户 × 账号」单独一条消息，避免多账号日志串台
        const byRecipient = new Map<string, Map<string, any[]>>();
        let anyRecipient = false;
        for (const item of items) {
            const recipients = getRecipientsForAccount(item.accountId);
            if (!recipients.length) continue;
            anyRecipient = true;
            const accountKey = String(item.accountId || item.accountName || 'unknown');
            for (const openid of recipients) {
                if (!byRecipient.has(openid)) byRecipient.set(openid, new Map());
                const byAccount = byRecipient.get(openid)!;
                if (!byAccount.has(accountKey)) byAccount.set(accountKey, []);
                byAccount.get(accountKey)!.push(item);
            }
        }
        if (!anyRecipient) {
            if (!config.openid && !Object.keys(config.accountRoutes).length) {
                log('QQ机器人', '尚未指定接收用户，请先用 QQ 给机器人发消息或在推送设置中选择');
            }
            return;
        }

        try {
            // 每个「用户 × 账号」独立成一条消息，标题带账号名，互不混杂
            let reachedLimit = false;
            for (const [openid, byAccount] of byRecipient.entries()) {
                for (const [accountKey, accountItems] of byAccount.entries()) {
                    if (sentToday >= config.dailyLimit || minuteBuckets.length >= config.minuteLimit) {
                        reachedLimit = true;
                        break;
                    }
                    const built = await buildMarkdown(accountItems);
                    // 图标校验：只要还有图标没上传成功，就重排队等下一窗口重试，
                    // 保证推送出去的消息图标齐全；超过上限才降级发送，避免死循环。
                    if (built.missingIcons.length) {
                        const retry = Math.max(0, ...accountItems.map((it: any) => Number(it._iconRetry) || 0));
                        if (retry < ICON_QUEUE_RETRY_LIMIT) {
                            for (const it of accountItems) {
                                queue.push({ ...it, _iconRetry: retry + 1 });
                            }
                            status.queued = queue.length;
                            log('QQ机器人', `账号 ${accountKey} 有 ${built.missingIcons.length} 个图标未就绪（${built.missingIcons.slice(0, 5).join('、')}），第 ${retry + 1} 次重排队等重传`);
                            continue;
                        }
                        log('QQ机器人', `账号 ${accountKey} 图标重传 ${retry} 次后仍有 ${built.missingIcons.length} 个未就绪，降级发送`);
                    }
                    await sendMarkdown(built.content, undefined, openid);
                    sentToday += 1;
                    minuteBuckets.push(Date.now());
                    checkDayReset();
                    const recipientName = discoveredUsers.find((u: any) => u.openid === openid)?.nickname || '';
                    const sample = accountItems[0] || {};
                    recordSent({
                        accountId: sample.accountId || accountKey,
                        accountName: sample.accountName || accountKey,
                        recipientOpenid: openid,
                        recipientName,
                        content: built.content,
                        itemCount: accountItems.length,
                    });
                    log('QQ机器人', `已向 ${openid.slice(0, 8)}… 推送账号 ${accountKey} 的 ${accountItems.length} 条日志`);
                }
                if (reachedLimit) break;
            }
        } catch (e: any) {
            status.lastError = String(e?.message || '发送失败');
            log('QQ机器人', `推送失败: ${status.lastError}`);
        }
    }

    function start(): void {
        if (!config.enabled || !config.channelEnabled) return;
        if (!stopped) return;
        stopped = false;
        sentDayKey = getDayKey();
        sentToday = 0;
        checkDayReset();
        const intervalMs = Math.max(5, config.batchWindowSec) * 1000;
        timer = setInterval(() => { flush().catch(() => {}); }, intervalMs);
        connectGateway().catch(() => {});
        log('QQ机器人', `推送服务已启动（聚合窗口 ${config.batchWindowSec}s）`);
    }

    function stop(): void {
        if (stopped) return;
        stopped = true;
        if (timer) { clearInterval(timer); timer = null; }
        // 服务停止时不再有人处理扫码回调，清理所有等待中的会话
        for (const accountId of Array.from(reloginSessions.keys())) {
            clearReloginSession(accountId);
        }
        disconnectGateway();
        log('QQ机器人', '推送服务已停止');
    }

    async function testSend(): Promise<any> {
        if (!config.channelEnabled) throw new Error('请先在「推送渠道」里启用 QQ 机器人推送');
        if (!config.enabled) throw new Error('请先开启 QQ 机器人推送');
        if (!config.appId || !config.appSecret) throw new Error('请先填写 AppID 和 AppSecret');
        if (!config.openid) throw new Error('尚未捕获 openid，请先用 QQ 给机器人发一条消息（或在设置中手动填写）');
        const content = [
            '## 🎮 农场动态（测试）',
            '> 这是一条来自 qq-farm-bot 的测试消息',
            '',
            '- **出售成功** ×3',
            '  出售 苹果x3，获得 120 金币',
            '',
            '- **收获作物** ×5',
            '  收获完成 5 块土地',
        ].join('\n');
        const result = await sendMarkdown(content);
        sentToday += 1;
        minuteBuckets.push(Date.now());
        checkDayReset();
        return result;
    }

    function getStatus(): RuntimeStatus {
        checkDayReset();
        return { ...status, queued: queue.length, mediaCount: mediaCache.size, users: getUsers() };
    }

    // 旧缓存没有 localPath 字段：素材 key 是 localPath 的 sha1，可反查还原
    let pathByKeyCache: Map<string, string> | null = null;
    function getPathByKey(): Map<string, string> {
        if (pathByKeyCache) return pathByKeyCache;
        const map = new Map<string, string>();
        try {
            for (const local of new Set(getMainNameIconMap().values())) {
                map.set(crypto.createHash('sha1').update(String(local)).digest('hex'), String(local));
            }
        } catch {}
        pathByKeyCache = map;
        return map;
    }

    // 面板「推送统计」查看用的明细：已发送记录 / 待发送队列 / 素材缓存
    function getDetails(): { records: PushRecord[]; queue: any[]; media: any[] } {
        loadMediaCache();
        const pathByKey = getPathByKey();
        const media = Array.from(mediaMeta.entries()).map(([key, meta]) => {
            const localPath = meta.localPath || pathByKey.get(key) || '';
            return {
                key,
                url: mediaCache.get(key) || '',
                imageId: meta.imageId,
                localPath,
                name: localPath ? path.basename(localPath, path.extname(localPath)) : meta.imageId,
                lastUsed: meta.lastUsed,
            };
        }).sort((a, b) => b.lastUsed - a.lastUsed);
        const pending = queue.map((it: any) => ({
            msg: it.msg,
            label: it.label,
            accountName: it.accountName || it.accountId || '',
            accountId: it.accountId || '',
            time: it.time || '',
            retry: Number(it._iconRetry) || 0,
        }));
        return { records: pushRecords.slice().reverse(), queue: pending, media };
    }

    // 删除指定日期（YYYY-MM-DD）的推送记录
    function deleteRecordsByDate(dateKey: string): number {
        const key = String(dateKey || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('日期格式不正确');
        const before = pushRecords.length;
        pushRecords = pushRecords.filter(r => r.dateKey !== key);
        const removed = before - pushRecords.length;
        if (removed > 0) savePushRecords();
        log('QQ机器人', `已删除 ${key} 的 ${removed} 条推送记录`);
        return removed;
    }

    function selectUser(openid: string): QqBotPushConfig {
        const user = discoveredUsers.find(u => u.openid === openid);
        if (!user) throw new Error('未找到该用户，请先让对方给机器人发一条消息');
        config = { ...config, openid };
        status.openid = openid;
        persistUsers();
        return getConfig();
    }

    function startCapture(): void {
        if (!config.channelEnabled) throw new Error('请先在「推送渠道」里启用 QQ 机器人推送');
        if (!config.enabled) throw new Error('请先开启 QQ 机器人推送并填写 AppID/AppSecret');
        if (!ws || !status.connected) {
            sessionId = '';
            lastSeq = null;
            connectGateway().catch(() => {});
        }
    }

    const service = {
        start,
        stop,
        getConfig,
        setConfig,
        getStatus,
        getDetails,
        deleteRecordsByDate,
        enqueueLog,
        testSend,
        startCapture,
        flush,
        selectUser,
        sendOfflineNotification,
        getUsers,
        deleteUser,
    };
    activeService = service;
    return service;
}

function getActiveQqBotPush() {
    return activeService;
}

module.exports = { createQqBotPushService, getActiveQqBotPush, decorateMessageWithIcons };
