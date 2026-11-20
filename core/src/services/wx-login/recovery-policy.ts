export {};
/**
 * 微信登录链路的错误分类与恢复策略。
 *
 * 移植 YYB-Go-Enhanced 的 internal/protocol/code_recovery.go：
 * 微信在各个阶段拒绝请求时给的是同一个「数字」，但含义完全不同——
 * 有的是「这个 AppID 被拒」，有的是「ticket 过期」，有的是「token 被吊销」。
 * 早期实现一律当成「续期失败 → 重登」，于是出现两类反向伤害：
 *
 *   1. `-14`（应用层拒绝）时重新登录，把本来还能用的授权白白消耗一次；
 *   2. `-109`（refresh token 已被吊销）时继续按节奏重试，在授权层不断累加拒绝。
 *
 * 这里只做「分类 + 该等多久」这一件事，不碰网络、不碰存储，便于单测覆盖全表。
 */

export type ProtocolErrorKind =
    /** js-login 的业务拒绝（-14）：AppID 侧拒绝，不代表会话失效。 */
    | 'application_rejected'
    /** ManualAuth 的 ticket 被拒（-10）：允许重新取一次 ticket。 */
    | 'ticket_rejected'
    /** access token 失效（-101 / 40014 / 42001）：还能靠 refresh token 救。 */
    | 'access_rejected'
    /** refresh token 已被吊销（-109 / 42007 / 40030 / 42002）：救不回来。 */
    | 'refresh_rejected'
    /** scope 不匹配（40188 + invalid scope）：授权范围本身失效。 */
    | 'scope_rejected'
    /** 网络 / 超时 / 5xx / 无法识别的错误。 */
    | 'transient';

export interface ProtocolErrorInfo {
    kind: ProtocolErrorKind;
    /** 从报文里抽出来的业务码，抽不到为 null。 */
    code: number | null;
    message: string;
    /** 服务端已明确吊销凭证：必须停止自动重试，等用户重新扫码。 */
    definitive: boolean;
    needsRescan: boolean;
    retryable: boolean;
    /** 属于「业务层拒绝」（-14 / -10），可以重试用新 ticket，但不该直接滚 token。 */
    businessRejected: boolean;
}

/** js-login 业务拒绝：AppID 自己的拒绝，不是会话失效。 */
const APPLICATION_REJECTED = -14;
/** ManualAuth 的 ticket 被拒。 */
const TICKET_REJECTED = -10;
const ACCESS_REJECTED_CODES = [-101, 40014, 42001];
const REFRESH_REJECTED_CODES = [-109, 42007, 40030, 42002];
const SCOPE_REJECTED_CODE = 40188;

/**
 * 「刚成功过就不要再登录」的窗口。
 *
 * -14 更像 AppID 自己的拒绝。两分钟内同一个会话刚拿到过 code，再花一次
 * ManualAuth + ticket 去换，只会让授权层多一次拒绝记录。这是启发式判断，
 * 不是服务端有效性的证明，所以窗口设得短（2 分钟）。
 */
const FRESH_SESSION_WINDOW_MS = 2 * 60_000;

/** 同一个 (账号, AppID) 的补码重试间隔：一次 -14 修复失败后 5 分钟内不再试。 */
const CODE_REPAIR_BACKOFF_MS = 5 * 60_000;

/** 保活失败的默认退避上限。 */
const REFRESH_BACKOFF_MS = 5 * 60_000;
/** token 已经过期时的退避：续期窗口已经过去，每个 tick 重试只是重复被拒。 */
const EXPIRED_RETRY_BACKOFF_MS = 15 * 60_000;
/** 退避下限：官方续期窗口只有约 4 分钟，退避 5 分钟会整窗错过。 */
const MIN_BACKOFF_MS = 30_000;

function extractCode(message: string): number | null {
    const matched = /(?:code|ret|retcode|errcode|errorcode)\s*[=:]\s*(-?\d+)/i.exec(message);
    if (matched) {
        const code = Number(matched[1]);
        if (Number.isFinite(code)) return code;
    }
    const http = /HTTP\s+(\d{3})/i.exec(message);
    if (http) {
        const code = Number(http[1]);
        if (Number.isFinite(code)) return code;
    }
    return null;
}

