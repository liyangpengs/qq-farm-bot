export {};
/**
 * 微信授权续期（分层）。
 *
 * 续期链路分成两级，用途完全不同，早期实现把它们揉在一起，代价是每次保活
 * 都顺手取一遍 loginBuffer、换一遍 Code、再重启一次连接：
 *
 *   1. renewOAuthToken —— 只滚 access/refresh token。后台保活走这条，
 *      不取 loginBuffer、不换 Code、不重启。官方续期只需要 token 滚动到
 *      下一轮，buffer 等真正要换 Code 时再取（YYB-Go-Enhanced 的 keepalive
 *      也是这个立场：buffer recovery happens on demand）。
 *   2. refreshAccountCredential —— token + loginBuffer + Code 全链路。
 *      只在「确实缺 Code」时调用：掉线重登、用户手动续期、补 Code 失败兜底。
 *
 * 错误一律过 recovery-policy 分类：`-14` 不滚 token，`-109` 直接判需要重新扫码，
 * 其余按剩余寿命退避。这样才不会出现「AppID 拒绝 → 重新登录 → 更频繁被拒」的
 * 反向循环。
 */

const store = require('../models/store');
const { WxLoginService } = require('./wx-login/service');
const { classifyProtocolError } = require('./wx-login/recovery-policy');

const TARGET_APP_ID = 'wx5306c5978fdb76e4';
const wxLogin = new WxLoginService();

export interface CredentialRefreshResult {
    ok: boolean;
    accountId: string;
    accountName: string;
    code?: string;
    /** 失败原因（可直接展示给用户）。 */
    error?: string;
    /** 失败但凭证已滚动时的最新授权到期时间。 */
    expiresAt?: number;
    /** 服务端已明确吊销凭证：只能重新扫码，自动重试不会成功。 */
    needsRescan?: boolean;
    /** 协议错误分类（application_rejected / refresh_rejected / transient ...）。 */
    kind?: string;
    /** 本次是否真的拿到了新 Code。仅滚 token 的续期为 false。 */
    codeIssued?: boolean;
}

function hasWxCredential(account: any): boolean {
    return !!account
        && String(account.platform || '') === 'wx'
        && !!String(account.wxid || '').trim()
        && !!String(account.refreshtoken || '').trim();
}

/** 只要有长效凭证（loginBuffer 也能直接换 Code）就值得尝试刷新。 */
function hasRenewableCredential(account: any): boolean {
    return !!account
        && String(account.platform || '') === 'wx'
        && (!!String(account.loginBuffer || '').trim() || !!String(account.refreshtoken || '').trim());
}

/**
 * 同一账号的续期串行化。refreshtoken 是一次性滚动凭证：手动按钮、到期前预防续期、
 * 掉线重登、启动前换码并发时都会拿同一个旧 token 去刷新，第二个必然被服务端
 * 拒绝，且旧 token 已作废却没落盘新值 —— 之后所有续期都会持续失败。
 * 串行后第二个任务会在第一个结束后重新读取账号，拿到的是最新 token。
 */
const accountLocks = new Map<string, Promise<void>>();
async function withAccountCredentialLock<T>(accountId: unknown, task: () => Promise<T>): Promise<T> {
    const key = String(accountId || '');
    const previous = accountLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    accountLocks.set(key, current);
    if (previous) await previous.catch(() => {});
    try {
        return await task();
    } finally {
        release();
        if (accountLocks.get(key) === current) accountLocks.delete(key);
    }
}

function getAccountById(accountId: unknown): any {
    const accounts = (store.getAccounts().accounts || []);
    return accounts.find((account: any) => String(account.id) === String(accountId)) || null;
}

/** 带账号维度的换码：会话缓存命中时不占登录预算，未命中才走预算闸门。 */
function issueCodeFromLoginBuffer(loginBuffer: string, accountId?: unknown): Promise<string> {
    return wxLogin.issueCode({ loginBuffer } as any, TARGET_APP_ID, accountId === undefined ? undefined : String(accountId));
}

