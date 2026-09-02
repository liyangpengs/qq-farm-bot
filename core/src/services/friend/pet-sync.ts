/**
 * 好友宠物每日同步 - 把护主犬探测从“每轮帮忙”改成“每天一轮”
 *
 * 护主犬只能从 VisitService.Enter 回包的 brief_dog_info 读到，所以本模块是唯一为了拿宠物
 * 信息而额外发 RPC 的地方；其余时候全靠 api.ts 里 Enter 回包的顺手写入。
 *
 * 网关约束（参见 utils/request-priority.ts 与 docs/network-concurrency.md）：
 * - 全部请求走 background 班次，只有连接彻底空闲时才会发出，在协议层就不会挤压任何业务流量；
 * - 串行 + 分批 + 固定 2 秒间隔，且一轮只探当前配额内的几位：服务端对进出好友农场有速率限制，
 *   一轮连探几十位之后网关会对所有请求彻底静默，最后心跳三连失败掉线；
 * - 轮次配额与轮间间隔自适应（planNextSyncPacing）：干净跑完一轮就加量加速，让路一次就退回基线；
 * - 进每位好友前先给好友巡查让路，等不到空闲就把剩下的好友留给下一轮（单向门控）；
 * - 进每位好友前还要等网关空闲（waitForGatewayIdle）：队列里有业务请求、或有业务请求在飞时不排队。
 *   协议层的 background 槽位只保证「不抢先」，不保证「不叠加」：209 位好友一路硬排会把队列和 pending 拉满，
 *   Enter/Leave 熬到超时刷一屏日志，最后连心跳都可能被挤到掉线。拿不到空闲窗口就整轮让路，
 *   让路时按 classifyGatewayDefer() 区分「只是被主流程占着」（短退避）和「服务端静默」（30 分钟冷却）。
 */

const { isAutomationOn, getFriendBlacklist } = require('../../models/store');
const { getUserState, waitForGatewayIdle, getGatewayLoad } = require('../../utils/network');
const { isGatewayYieldError, isGatewayHealthyForBusiness } = require('../../utils/low-priority-gate');
const { runWithRequestClass } = require('../../utils/request-context');
const { toNum, log, logWarn, sleep, getSystemDateKey } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');
const { getAllFriends, enterFriendFarm, leaveFriendFarm } = require('./api');
const { extractReplyFriends, getInvalidKnownFriendGidSet } = require('./gid-manager');
const {
    isFriendDogKnownToday,
    isFullSyncDoneToday,
    markFullSyncDone,
    getFriendPetCacheStats,
} = require('./pet-cache');

// 延迟引用，避开 scheduler / visit-strategy 之间已有的循环依赖
let _scheduler: any = null;
function schedulerRef(): any {
    if (!_scheduler) _scheduler = require('./scheduler');
    return _scheduler;
}

let _visitStrategy: any = null;
function visitStrategyRef(): any {
    if (!_visitStrategy) _visitStrategy = require('./visit-strategy');
    return _visitStrategy;
}

// 节奏参数。服务端对进出好友农场似乎有速率/配额限制：早期版本一轮连探 60~75 位（约 3 RPC/s）之后，
// 网关会对所有请求彻底静默（pending 挂十几秒、无任何入站数据），最后心跳三连失败掉线。
//
// 真正的安全线是「瞬时速率」——批内 SYNC_GAP_MS 固定 2 秒不动，一位好友两个 RPC，约 0.9 RPC/s。
// 轮次配额和轮间间隔则是自适应的（见 planNextSyncPacing）：干净跑完一轮就加速加量，
// 一旦让路就立刻回到基线并且当天不再上调。这样 200 位好友在健康连接上半小时内补齐，
// 服务端一皱眉就退回保守节奏，而不是像固定「每 10 分钟 10 位」那样慢慢磨几个小时。
const SYNC_BATCH_SIZE: number = 5;
const SYNC_GAP_MS: number = 2000;
const SYNC_BATCH_GAP_MS: number = 3000;
// 轮次配额：基线 10 位，每跑干净一轮 +5，封顶 25 位
const SYNC_MAX_PER_ROUND_BASE: number = 10;
const SYNC_MAX_PER_ROUND_STEP: number = 5;
const SYNC_MAX_PER_ROUND_CAP: number = 25;
// 撞上网关静默之后的冷却时间：比常规检查更久，避免贴着服务端的限制反复试探
const SYNC_BUSY_COOLDOWN_MS: number = 30 * 60 * 1000;
const FRIEND_TASK_WAIT_MAX_MS: number = 10000;
const FRIEND_TASK_POLL_MS: number = 250;
// 等网关空闲的最长时间：等不到就整轮让路，剩下的好友留给下一轮
const GATEWAY_IDLE_WAIT_MAX_MS: number = 8000;
// 基线间隔：当天没活、开关关着、跨日等情况下的巡检节奏
const SYNC_CHECK_INTERVAL_MS: number = 10 * 60 * 1000;
// 干净跑完一轮但好友还没探完时的间隔：这时候连接是健康的，没必要空等 10 分钟
const SYNC_FAST_INTERVAL_MS: number = 3 * 60 * 1000;
// 只是抢不到空闲窗口（自家前台/农场请求正忙）时的短退避，与服务端静默的 30 分钟冷却区分开
const SYNC_CONTENTION_RETRY_MS: number = 60 * 1000;
// 不参与登录关键路径：登录序列（每日礼包 → 任务 → 神秘商店）串行跑完之后再排
const SYNC_STARTUP_DELAY_MS: number = 90 * 1000;

