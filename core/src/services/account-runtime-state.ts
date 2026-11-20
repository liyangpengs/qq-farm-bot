export {};
/**
 * 账号维度的运行状态机。
 *
 * 面板此前只有 `running` 一个布尔值，能表达的只有「运行中 / 已停止」。于是这些
 * 真实状态在界面上全是空白：
 *   - 刚点启动、还在建连接 → 和运行中长得一样；
 *   - 掉线后等 N 秒自动重登 → 看起来就是「已停止」，用户以为没在自愈；
 *   - 手动停止、子进程还在退 → 没有「停止中」，按钮还能再点一次。
 *
 * 这里维护一份「账号 id → 状态」的内存账本，写入口在账号生命周期的几个真实
 * 时刻（worker 启动 / 首次连上 / 断开 / 停止 / 进程退出），读出口在
 * `data-provider.getAccounts()` 的列表投影里。纯内存、无持久化：进程一并退出，
 * 重启后所有账号都该从「已停止」重新走一遍启动流程。
 *
 * 约定：
 *   - 状态只能由「知道确凿事实」的地方写入，不要按定时器猜；
 *   - 覆盖写默认允许，但像「进程退出 → 已停止」这类收尾写入必须带 `onlyFrom`，
 *     否则会把异步晚到的「等待重登」覆盖掉（断开流程是先停进程再排重登）。
 */

/** 前端 `account-runtime.ts` 认识的六个状态，改这里要同步改前端联合类型与测试。 */
const ACCOUNT_RUNTIME_STATES = [
    'logging_in',
    'relogin_waiting',
    'running',
    'offline',
    'stopping',
    'stopped',
] as const;

type AccountRuntimeState = (typeof ACCOUNT_RUNTIME_STATES)[number];

interface AccountRuntimeEntry {
    state: AccountRuntimeState;
    /** 仅 `relogin_waiting` 有值：预计重登时刻（毫秒时间戳），供面板倒计时。 */
    reloginAt: number;
    updatedAt: number;
}

interface SetStateOptions {
    /** `relogin_waiting` 的预计重登时刻。 */
    reloginAt?: number;
    /** 只在这些当前状态之下才写入；缺省表示无条件覆盖。 */
    onlyFrom?: readonly AccountRuntimeState[];
    /** 时间基准，测试用。 */
    now?: number;
}

/**
 * 「停止中」的最大存活时间。
 *
 * 正常路径下 `stopWorker` 会挂 1 秒强杀兜底、进程随即退出，状态很快转成「已停止」。
 * 但如果子进程卡在不可中断的 IO 上、连 `kill()` 都不返回，`stopping` 会一直挂着，
 * 面板上那颗「停止」按钮就永久置灰——比不显示状态更糟。超时后按「已停止」处理。
 */
const STOPPING_STALE_MS = 30 * 1000;

const entries = new Map<string, AccountRuntimeEntry>();

function normalizeAccountId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function isRuntimeState(value: unknown): value is AccountRuntimeState {
    return typeof value === 'string' && (ACCOUNT_RUNTIME_STATES as readonly string[]).includes(value);
}

/**
 * 写入账号状态。非法 id / 非法状态直接忽略（返回 false），不抛异常——
 * 调用点全在 worker 事件回调里，抛出去就是 uncaughtException。
 */
function setAccountRuntimeState(accountId: unknown, state: AccountRuntimeState, options: SetStateOptions = {}): boolean {
    const id = normalizeAccountId(accountId);
    if (!id || !isRuntimeState(state)) return false;
    const current = entries.get(id);
    if (Array.isArray(options.onlyFrom)) {
        const allowed = options.onlyFrom as readonly AccountRuntimeState[];
        if (!current || !allowed.includes(current.state)) return false;
    }
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const reloginAt = state === 'relogin_waiting' ? Math.max(0, Number(options.reloginAt) || 0) : 0;
    entries.set(id, { state, reloginAt, updatedAt: now });
    return true;
}

/**
 * 读取账号状态；没有记录返回 null（代表「本次进程还没碰过这个账号」）。
 * `stopping` 超时按 `stopped` 返回，避免面板按钮永久置灰。
 */
function getAccountRuntimeState(accountId: unknown, now: number = Date.now()): AccountRuntimeEntry | null {
    const id = normalizeAccountId(accountId);
    if (!id) return null;
    const entry = entries.get(id);
    if (!entry) return null;
    if (entry.state === 'stopping' && now - entry.updatedAt > STOPPING_STALE_MS) {
        return { state: 'stopped', reloginAt: 0, updatedAt: entry.updatedAt };
    }
    return entry;
}

/** 账号被删除 / 被彻底清理时调用，避免状态残留在内存里。 */
function clearAccountRuntimeState(accountId: unknown): boolean {
    const id = normalizeAccountId(accountId);
    if (!id) return false;
    return entries.delete(id);
}

/** 测试用：清空全部记录。 */
function resetAccountRuntimeStates(): void {
    entries.clear();
}

module.exports = {
    ACCOUNT_RUNTIME_STATES,
    STOPPING_STALE_MS,
    setAccountRuntimeState,
    getAccountRuntimeState,
    clearAccountRuntimeState,
    resetAccountRuntimeStates,
};
