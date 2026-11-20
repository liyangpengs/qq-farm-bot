export {};
/**
 * 账号 Code 自动监听（账号管理页）。
 *
 * 游戏登录 Code 是一次性的：微信侧有 expires_at / refreshtoken / loginBuffer，
 * 可以在到期前主动换 Code；QQ 侧没有到期时间，只能靠掉线日志判断 Code 是否
 * 已经失效。这里把两类信号聚合成前端可直接消费的状态，并给出「能否自动补 Code」
 * 的判定，避免账号管理页每 10 秒轮询时重复弹提示或反复打续期接口。
 */

export type CodeHealthLevel = 'ok' | 'unknown' | 'expiring' | 'expired' | 'refresh_failed' | 'offline';

export interface CodeHealthItem {
    accountId: string;
    name: string;
    platform: string;
    level: CodeHealthLevel;
    reason: string;
    autoFixable: boolean;
    needsManual: boolean;
    remainingMs: number;
    latestLogAction: string;
}

export interface AutoFixResult {
    ok: boolean;
    accountId: string;
    platform: string;
    needsManual: boolean;
    restarted: boolean;
    error: string;
}

/**
 * 「即将到期」的提示窗口。
 *
 * 后端在到期前 5 分钟才真正滚令牌，所以界面提前 10 分钟转琥珀色即可。
 * 原来沿用老版本的 45 分钟，会让账号在长达 40 分钟里一直显示「即将到期」
 * 却什么都没发生，看起来像卡住了。
 */
const WARNING_WINDOW_MS = 10 * 60_000;
const DEFAULT_TTL_SECONDS = 7200;
/** 这些账号日志代表「Code 已失效导致掉线」，而不是用户手动停止。 */
const OFFLINE_LOG_ACTIONS = new Set([
    'disconnect_stop',
    'kickout_stop',
    'auto_code_refresh_failed',
    'auto_code_preflight_failed',
    // worker-manager 在 WS 400（登录失效，请更新 Code）时实际写入的动作；
    // 以前集合里只有 login_failed，而该动作全仓没有写入点，导致这条最直接的
    // Code 失效信号被忽略，只能等后续 disconnect_stop 才被识别。
    'ws_400',
    'login_failed',
]);

interface InspectOptions {
    now?: number;
    /** undefined 表示调用方拿不到运行状态，此时不按掉线日志判定。 */
    running?: boolean;
    latestLogAction?: string;
}

interface SnapshotDeps {
    now?: number;
    accountLogs?: any[];
    isAccountRunning?: (accountId: string) => boolean;
}

interface AutoFixDeps {
    getAccount: (accountId: string) => any;
    latestLogAction?: string;
    ensureFreshGameCode: (accountId: string) => Promise<any>;
    tryRefreshQqGameCode: (accountId: string) => Promise<any>;
    isAccountRunning: (accountId: string) => boolean;
    restartAccount: (accountId: string) => void;
    addAccountLog: (action: string, msg: string, accountId: string, accountName: string, extra?: any) => void;
    notify?: (accountId: string, entry: any) => any;
}

/** 兼容秒级 / 毫秒级到期时间戳；老数据可能由外部写成秒。 */
function normalizeExpiry(value: unknown): number {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return raw < 1e11 ? raw * 1000 : raw;
}

/** 与 wx-credential.hasRenewableCredential 保持一致：loginBuffer 也能直接换 Code。 */
function hasRenewableCredential(account: any): boolean {
    return !!String(account?.loginBuffer || '').trim() || !!String(account?.refreshtoken || '').trim();
}

function isOfflineLevel(level: CodeHealthLevel): boolean {
    return level === 'expired' || level === 'expiring' || level === 'refresh_failed' || level === 'offline';
}

export function inspectAccountCodeHealth(account: any, options: InspectOptions = {}): CodeHealthItem {
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const id = String(account?.id || '');
    const platform = String(account?.platform || 'qq');
    const name = String(account?.name || account?.nick || id || '');
    const latestLogAction = String(options.latestLogAction || '');
    const item: CodeHealthItem = {
        accountId: id,
        name,
        platform,
        level: 'ok',
        reason: 'Code 正常',
        autoFixable: false,
        needsManual: false,
        remainingMs: 0,
        latestLogAction,
    };

    // 掉线且最后一条账号日志是 Code 失效类：优先按「需要补 Code」处理。
    if (options.running === false && OFFLINE_LOG_ACTIONS.has(latestLogAction)) {
        item.level = 'offline';
        item.reason = '账号已掉线，登录 Code 可能已失效';
    }

    if (platform === 'wx') {
        const refreshedAt = Number(account?.wxCredentialRefreshedAt) || 0;
        const lastAttemptAt = Number(account?.wxCredentialLastAttemptAt) || 0;
        const refreshError = String(account?.wxCredentialRefreshError || '').trim();
        const ttlSeconds = Number(account?.expires_in) > 0 ? Number(account.expires_in) : DEFAULT_TTL_SECONDS;
        let expiresAt = normalizeExpiry(account?.expires_at);
        if (!expiresAt && refreshedAt) expiresAt = refreshedAt + ttlSeconds * 1000;
        else if (expiresAt && refreshedAt > 0 && refreshedAt <= now) {
            // 重新扫码 / 换 Code 后旧到期时间可能还留着，以最近一次成功时间重新起算。
            expiresAt = Math.max(expiresAt, refreshedAt + ttlSeconds * 1000);
        }

        if (expiresAt) {
            const remaining = expiresAt - now;
            item.remainingMs = Math.max(0, remaining);
            if (remaining <= 0) {
                item.level = 'expired';
                item.reason = '微信访问凭证已过期，需要补 Code';
            }
            else if (remaining <= WARNING_WINDOW_MS && item.level === 'ok') {
                item.level = 'expiring';
                item.reason = '微信访问凭证即将到期，可提前自动续期';
            }
        }
        else if (item.level === 'ok') {
            item.level = 'unknown';
            item.reason = '暂无访问凭证到期信息';
        }

        // 失败标记只在「最近一次失败晚于最近一次成功」时生效，历史错误不重复打扰。
        if (refreshError && lastAttemptAt > refreshedAt && item.level !== 'expired') {
            item.level = 'refresh_failed';
            item.reason = `上次自动续期失败：${refreshError}`;
        }
    }

    item.autoFixable = isOfflineLevel(item.level)
        && (platform === 'wx' ? hasRenewableCredential(account) : true);
    item.needsManual = isOfflineLevel(item.level) && !item.autoFixable;
    return item;
}