const petSyncScheduler: any = createScheduler('friend-pet-sync');
let syncRunning: boolean = false;
// 撞上网关繁忙后的冷却截止时间，冷却期内定时检查直接跳过
let syncBlockedUntil: number = 0;
// 自适应节奏状态：当天的轮次配额、是否已经因为让路锁死上调、以及记账日期
let roundQuota: number = SYNC_MAX_PER_ROUND_BASE;
let quotaRampLocked: boolean = false;
let pacingDateKey: string = '';
// 轮次链是否还在跑，停表之后不再自我续期
let syncTimerActive: boolean = false;

export interface FriendPetSyncResult {
    outcome: 'skipped' | 'fresh' | 'synced' | 'deferred' | 'error';
    reason?: string;
    checked?: number;
    failed?: number;
    deferred?: number;
    pending?: number;
}

function isSyncEnabled(): { enabled: boolean; reason: string } {
    if (!isAutomationOn('friend')) return { enabled: false, reason: 'friend_off' };
    if (!isAutomationOn('friend_help')) return { enabled: false, reason: 'friend_help_off' };
    // 护主犬开关关闭时，这份数据没有消费方，一个额外 RPC 都不应该花；
    // Enter 回包的顺手写入不受影响，开关重新打开时已有一部分结论可用。
    if (!isAutomationOn('friend_help_protect_dog_ignore_exp_limit')) {
        return { enabled: false, reason: 'protect_dog_bypass_off' };
    }
    return { enabled: true, reason: '' };
}

function enterGatewayCooldown(): void {
    syncBlockedUntil = Date.now() + SYNC_BUSY_COOLDOWN_MS;
}

/**
 * 拿不到空闲窗口分两种情况，代价差 30 倍，必须分开：
 * - 网关健康，只是自家前台操作 / 农场巡检正占着连接 → 只是抢窗口失败，几十秒后再来就行；
 * - 心跳漏拍或有在途请求卡住不回包 → 服务端真的在静默，进 30 分钟冷却，别再试探。
 */
function classifyGatewayDefer(): 'gateway_contention' | 'gateway_busy' {
    if (isGatewayHealthyForBusiness(getGatewayLoad())) return 'gateway_contention';
    enterGatewayCooldown();
    return 'gateway_busy';
}

function describeDeferReason(reason: string): string {
    if (reason === 'gateway_busy') return '网关静默';
    if (reason === 'gateway_contention') return '连接被主流程占用';
    if (reason === 'round_quota') return '本轮配额已用完';
    if (reason === 'friend_task_busy') return '好友巡查占用';
    if (reason === 'switch_off') return '开关已关闭';
    return reason || '未知';
}

export interface SyncPacingState {
    /** 下一轮的好友配额 */
    quota: number;
    /** 当天是否已经不再上调配额 */
    rampLocked: boolean;
}

export interface SyncPacing extends SyncPacingState {
    /** 距离下一轮的等待时间 */
    delayMs: number;
}

// 这些让路原因说明连接没余力，不是「活干完了」：出现一次就退回基线并锁死当天的配额上调
const YIELD_DEFER_REASONS: Set<string> = new Set(['gateway_busy', 'gateway_contention', 'friend_task_busy']);

