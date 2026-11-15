export {};

/**
 * 手游助手（GameAssist）扫码渠道 - 凭据存储与按需取码
 *
 * 凭据来自面板扫码（syzs OAuth，appid wxef99873dbfab493c），按 openid 存储，可绑定到 bot 账号。
 * worker 需要新农场 code 时：绑定凭据 → 令牌续期（syzs 专线）→ 换 login_buffer →
 * native protocol 铸农场 code，全程服务器端自续期，无需重新扫码。
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../../config/runtime-paths');
const {
    refreshGaCredential,
    checkGaLogin,
    issueGaFarmCode,
} = require('../wx-login/gameassist-service');
const { createModuleLogger } = require('../logger');

const logger = createModuleLogger('gameassist');

const FILE_NAME = 'gameassist-credentials.json';
const RENEW_AHEAD_MS = 45 * 60 * 1000;

function filePath(): string {
    return getDataFile(FILE_NAME);
}

function readRaw(): any {
    try {
        const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
        if (data && typeof data === 'object' && data.credentials && typeof data.credentials === 'object') return data;
    } catch {
        // 文件不存在或损坏时重建
    }
    return { credentials: {} };
}

function writeRaw(data: any): void {
    const target = filePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
}

export function upsert(creds: any, extra: any = {}): any {
    const openid = String(creds?.openid || '').trim();
    if (!openid) throw new Error('缺少 openid');
    const data = readRaw();
    const existing = data.credentials[openid] || {};
    const record = {
        ...existing,
        openid,
        accesstoken: String(creds.accesstoken ?? existing.accesstoken ?? ''),
        refreshtoken: String(creds.refreshtoken ?? existing.refreshtoken ?? ''),
        nickname: String(creds.nickname ?? existing.nickname ?? ''),
        scope: String(creds.scope ?? existing.scope ?? ''),
        expires_in: Number(creds.expires_in ?? existing.expires_in ?? 7200),
        expires_at: Number(creds.expires_at ?? existing.expires_at ?? 0),
        ...extra,
        lastError: '',
    };
    data.credentials[openid] = record;
    writeRaw(data);
    return record;
}

function patch(openid: string, partial: any): void {
    const key = String(openid || '').trim();
    if (!key) return;
    const data = readRaw();
    const existing = data.credentials[key];
    if (!existing) return;
    data.credentials[key] = { ...existing, ...partial };
    writeRaw(data);
}

export function bind(accountId: string, openid: string): any {
    const id = String(accountId || '').trim();
    const key = String(openid || '').trim();
    if (!id || !key) throw new Error('缺少账号或 openid');
    const data = readRaw();
    const record = data.credentials[key];
    if (!record) throw new Error('凭据不存在，请先扫码');
    // 同一凭据换绑：清掉旧账号的绑定
    for (const [k, v] of Object.entries(data.credentials)) {
        if (k !== key && (v as any).accountId === id) (v as any).accountId = '';
    }
    record.accountId = id;
    writeRaw(data);
    return record;
}

export function getByAccountId(accountId: string): any | null {
    const id = String(accountId || '').trim();
    if (!id) return null;
    const data = readRaw();
    for (const record of Object.values(data.credentials)) {
        if (String((record as any).accountId || '') === id) return record;
    }
    return null;
}

export function list(): any[] {
    const data = readRaw();
    return Object.values(data.credentials).map((r: any) => ({
        openid: r.openid,
        accountId: r.accountId || '',
        nickname: r.nickname || '',
        bound: !!r.accountId,
        expiresAt: r.expires_at || 0,
        refreshedAt: r.refreshedAt || 0,
        lastError: r.lastError || '',
    }));
}

const refreshLockMap = new Map<string, Promise<any>>();

/** 同一 openid 串行刷新，防止并发互相覆盖。 */
function locked(openid: string, fn: () => Promise<any>): Promise<any> {
    const prev = refreshLockMap.get(openid) || Promise.resolve();
    const next = prev.catch(() => null).then(fn);
    refreshLockMap.set(openid, next.finally(() => {
        if (refreshLockMap.get(openid) === next) refreshLockMap.delete(openid);
    }));
    return next;
}

async function doRefresh(record: any): Promise<any> {
    const attemptedAt = Date.now();
    try {
        const result = await refreshGaCredential(record);
        patch(record.openid, {
            accesstoken: result.accesstoken,
            refreshtoken: result.refreshtoken,
            expires_in: result.expires_in,
            expires_at: result.expires_at,
            refreshedAt: attemptedAt,
            lastError: '',
        });
        return { ...record, accesstoken: result.accesstoken, refreshtoken: result.refreshtoken, expires_at: result.expires_at };
    } catch (error: any) {
        // -109 等拒绝 → 追问 check-login；会话仍有效则仅更新时间，否则标记凭据异常
        const alive = await checkGaLogin(record);
        if (alive) {
            patch(record.openid, {
                expires_at: Date.now() + 10 * 60 * 1000,
                refreshedAt: attemptedAt,
                lastError: '',
            });
            return record;
        }
        patch(record.openid, {
            refreshedAt: attemptedAt,
            lastError: error && error.message ? error.message : String(error),
        });
        throw error;
    }
}

/** 确保凭据令牌有效（到期前 45 分钟或已过期时刷新）。 */
export async function ensureFresh(record: any): Promise<any> {
    const expiresAt = Number(record?.expires_at || 0);
    if (expiresAt - Date.now() > RENEW_AHEAD_MS && record.accesstoken) return record;
    return locked(record.openid, () => doRefresh(record));
}

/** 为绑定账号取一枚新农场 code：刷新令牌 → login_buffer → native 铸码。 */
export async function mintFarmCode(accountId: string): Promise<string> {
    const record = getByAccountId(accountId);
    if (!record || !record.accesstoken) throw new Error('该账号没有手游助手扫码凭据');
    const fresh = await ensureFresh(record);
    return issueGaFarmCode({ openid: fresh.openid, accesstoken: fresh.accesstoken });
}

/** 按 openid 取一枚新农场 code（扫码 confirm 后立即铸码用）。 */
export async function mintFarmCodeByCredentials(openid: string): Promise<string> {
    const data = readRaw();
    const record = data.credentials[String(openid || '').trim()];
    if (!record || !record.accesstoken) throw new Error('凭据不存在，请先扫码');
    const fresh = await ensureFresh(record);
    return issueGaFarmCode({ openid: fresh.openid, accesstoken: fresh.accesstoken });
}

let keepAliveTimer: any = null;

/** 启动保活定时器：每 10 分钟检查一次，到期前 45 分钟统一刷新。 */
export function startKeepAlive(intervalMs: number = 10 * 60 * 1000): void {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
        tickKeepAlive().catch(() => null);
    }, intervalMs);
    if (keepAliveTimer.unref) keepAliveTimer.unref();
}

export function stopKeepAlive(): void {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
}

async function tickKeepAlive(): Promise<void> {
    const data = readRaw();
    for (const record of Object.values(data.credentials)) {
        const r = record as any;
        if (!r.accesstoken || !r.refreshtoken) continue;
        if (Number(r.expires_at || 0) - Date.now() > RENEW_AHEAD_MS) continue;
        try {
            await locked(r.openid, () => doRefresh(r));
        } catch (error: any) {
            logger.info(`手游助手凭据保活失败（openid ${String(r.openid).slice(0, 10)}…）: ${error && error.message ? error.message : String(error)}`, { channel: '手游助手扫码', result: 'error' });
        }
    }
}