function kindOfCode(code: number | null): ProtocolErrorKind | null {
    if (code === null) return null;
    if (code === APPLICATION_REJECTED) return 'application_rejected';
    if (code === TICKET_REJECTED) return 'ticket_rejected';
    if (code === SCOPE_REJECTED_CODE) return 'scope_rejected';
    if (ACCESS_REJECTED_CODES.includes(code)) return 'access_rejected';
    if (REFRESH_REJECTED_CODES.includes(code)) return 'refresh_rejected';
    return null;
}

/**
 * 凭证被吊销的文案判定（对应 Go 的 definitiveRefreshMessage）。
 *
 * 只认「明确的吊销措辞」，普通传输错误的 body 里偶尔也会出现
 * 「token expired」，那不能当成微信吊销了会话。
 */
function looksRevoked(message: string): boolean {
    const text = String(message || '').toLowerCase().replace(/[_-]/g, ' ');
    if (/invalid\s*scope/.test(text) && text.includes('40188')) return true;
    if (/relogin|re login|重新登录|重新授权|重新扫码/.test(text)) return true;
    const invalid = /invalid|expired|revoked|无效|过期|失效/.test(text);
    // refresh token 的写法有空格、下划线（已归一成空格）和连写三种，一条正则全覆盖。
    const refreshToken = /refresh\s*token|刷新令牌/.test(text);
    return invalid && refreshToken;
}

function classifyProtocolError(error: unknown): ProtocolErrorInfo {
    const message = String((error && (error as any).message) || error || '');
    const code = extractCode(message);
    let kind = kindOfCode(code);
    if (!kind) kind = looksRevoked(message) ? 'refresh_rejected' : 'transient';

    const definitive = kind === 'refresh_rejected' || kind === 'scope_rejected';
    const businessRejected = kind === 'application_rejected' || kind === 'ticket_rejected';
    return {
        kind,
        code,
        message,
        definitive,
        needsRescan: definitive,
        retryable: !definitive,
        businessRejected,
    };
}

/** 是否属于「业务层拒绝」（-14 / -10）：可以重试，但不该直接滚 token。 */
function isBusinessResponseRejection(error: unknown): boolean {
    return classifyProtocolError(error).businessRejected;
}

/** 是否是 -14：AppID 侧拒绝，最不该触发重新登录的那一类。 */
function isApplicationRequestRejection(error: unknown): boolean {
    return classifyProtocolError(error).kind === 'application_rejected';
}

/**
 * -14 之后要不要真的去补一次会话。
 *
 * 同一个会话在 freshSessionWindow 内刚成功拿到过 code → 这次的 -14 更可能是
 * AppID 自己的拒绝，重新登录只会多消耗一次授权，直接放弃本次修复。
 */
function shouldRepairAfterApplicationRejection(
    error: unknown,
    lastSuccessAt: number,
    now: number = Date.now(),
    freshSessionWindow = FRESH_SESSION_WINDOW_MS,
): boolean {
    if (!isApplicationRequestRejection(error)) return false;
    if (freshSessionWindow <= 0) return true;
    const last = Number(lastSuccessAt) || 0;
    if (!last) return true;
    return now - last >= freshSessionWindow;
}

/**
 * 保活失败后等多久再试（对应 Go 的 keepAliveFailureBackoff）。
 *
 * - 已确定吊销 → 0，表示「不要再自动重试」，由调用方标记需要重新扫码；
 * - token 已过期 → 15 分钟，续期窗口已经过去；
 * - 其余 → min(5 分钟, max(30 秒, 剩余寿命 / 2))。
 */
function computeRefreshBackoff(remainingMs: number, info?: ProtocolErrorInfo | null): number {
    if (info && info.definitive) return 0;
    const remaining = Number(remainingMs);
    if (!Number.isFinite(remaining) || remaining <= 0) return EXPIRED_RETRY_BACKOFF_MS;
    return Math.min(REFRESH_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, Math.floor(remaining / 2)));
}

module.exports = {
    FRESH_SESSION_WINDOW_MS,
    CODE_REPAIR_BACKOFF_MS,
    REFRESH_BACKOFF_MS,
    EXPIRED_RETRY_BACKOFF_MS,
    MIN_BACKOFF_MS,
    classifyProtocolError,
    isBusinessResponseRejection,
    isApplicationRequestRejection,
    shouldRepairAfterApplicationRejection,
    computeRefreshBackoff,
    looksRevoked,
};