/**
 * 根据本轮结果决定下一轮的节奏（纯函数，便于测试）。
 *
 * - 让路收场：配额回基线并锁死上调；只是抢窗口失败就 1 分钟后重试，服务端静默则回基线间隔
 *   （此时 syncBlockedUntil 的 30 分钟冷却已经生效，下一轮会直接 skipped）；
 * - 干净跑完但好友没探完（round_quota）：说明连接扛得住，配额 +5 并用较短的间隔接上；
 * - 其余情况（当天已完成 / 没活 / 开关关闭 / 异常）：回基线间隔，配额不动。
 */
export function planNextSyncPacing(result: FriendPetSyncResult | null | undefined, current: SyncPacingState): SyncPacing {
    const reason: string = String((result && result.reason) || '');
    if (YIELD_DEFER_REASONS.has(reason)) {
        return {
            delayMs: reason === 'gateway_busy' ? SYNC_CHECK_INTERVAL_MS : SYNC_CONTENTION_RETRY_MS,
            quota: SYNC_MAX_PER_ROUND_BASE,
            rampLocked: true,
        };
    }
    if (result && result.outcome === 'deferred' && reason === 'round_quota') {
        return {
            delayMs: SYNC_FAST_INTERVAL_MS,
            quota: current.rampLocked
                ? current.quota
                : Math.min(SYNC_MAX_PER_ROUND_CAP, current.quota + SYNC_MAX_PER_ROUND_STEP),
            rampLocked: current.rampLocked,
        };
    }
    return { delayMs: SYNC_CHECK_INTERVAL_MS, quota: current.quota, rampLocked: current.rampLocked };
}

async function waitForFriendTaskIdle(): Promise<boolean> {
    const deadline: number = Date.now() + FRIEND_TASK_WAIT_MAX_MS;
    while (schedulerRef().isFriendCheckRunning()) {
        if (Date.now() >= deadline) return false;
        await sleep(FRIEND_TASK_POLL_MS);
    }
    return true;
}

type ProbeOutcome = 'ok' | 'failed' | 'yield';

async function probeFriendDog(gid: number, name: string): Promise<ProbeOutcome> {
    let entered: boolean = false;
    try {
        // 回包里的 brief_dog_info 由 api.ts 的 enterFriendFarm 统一写进缓存，这里不需要再解析
        await enterFriendFarm(gid, 'low');
        entered = true;
        return 'ok';
    } catch (e: any) {
        // 网关没余力或连接已断：这不是这位好友的问题，整轮让路，不逐个刷超时日志
        if (isGatewayYieldError(e)) return 'yield';
        // 复用已有的封禁加黑、失效好友清理逻辑
        const handled: { handled: boolean; kind: string } = visitStrategyRef().handleFriendEnterError(gid, name, e);
        if (!handled.handled) {
            logWarn('好友', `同步宠物时进入 ${name} 农场失败: ${e.message}`, {
                module: 'friend', event: '好友宠物同步', result: 'error', friendName: name, friendGid: gid,
            });
        }
        return 'failed';
    } finally {
        // Leave 必须配对送出：background 请求在网关忙的时候会被让路丢掉，留下「还在别人农场里」的
        // 服务端状态，所以这一次清理提到 friend 班次——它只是一个已经发生的访问的收尾，量很小。
        if (entered) await runWithRequestClass('friend', () => leaveFriendFarm(gid, 'normal'));
    }
}

export function collectPendingFriends(friends: any[], myGid: number, blacklist: Set<number>, invalid: Set<number>): Array<{ gid: number; name: string }> {
    const pending: Array<{ gid: number; name: string }> = [];
    const seen: Set<number> = new Set();
    for (const friend of (Array.isArray(friends) ? friends : [])) {
        const gid: number = toNum(friend && friend.gid);
        if (gid <= 0 || gid === myGid) continue;
        if (seen.has(gid)) continue;
        seen.add(gid);
        if (blacklist.has(gid) || invalid.has(gid)) continue;
        // 当天已经有结论的不重复同步（包括帮忙/偷菜/天气扫描顺手写入的）
        if (isFriendDogKnownToday(gid)) continue;
        pending.push({ gid, name: friend.remark || friend.name || `GID:${gid}` });
    }
    return pending;
}