async function doRenewOAuthToken(accountId: unknown): Promise<CredentialRefreshResult> {
    const account = getAccountById(accountId);
    const accountName = String((account && (account.name || account.nick)) || accountId || '');
    if (!account) return { ok: false, accountId: String(accountId || ''), accountName, error: '账号不存在' };
    if (String(account.platform || '') !== 'wx') {
        return { ok: false, accountId: String(account.id), accountName, error: '仅微信账号支持授权续期' };
    }
    if (!hasWxCredential(account)) {
        const error = '账号缺少微信刷新凭证，请重新扫码登录';
        store.addOrUpdateAccount({
            id: String(account.id),
            wxCredentialLastAttemptAt: Date.now(),
            wxCredentialRefreshError: error,
            wxCredentialNeedsRescan: true,
        } as any);
        return { ok: false, accountId: String(account.id), accountName, error, needsRescan: true, kind: 'refresh_rejected' };
    }

    const attemptedAt = Date.now();
    try {
        const oauth = await wxLogin.refreshOAuthToken({
            openid: account.wxid,
            refreshtoken: account.refreshtoken,
            accesstoken: account.accesstoken,
        });
        // 只滚 token：loginBuffer 保持原样，等真需要 Code 时再按需换。
        store.addOrUpdateAccount({
            id: String(account.id),
            refreshtoken: oauth.refreshtoken,
            accesstoken: oauth.accesstoken,
            expires_in: oauth.expires_in,
            expires_at: oauth.expires_at,
            wxCredentialRefreshedAt: oauth.refreshedAt,
            wxCredentialLastAttemptAt: attemptedAt,
            wxCredentialRefreshError: '',
            wxCredentialNeedsRescan: false,
        } as any);
        return { ok: true, accountId: String(account.id), accountName, expiresAt: oauth.expires_at, codeIssued: false };
    }
    catch (error: any) {
        const info = classifyProtocolError(error);
        store.addOrUpdateAccount({
            id: String(account.id),
            wxCredentialLastAttemptAt: attemptedAt,
            wxCredentialRefreshError: info.message,
            ...(info.needsRescan ? { wxCredentialNeedsRescan: true } : {}),
        } as any);
        return {
            ok: false,
            accountId: String(account.id),
            accountName,
            error: info.message,
            expiresAt: Number(account.expires_at) || undefined,
            needsRescan: info.needsRescan,
            kind: info.kind,
        };
    }
}

/**
 * 续期单个账号的微信授权，并把新 Code 与滚动凭证写回账号。
 * 只在「确实需要新 Code」时使用；日常保活请用 renewOAuthToken。
 */