/**
 * 账号日志按「最新在前」传入；只取每个账号最后一条日志的动作，
 * 这样用户手动停止（stop）之后不会再被历史掉线日志误判成需要补 Code。
 */
export function buildCodeHealthSnapshot(accounts: any[], deps: SnapshotDeps = {}): {
    items: CodeHealthItem[];
    needsAttention: number;
    generatedAt: number;
} {
    const now = Number.isFinite(deps.now) ? Number(deps.now) : Date.now();
    const logs = Array.isArray(deps.accountLogs) ? deps.accountLogs : [];
    const latestByAccount = new Map<string, string>();
    for (const log of logs) {
        const id = String(log?.accountId || '');
        if (!id || latestByAccount.has(id)) continue;
        latestByAccount.set(id, String(log?.action || ''));
    }
    const items = (Array.isArray(accounts) ? accounts : []).map((account: any) => {
        const id = String(account?.id || '');
        let running: boolean | undefined;
        if (typeof deps.isAccountRunning === 'function') {
            try { running = !!deps.isAccountRunning(id); } catch { running = undefined; }
        }
        return inspectAccountCodeHealth(account, {
            now,
            running,
            latestLogAction: latestByAccount.get(id) || '',
        });
    });
    return {
        items,
        needsAttention: items.filter(entry => isOfflineLevel(entry.level)).length,
        generatedAt: now,
    };
}

/**
 * 自动补 Code：微信走免扫码换码（loginBuffer 优先，不消耗滚动 token），
 * QQ 走尽力重签。成功后运行中账号立刻用新 Code 重连，因掉线停下的账号自动拉起。
 * 失败统一返回 needsManual，由面板引导重新扫码 / 手动填 Code。
 */
export async function autoFixAccountCode(accountId: unknown, deps: AutoFixDeps): Promise<AutoFixResult> {
    const id = String(accountId || '');
    const account = deps.getAccount(id);
    const platform = String(account?.platform || 'qq');
    const name = String(account?.name || account?.nick || id);
    const result: AutoFixResult = {
        ok: false,
        accountId: id,
        platform,
        needsManual: false,
        restarted: false,
        error: '',
    };
    if (!account) {
        result.error = '账号不存在';
        result.needsManual = true;
        return result;
    }

    const refreshed = platform === 'wx'
        ? await deps.ensureFreshGameCode(id)
        : await deps.tryRefreshQqGameCode(id);
    if (!refreshed?.ok) {
        result.error = String(refreshed?.error || '未能自动补 Code，请重新扫码或填写新 Code');
        result.needsManual = true;
        deps.addAccountLog('auto_code_fix_failed', `账号 ${name} 自动补 Code 失败：${result.error}`, id, name, { reason: 'code_watch' });
        if (typeof deps.notify === 'function') {
            deps.notify(id, {
                type: 'warning',
                title: 'Code 已过期，需要补 Code',
                content: `账号 ${name} 自动补 Code 失败：${result.error}。请到账号管理页重新扫码或填写新 Code。`,
                dedupeKey: `code_fix_failed:${id}:${String(refreshed?.error || '').slice(0, 60)}`,
            });
        }
        return result;
    }

    result.ok = true;
    const running = !!deps.isAccountRunning(id);
    // 运行中账号要立刻换到新 Code；因 Code 失效掉线停下的账号也直接拉起。
    // 统一走 restartAccount：worker 已停时内部会直接 startWorker，不会再触发一次
    // 「启动前换码」，避免重复消耗一次性滚动凭证。
    if (running || (deps.latestLogAction && OFFLINE_LOG_ACTIONS.has(String(deps.latestLogAction)))) {
        deps.restartAccount(id);
        result.restarted = true;
    }
    deps.addAccountLog('auto_code_fix', `账号 ${name} 已自动补 Code${result.restarted ? '并重新上线' : ''}`, id, name, { reason: 'code_watch' });
    return result;
}

module.exports = {
    WARNING_WINDOW_MS,
    OFFLINE_LOG_ACTIONS,
    inspectAccountCodeHealth,
    buildCodeHealthSnapshot,
    autoFixAccountCode,
};