/**
 * 执行一轮同步。当天已经跑完整一轮就直接返回，不会重复扫。
 * 整轮固定跑在 background 班次里：不管是定时器还是面板手动触发，都不许抢业务流量的槽位。
 */
export function runFriendPetSync(): Promise<FriendPetSyncResult> {
    return runWithRequestClass('background', runFriendPetSyncRound);
}

async function runFriendPetSyncRound(): Promise<FriendPetSyncResult> {
    if (syncRunning) return { outcome: 'skipped', reason: 'running' };

    const gate: { enabled: boolean; reason: string } = isSyncEnabled();
    if (!gate.enabled) return { outcome: 'skipped', reason: gate.reason };
    if (Date.now() < syncBlockedUntil) return { outcome: 'skipped', reason: 'gateway_cooldown' };
    if (isFullSyncDoneToday()) return { outcome: 'fresh', reason: 'done_today' };
    // 安静时段不进好友农场，与 checkFriends 保持一致；窗口结束后下一次定时检查会接上
    if (visitStrategyRef().inFriendQuietHours()) return { outcome: 'skipped', reason: 'quiet_hours' };

    const state: any = getUserState();
    const myGid: number = toNum(state && state.gid);
    if (!myGid) return { outcome: 'skipped', reason: 'not_logged_in' };

    // 跨日重新开始爬配额：昨天撞过限制不代表今天也会
    const today: string = getSystemDateKey();
    if (pacingDateKey !== today) {
        pacingDateKey = today;
        roundQuota = SYNC_MAX_PER_ROUND_BASE;
        quotaRampLocked = false;
    }

    syncRunning = true;
    try {
        // 好友列表也是后台请求：网关正忙的时候连它都不该排队
        if (!await waitForGatewayIdle(GATEWAY_IDLE_WAIT_MAX_MS)) {
            return { outcome: 'deferred', reason: classifyGatewayDefer() };
        }
        const reply: any = await getAllFriends(false, 'low');
        const friends: any[] = extractReplyFriends(reply);
        const accountId: string = process.env.FARM_ACCOUNT_ID || '';
        const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));
        const invalid: Set<number> = getInvalidKnownFriendGidSet();
        const pending: Array<{ gid: number; name: string }> = collectPendingFriends(friends, myGid, blacklist, invalid);

        if (pending.length === 0) {
            markFullSyncDone();
            return { outcome: 'fresh', reason: 'all_known', checked: 0 };
        }

        // 一轮只探配额内的这几位，剩下的等下一轮——瞬时突发量越小越不容易踩到服务端限制
        const targets: Array<{ gid: number; name: string }> = pending.slice(0, roundQuota);

        log('好友', `开始同步好友宠物，本轮 ${targets.length} 位，待确认共 ${pending.length} 位`, {
            module: 'friend', event: '好友宠物同步', result: 'start', pending: pending.length, round: targets.length, quota: roundQuota,
        });

        let checked: number = 0;
        let failed: number = 0;
        let deferred: number = pending.length - targets.length;
        let deferReason: string = deferred > 0 ? 'round_quota' : '';

        for (let index: number = 0; index < targets.length; index += SYNC_BATCH_SIZE) {
            const batch: Array<{ gid: number; name: string }> = targets.slice(index, index + SYNC_BATCH_SIZE);
            let yielded: boolean = false;

            for (const friend of batch) {
                if (!isSyncEnabled().enabled) {
                    deferred = pending.length - checked - failed;
                    deferReason = 'switch_off';
                    yielded = true;
                    break;
                }
                if (!await waitForFriendTaskIdle()) {
                    // 好友巡查正在占着进农场这个状态，把剩下的好友留给下一次定时检查
                    deferred = pending.length - checked - failed;
                    deferReason = 'friend_task_busy';
                    yielded = true;
                    break;
                }
                // 主流程有请求在排队或在飞、或者已经有请求卡住不回包，就不插队；
                // 等不到空闲窗口整轮让路，别把队列和 pending 拉满
                if (!await waitForGatewayIdle(GATEWAY_IDLE_WAIT_MAX_MS)) {
                    deferred = pending.length - checked - failed;
                    deferReason = classifyGatewayDefer();
                    yielded = true;
                    break;
                }
                const outcome: ProbeOutcome = await probeFriendDog(friend.gid, friend.name);
                if (outcome === 'yield') {
                    // 请求排到一半网关就忙起来了：本轮到此为止，剩下的等下一轮
                    deferred = pending.length - checked - failed;
                    deferReason = classifyGatewayDefer();
                    yielded = true;
                    break;
                }
                if (outcome === 'ok') checked += 1;
                else failed += 1;
                await sleep(SYNC_GAP_MS);
            }

            if (yielded) break;
            if (index + SYNC_BATCH_SIZE < targets.length) await sleep(SYNC_BATCH_GAP_MS);
        }

        // 只有真正跑完才标记当日完成，否则下一次定时检查继续补剩下的
        if (deferred === 0) markFullSyncDone();

        const stats: any = getFriendPetCacheStats();
        const deferNote: string = deferred > 0 ? `（让路原因：${describeDeferReason(deferReason)}）` : '';
        log('好友', `好友宠物同步完成：确认 ${checked}，失败 ${failed}，待补 ${deferred}${deferNote}，当日护主犬 ${stats.protect} 位`, {
            module: 'friend',
            event: '好友宠物同步',
            result: deferred > 0 ? 'deferred' : 'ok',
            checked,
            failed,
            deferred,
            deferReason,
            known: stats.known,
            protect: stats.protect,
        });

        return {
            outcome: deferred > 0 ? 'deferred' : 'synced',
            reason: deferReason || undefined,
            checked,
            failed,
            deferred,
            pending: pending.length,
        };
    } catch (e: any) {
        // 网关繁忙或连接断开不是同步逻辑的异常，安静地把这一轮留给下一次定时检查
        if (isGatewayYieldError(e)) {
            return { outcome: 'deferred', reason: classifyGatewayDefer() };
        }
        logWarn('好友', `好友宠物同步异常: ${e.message}`, {
            module: 'friend', event: '好友宠物同步', result: 'error',
        });
        return { outcome: 'error', reason: e.message };
    } finally {
        syncRunning = false;
    }
}

