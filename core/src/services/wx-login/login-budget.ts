export {};
/**
 * 登录预算：限制「业务流量让 OAuth 层干活」的频率。
 *
 * 移植 YYB-Go-Enhanced 的 internal/protocol/login_budget.go。那份注释里有个
 * 真实事故值得原样记住：青龙脚本 4 分钟内对 120 个 AppID 发了 120 个请求，
 * 约 3 分钟就把一个健康授权打死，拒绝链是
 * `login_buffer -101/42007 → refresh_token -109 → check_login -109/42007`。
 * 结论不是「请求太多」，而是「OAuth 层被调用的次数太多」。
 *
 * 因此这里计的是：新建 ticket、拿新 ticket 做 ManualAuth、强制滚 token。
 * 保活续期与用户手动续期**不计数**——它们是有节奏的、稀少的。
 */

const DEFAULT_LOGIN_BUDGET = 3;
const DEFAULT_LOGIN_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_ACCOUNTS = 4096;

export interface LoginBudgetResult {
    /** false 表示这个窗口内额度已用尽，调用方应直接返回原有错误，不要再去打上游。 */
    allowed: boolean;
    /** 窗口内已用次数（含本次，allowed=false 时为已用满的次数）。 */
    used: number;
    /** 距离最早一次调用滑出窗口还有多久；额度未满时为 0。 */
    retryAfterMs: number;
}

function prune(uses: number[], cutoff: number): number[] {
    let drop = 0;
    while (drop < uses.length && uses[drop] <= cutoff) drop++;
    return drop ? uses.slice(drop) : uses;
}

function createLoginBudget(limit = DEFAULT_LOGIN_BUDGET, windowMs = DEFAULT_LOGIN_WINDOW_MS) {
    const buckets = new Map<string, number[]>();

    function bucketOf(accountId: string, now: number): number[] {
        const key = String(accountId || '');
        let uses = buckets.get(key);
        if (!uses) {
            if (buckets.size >= MAX_TRACKED_ACCOUNTS) buckets.clear();
            uses = [];
            buckets.set(key, uses);
        }
        const cutoff = now - windowMs;
        const pruned = prune(uses, cutoff);
        if (pruned !== uses) buckets.set(key, pruned);
        return pruned;
    }

    return {
        limit,
        windowMs,
        /** 检查并**占用**一次额度（滑动窗口，与 Go 的 take 语义一致）。 */
        take(accountId: string, now: number = Date.now()): LoginBudgetResult {
            if (!(limit > 0)) return { allowed: true, used: 0, retryAfterMs: 0 };
            const uses = bucketOf(accountId, now);
            if (uses.length < limit) {
                uses.push(now);
                return { allowed: true, used: uses.length, retryAfterMs: 0 };
            }
            const oldest = uses[0];
            return { allowed: false, used: uses.length, retryAfterMs: Math.max(1, oldest + windowMs - now) };
        },
        /** 只看不占，用于面板诊断。 */
        peek(accountId: string, now: number = Date.now()): LoginBudgetResult {
            if (!(limit > 0)) return { allowed: true, used: 0, retryAfterMs: 0 };
            const uses = bucketOf(accountId, now);
            const allowed = uses.length < limit;
            return {
                allowed,
                used: uses.length,
                retryAfterMs: allowed ? 0 : Math.max(1, uses[0] + windowMs - now),
            };
        },
        reset(): void { buckets.clear(); },
    };
}

/** 进程级共享预算：所有账号共用一张表，各自独立计额度。 */
const loginBudget = createLoginBudget();

module.exports = {
    DEFAULT_LOGIN_BUDGET,
    DEFAULT_LOGIN_WINDOW_MS,
    createLoginBudget,
    loginBudget,
};