async function doRefreshAccountCredential(accountId: unknown): Promise<CredentialRefreshResult> {
    const account = getAccountById(accountId);
    const accountName = String((account && (account.name || account.nick)) || accountId || '');
    if (!account) {
        return { ok: false, accountId: String(accountId || ''), accountName, error: '账号不存在' };
    }
    if (String(account.platform || '') !== 'wx') {
        return { ok: false, accountId: String(account.id), accountName, error: '仅微信账号支持授权续期' };
    }
    if (!hasWxCredential(account)) {
        const error = '账号缺少微信刷新凭证，请重新扫码登录';
        store.addOrUpdateAccount({
            id: String(account.id),
            wxCredentialLastAttemptAt: Date.now(),
            wxCredentialRefreshError: error,
            wxCredentialNeedsRescan: true,
        } as any);
        return { ok: false, accountId: String(account.id), accountName, error, needsRescan: true, kind: 'refresh_rejected' };
    }

    const attemptedAt = Date.now();
    let refreshed: any = null;
    try {
        const credential = await wxLogin.refreshLoginBuffer({
            openid: account.wxid,
            refreshtoken: account.refreshtoken,
            accesstoken: account.accesstoken,
        });
        refreshed = credential;
        const code = await issueCodeFromLoginBuffer(credential.loginBuffer, account.id);
        if (!code) throw new Error('微信授权已续期，但未取到新的游戏登录 Code');
        store.addOrUpdateAccount({
            id: String(account.id),
            code,
            wxid: credential.openid,
            refreshtoken: credential.refreshtoken,
            accesstoken: credential.accesstoken,
            loginBuffer: credential.loginBuffer,
            expires_in: credential.expires_in,
            expires_at: credential.expires_at,
            wxCredentialRefreshedAt: credential.refreshedAt,
            wxCredentialLastAttemptAt: attemptedAt,
            wxCredentialRefreshError: '',
            wxCredentialNeedsRescan: false,
        } as any);
        return { ok: true, accountId: String(account.id), accountName, code, expiresAt: credential.expires_at, codeIssued: true };
    }
    catch (error: any) {
        // refreshtoken 一旦被服务端刷新就立即作废旧值：即使后续换 Code 失败，
        // 也必须把新 token / loginBuffer 落盘，否则账号里留着死 token，
        // 之后每次续期都会失败（用户看到的“续期一直失败”）。
        const rotated = (error && error.rotated) || (refreshed
            ? {
                refreshtoken: refreshed.refreshtoken,
                accesstoken: refreshed.accesstoken,
                loginBuffer: refreshed.loginBuffer,
                expires_in: refreshed.expires_in,
                expires_at: refreshed.expires_at,
                refreshedAt: refreshed.refreshedAt,
            }
            : null);
        const message = String((error && error.message) || '微信授权续期失败');
        const info = classifyProtocolError(error);
        store.addOrUpdateAccount({
            id: String(account.id),
            ...(rotated
                ? {
                    ...(rotated.loginBuffer ? { loginBuffer: rotated.loginBuffer } : {}),
                    refreshtoken: rotated.refreshtoken,
                    accesstoken: rotated.accesstoken,
                    expires_in: rotated.expires_in,
                    expires_at: rotated.expires_at,
                    wxCredentialRefreshedAt: rotated.refreshedAt,
                }
                : {}),
            wxCredentialLastAttemptAt: attemptedAt,
            wxCredentialRefreshError: message,
            ...(info.needsRescan ? { wxCredentialNeedsRescan: true } : {}),
        } as any);
        return {
            ok: false,
            accountId: String(account.id),
            accountName,
            error: message,
            expiresAt: rotated ? rotated.expires_at : Number(account.expires_at) || undefined,
            needsRescan: info.needsRescan,
            kind: info.kind,
            codeIssued: false,
        };
    }
}

/**
 * 启动前 / 掉线后获取新鲜的游戏 Code（老版 issueFarmCode 策略）。
 *
 * loginBuffer 是长效凭证，未过期时直接用它换 Code，**完全不碰 OAuth 层**；
 * 只有 loginBuffer 缺失 / 已过期 / 被服务端拒绝（ManualAuth rejected）且存在
 * refreshtoken 时，才走滚动续期后再换。这条「能用 buffer 就不动 token」的顺序
 * 很关键：它让绝大多数掉线恢复都是零 OAuth 调用的。
 */