/**
 * 轮次链：每轮跑完由 planNextSyncPacing 决定下一轮什么时候来、探几位。
 * 用自我续期的一次性定时器而不是固定 interval，间隔才能跟着连接状态变。
 */
function scheduleNextSyncRound(delayMs: number): void {
    if (!syncTimerActive) return;
    petSyncScheduler.setTimeoutTask('friend_pet_sync_round', Math.max(1000, delayMs), async () => {
        let nextDelayMs: number = SYNC_CHECK_INTERVAL_MS;
        try {
            const result: FriendPetSyncResult = await runFriendPetSync();
            const pacing: SyncPacing = planNextSyncPacing(result, { quota: roundQuota, rampLocked: quotaRampLocked });
            roundQuota = pacing.quota;
            quotaRampLocked = pacing.rampLocked;
            nextDelayMs = pacing.delayMs;
        } catch {
            // 同步内部已经兜住了自己的异常，这里只保证轮次链不断
        }
        scheduleNextSyncRound(nextDelayMs);
    });
}

export function startFriendPetSyncTimer(): void {
    stopFriendPetSyncTimer();
    syncTimerActive = true;
    scheduleNextSyncRound(SYNC_STARTUP_DELAY_MS);
}

export function stopFriendPetSyncTimer(): void {
    syncTimerActive = false;
    petSyncScheduler.clearAll();
    // 掉线重连后重新开始，不把上一条连接的冷却和退避带过来
    syncBlockedUntil = 0;
    roundQuota = SYNC_MAX_PER_ROUND_BASE;
    quotaRampLocked = false;
    pacingDateKey = '';
}

export function isFriendPetSyncRunning(): boolean {
    return syncRunning;
}

export const FRIEND_PET_SYNC_TUNING = {
    SYNC_BATCH_SIZE,
    SYNC_GAP_MS,
    SYNC_BATCH_GAP_MS,
    SYNC_MAX_PER_ROUND_BASE,
    SYNC_MAX_PER_ROUND_STEP,
    SYNC_MAX_PER_ROUND_CAP,
    SYNC_BUSY_COOLDOWN_MS,
    FRIEND_TASK_WAIT_MAX_MS,
    FRIEND_TASK_POLL_MS,
    GATEWAY_IDLE_WAIT_MAX_MS,
    SYNC_CHECK_INTERVAL_MS,
    SYNC_FAST_INTERVAL_MS,
    SYNC_CONTENTION_RETRY_MS,
    SYNC_STARTUP_DELAY_MS,
};
