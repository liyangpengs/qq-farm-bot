export {};
/**
 * 微信协议会话复用。
 *
 * 原来每次换 Code 都是「全新 mmtls 握手 → ManualAuth → js-login」，会话是
 * getNativeWxLoginCode 的局部变量，函数返回就丢。代价是每换一次 Code 就多
 * 一次 ManualAuth（OAuth 层的登录），而这正是登录预算要限制的东西。
 *
 * 这里把握手结果按「loginBuffer + AppID」缓存起来：PSK / ticket / sendKey /
 * recvKey / uin / deviceId / hostAppId 都在里面，下次换 Code 可以直接走
 * 短链 early data，跳过整个长链握手与 ManualAuth。
 *
 * 有意不落盘：这些是会话密钥，写进 store.json 等于把可解密通道的钥匙
 * 存到磁盘上。进程重启后重新握手一次即可，成本可以接受。
 */

const DEFAULT_SESSION_TTL_MS = 20 * 60_000;
const MAX_ENTRIES = 64;

export interface CachedSession {
    sendKey: Buffer;
    recvKey: Buffer;
    f9: Buffer;
    uin: bigint;
    deviceId: Buffer;
    hostAppId: Buffer;
    psk: Buffer;
    ticket: Buffer;
}

interface Entry {
    session: CachedSession;
    storedAt: number;
    hits: number;
}

const entries = new Map<string, Entry>();

function digest(loginBuffer: string): string {
    const crypto = require('node:crypto');
    return crypto.createHash('sha256')
        .update(String(loginBuffer || ''))
        .digest('hex');
}

/** 缓存键只留摘要，避免把 loginBuffer 明文当 Map key 出现在内存快照里。 */
function sessionCacheKey(loginBuffer: string, appId: string): string {
    return `${digest(loginBuffer)}|${String(appId || '')}`;
}

function getCachedSession(key: string, now: number = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS): CachedSession | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now - entry.storedAt >= ttlMs) {
        entries.delete(key);
        return null;
    }
    entry.hits += 1;
    return entry.session;
}

function hasBytes(value: any): boolean {
    // 空 Buffer 在 JS 里是真值，必须按长度判断，否则半截会话会被缓存下来。
    return Buffer.isBuffer(value) && value.length > 0;
}

function setCachedSession(key: string, session: CachedSession, now: number = Date.now()): void {
    if (!session
        || !hasBytes(session.sendKey)
        || !hasBytes(session.recvKey)
        || !hasBytes(session.ticket)
        || !hasBytes(session.psk)) return;
    if (entries.size >= MAX_ENTRIES) {
        // 简单的 FIFO 淘汰：这些会话本来就有 20 分钟寿命，没必要做 LRU 精细控制。
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
    }
    entries.set(key, { session, storedAt: now, hits: 0 });
}

function invalidateCachedSession(key: string): void {
    entries.delete(key);
}

function clearSessionCache(): void {
    entries.clear();
}

function sessionCacheStats(): { size: number; keys: string[] } {
    return { size: entries.size, keys: [...entries.keys()] };
}

module.exports = {
    DEFAULT_SESSION_TTL_MS,
    sessionCacheKey,
    getCachedSession,
    setCachedSession,
    invalidateCachedSession,
    clearSessionCache,
    sessionCacheStats,
};