async function doEnsureFreshGameCode(accountId: unknown): Promise<CredentialRefreshResult> {
    const account = getAccountById(accountId);
    const accountName = String((account && (account.name || account.nick)) || accountId || '');
    if (!account) {
        return { ok: false, accountId: String(accountId || ''), accountName, error: '账号不存在' };
    }
    if (String(account.platform || '') !== 'wx') {
        return { ok: false, accountId: String(account.id), accountName, error: '仅微信账号支持自动换码' };
    }
    const loginBuffer = String(account.loginBuffer || '').trim();
    const refreshToken = String(account.refreshtoken || '').trim();
    if (!loginBuffer && !refreshToken) {
        const error = '账号缺少微信登录凭证，请重新扫码登录';
        store.addOrUpdateAccount({
            id: String(account.id),
            wxCredentialLastAttemptAt: Date.now(),
            wxCredentialRefreshError: error,
            wxCredentialNeedsRescan: true,
        } as any);
        return { ok: false, accountId: String(account.id), accountName, error, needsRescan: true, kind: 'refresh_rejected' };
    }

    const attemptedAt = Date.now();
    const expiresAt = Number(account.expires_at) || 0;
    const expired = expiresAt > 0 && expiresAt <= attemptedAt;

    // 1) loginBuffer 可用时直接换 Code（不触发滚动续期、不消耗 OAuth 额度）。
    if (loginBuffer && (!expired || !refreshToken)) {
        try {
            const code = await issueCodeFromLoginBuffer(loginBuffer, account.id);
            if (!code) throw new Error('服务端未返回 code');
            store.addOrUpdateAccount({
                id: String(account.id),
                code,
                wxCredentialLastAttemptAt: attemptedAt,
                wxCredentialRefreshError: '',
                wxCredentialNeedsRescan: false,
            } as any);
            return { ok: true, accountId: String(account.id), accountName, code, expiresAt: expiresAt || undefined, codeIssued: true };
        }
        catch (error: any) {
            const message = String(error?.message || '换取游戏 Code 失败');
            // 只有「ticket 被拒 / 服务端未返回 code」才值得滚一次 token 重试；
            // -14（AppID 拒绝）与 -109（凭证已吊销）都不该再动 OAuth 层。
            const retryWithFreshTicket = refreshToken && /ManualAuth rejected|服务端未返回 code/.test(message)
                && !/-109|42007|40030|42002/.test(message);
            if (!retryWithFreshTicket) {
                const info = classifyProtocolError(error);
                store.addOrUpdateAccount({
                    id: String(account.id),
                    wxCredentialLastAttemptAt: attemptedAt,
                    wxCredentialRefreshError: message,
                    ...(info.needsRescan ? { wxCredentialNeedsRescan: true } : {}),
                } as any);
                return {
                    ok: false,
                    accountId: String(account.id),
                    accountName,
                    error: message,
                    expiresAt: expiresAt || undefined,
                    needsRescan: info.needsRescan,
                    kind: info.kind,
                    codeIssued: false,
                };
            }
        }
    }

    // 2) 滚动续期：refreshtoken → 新 accessToken/loginBuffer → 新 Code。
    //    调用无锁内部版本：当前已经在锁内，避免同账号重入死锁。
    const refreshed = await doRefreshAccountCredential(accountId);
    // 换回来的 buffer 与原来一字不差，说明服务端没给新 ticket，再试也是同一个结果。
    if (refreshed && refreshed.ok && loginBuffer) {
        const latest = getAccountById(account.id);
        if (latest && String(latest.loginBuffer || '') === loginBuffer && !refreshed.code) {
            return {
                ...refreshed,
                ok: false,
                error: '重新取到的登录凭证与原来一致，服务端未签发新 ticket，请重新扫码',
                needsRescan: true,
                kind: 'ticket_rejected',
            };
        }
    }
    return refreshed;
}

/** 对外入口统一串行化，所有续期/换码调用方共享同一把账号锁。 */
function refreshAccountCredential(accountId: unknown): Promise<CredentialRefreshResult> {
    return withAccountCredentialLock(accountId, () => doRefreshAccountCredential(accountId));
}

/** 只滚 OAuth token（后台保活专用）：不取 loginBuffer、不换 Code、不重启。 */
function renewOAuthToken(accountId: unknown): Promise<CredentialRefreshResult> {
    return withAccountCredentialLock(accountId, () => doRenewOAuthToken(accountId));
}

function ensureFreshGameCode(accountId: unknown): Promise<CredentialRefreshResult> {
    return withAccountCredentialLock(accountId, () => doEnsureFreshGameCode(accountId));
}

module.exports = {
    TARGET_APP_ID,
    hasWxCredential,
    hasRenewableCredential,
    issueCodeFromLoginBuffer,
    refreshAccountCredential,
    renewOAuthToken,
    ensureFreshGameCode,
};
