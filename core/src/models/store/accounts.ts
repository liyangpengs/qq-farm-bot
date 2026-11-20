import type { Account, AccountsData } from '../../types/account';
export {};

const { ensureDataDir } = require('../../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic, storageError } = require('../../services/json-db');

const { ACCOUNTS_FILE } = require('./shared-state');
let accountsCache: AccountsData | null = null;

function cloneAccounts(data: AccountsData): AccountsData {
    return { accounts: data.accounts.map(account => ({ ...account })), nextId: data.nextId };
}

function loadAccounts(): AccountsData {
    accountsCache = null;
    try {
        ensureDataDir();
        const raw = readJsonFileStrict(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
        if (!raw || !Array.isArray(raw.accounts)) throw new Error('Invalid accounts data');
        const data = normalizeAccountsData(raw);
        accountsCache = data;
        return cloneAccounts(data);
    } catch (error: any) {
        throw storageError('读取', ACCOUNTS_FILE, error);
    }
}

function saveAccounts(data: AccountsData): void {
    let normalized: AccountsData;
    try {
        ensureDataDir();
        normalized = normalizeAccountsData(data);
        writeJsonFileAtomic(ACCOUNTS_FILE, normalized);
    }
    catch (error: any) { throw storageError('保存', ACCOUNTS_FILE, error); }
    accountsCache = normalized;
}

function getAccounts(): AccountsData {
    return accountsCache ? cloneAccounts(accountsCache) : loadAccounts();
}

function normalizeAccountsData(raw: unknown): AccountsData {
    const data: any = raw && typeof raw === 'object' ? raw : {};
    const accounts: Account[] = (Array.isArray(data.accounts) ? data.accounts : []).map(normalizeAccount);
    const maxId = accounts.reduce((m: number, a: any) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (accounts.length === 0) nextId = 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return { accounts, nextId };
}

function normalizeAccount(raw: any): Account {
    const source = raw && typeof raw === 'object' ? raw : {};
    const account: Account = {
        id: String(source.id || ''),
        name: String(source.name || ''),
        code: String(source.code || ''),
        platform: String(source.platform || 'qq'),
        uin: String(source.uin || ''),
        qq: String(source.qq || source.uin || ''),
        avatar: String(source.avatar || source.avatarUrl || ''),
        createdAt: Number(source.createdAt) || Date.now(),
        updatedAt: Number(source.updatedAt) || Date.now(),
    };
    const nick = String(source.nick || '').trim();
    if (nick) account.nick = nick;
    // 微信授权凭据：缺失时保持空串，续期时按“缺少凭据，请重新扫码”处理。
    const wxid = String(source.wxid || source.openid || '').trim();
    if (wxid) account.wxid = wxid;
    const refreshToken = String(source.refreshtoken || '').trim();
    if (refreshToken) account.refreshtoken = refreshToken;
    const accessToken = String(source.accesstoken || '').trim();
    if (accessToken) account.accesstoken = accessToken;
    const loginBuffer = String(source.loginBuffer || '').trim();
    if (loginBuffer) account.loginBuffer = loginBuffer;
    for (const key of ['expires_in', 'expires_at', 'wxCredentialRefreshedAt', 'wxCredentialLastAttemptAt'] as const) {
        const value = Number(source[key]);
        if (Number.isFinite(value) && value > 0) account[key] = value;
    }
    const refreshError = String(source.wxCredentialRefreshError || '').trim();
    if (refreshError) account.wxCredentialRefreshError = refreshError;
    // 授权被吊销的闸门必须落盘，否则「停止自动续期」只在内存里存在一瞬：
    // saveAccounts 会用本函数归一化后的结果回填缓存并写文件，漏一个字段就等于
    // wx-keepalive 里那句 `if (account.wxCredentialNeedsRescan) continue` 永远为假，
    // 凭证吊销后第二天跨日重置，又继续拿死 token 空打 OAuth 层。
    // 只保留 true：false / 缺失一律不写，语义是「只有被明确判死才停手」。
    if (source.wxCredentialNeedsRescan === true) account.wxCredentialNeedsRescan = true;
    return account;
}

function addOrUpdateAccount(acc: Partial<Account> & { avatarUrl?: string; openid?: string }): AccountsData {
    const { ensureAccountConfig } = require('./account-config');
    const data = getAccounts();
    let touchedAccountId = '';
    const source: any = acc || {};
    const cleanAccount: any = {};
    for (const key of [
        'id', 'name', 'code', 'platform', 'uin', 'qq', 'avatar', 'avatarUrl', 'nick',
        'wxid', 'openid', 'refreshtoken', 'accesstoken', 'loginBuffer',
        'expires_in', 'expires_at', 'wxCredentialRefreshedAt', 'wxCredentialLastAttemptAt', 'wxCredentialRefreshError',
        'wxCredentialNeedsRescan',
    ]) {
        if (source[key] !== undefined) cleanAccount[key] = source[key];
    }
    acc = cleanAccount;
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            const previous: any = data.accounts[idx];
            const next: any = {
                ...previous,
                ...acc,
                name: acc.name !== undefined ? acc.name : previous.name,
                updatedAt: Date.now(),
            };
            // 重新扫码 / 手动填 Code / 续期成功都会换 Code 或换长效凭据。
            // 此时必须清掉上一次的失败标记，否则账号管理页会一直显示琥珀色
            // 「待续期」，即使凭证已经刷新（用户反馈的“重扫后不是绿色”）。
            // 只有调用方显式传入新的错误信息时才保留它。
            //
            // 「换了 Code」与「换了对令牌」必须分开看：只换 Code（loginBuffer 直接
            // 换码、手动填 Code）并不会延长 access token 的寿命。如果这时也刷新
            // wxCredentialRefreshedAt，code-watch 与 web 端都会按「最近成功 + 2 小时」
            // 重算到期时间，真正的续期窗口被整体推后最多 2 小时——token 过期后
            // 才被发现，表现就是「刚换过码，过一阵还是掉线」。
            const errorClearingKeys = ['code', 'refreshtoken', 'accesstoken', 'loginBuffer', 'wxid', 'openid', 'expires_at'];
            const tokenRotatedKeys = ['refreshtoken', 'accesstoken', 'loginBuffer', 'expires_at'];
            const changed = (key: string) => (acc as any)[key] !== undefined
                && String((acc as any)[key] ?? '') !== String(previous[key] ?? '');
            const credentialRotated = errorClearingKeys.some(changed);
            const tokenRotated = tokenRotatedKeys.some(changed);
            if (credentialRotated && !String((acc as any).wxCredentialRefreshError || '').trim()) {
                delete next.wxCredentialRefreshError;
            }
            if (tokenRotated) {
                if ((acc as any).wxCredentialRefreshedAt === undefined)
                    next.wxCredentialRefreshedAt = Date.now();
                if ((acc as any).wxCredentialLastAttemptAt === undefined)
                    next.wxCredentialLastAttemptAt = Date.now();
            }
            // 「授权已被吊销，只能重新扫码」是保活停止自动重试的开关；换到新凭据
            // （重新扫码 / 手动填 Code / 续期成功）时必须一并清掉，否则账号会永远
            // 停在「不再自动续期」的状态里。调用方显式传 true 时才保留。
            if (credentialRotated && (acc as any).wxCredentialNeedsRescan === undefined) {
                delete next.wxCredentialNeedsRescan;
            }
            data.accounts[idx] = next;
            touchedAccountId = String(next.id || '');
        }
    } else {
        const id = data.nextId++;
        touchedAccountId = String(id);
        data.accounts.push({
            id: touchedAccountId,
            name: acc.name || `账号${id}`,
            code: acc.code || '',
            platform: acc.platform || 'qq',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            avatar: acc.avatar || acc.avatarUrl || '',
            ...(acc.wxid || acc.openid ? { wxid: String(acc.wxid || acc.openid) } : {}),
            ...(acc.refreshtoken ? { refreshtoken: String(acc.refreshtoken) } : {}),
            ...(acc.accesstoken ? { accesstoken: String(acc.accesstoken) } : {}),
            ...(acc.loginBuffer ? { loginBuffer: String(acc.loginBuffer) } : {}),
            ...(acc.expires_in ? { expires_in: Number(acc.expires_in) } : {}),
            ...(acc.expires_at ? { expires_at: Number(acc.expires_at) } : {}),
            ...(acc.wxCredentialRefreshedAt ? { wxCredentialRefreshedAt: Number(acc.wxCredentialRefreshedAt) } : {}),
            ...(acc.wxCredentialLastAttemptAt ? { wxCredentialLastAttemptAt: Number(acc.wxCredentialLastAttemptAt) } : {}),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    saveAccounts(data);
    return data;
}

function deleteAccount(id: unknown): AccountsData {
    const { removeAccountConfig } = require('./account-config');
    const data = getAccounts();
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    removeAccountConfig(id);
    return data;
}

module.exports = {
    loadAccounts,
    saveAccounts,
    getAccounts,
    normalizeAccountsData,
    addOrUpdateAccount,
    deleteAccount,
};
