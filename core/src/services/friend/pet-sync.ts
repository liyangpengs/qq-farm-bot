const { submitAccountTask } = require('../../app/account-task-runner');
const { isAutomationOn, getFriendBlacklist } = require('../../models/store');
const { isGatewayYieldError, isGatewayHealthyForBusiness } = require('../../utils/low-priority-gate');
const { getUserState, getGatewayLoad, waitForGatewayIdle } = require('../../utils/network');
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
const pacing = require('./pet-sync-pacing');

const {
    SYNC_BATCH_SIZE,
    SYNC_GAP_MS,
    SYNC_BATCH_GAP_MS,
    SYNC_MAX_PER_ROUND_BASE,
    SYNC_BUSY_COOLDOWN_MS,
    FRIEND_TASK_WAIT_MAX_MS,
    FRIEND_TASK_POLL_MS,
    GATEWAY_IDLE_WAIT_MAX_MS,
    SYNC_CHECK_INTERVAL_MS,
    SYNC_STARTUP_DELAY_MS,
} = pacing;

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

const petSyncScheduler: any = createScheduler('friend-pet-sync');
let syncRunning = false;
let syncBlockedUntil = 0;
let roundQuota = SYNC_MAX_PER_ROUND_BASE;
let quotaRampLocked = false;
let pacingDateKey = '';
let syncTimerActive = false;

interface FriendRef {
    gid: number;
    name: string;
}

export interface FriendPetSyncResult {
    outcome: 'skipped' | 'fresh' | 'synced' | 'deferred' | 'error';
    reason?: string;
    checked?: number;
    failed?: number;
    deferred?: number;
    pending?: number;
}

interface SyncExecution {
    checked: number;
    failed: number;
    deferred: number;
    deferReason: string;
}

function isSyncEnabled(): { enabled: boolean; reason: string } {
    if (!isAutomationOn('friend')) return { enabled: false, reason: 'friend_off' };
    if (!isAutomationOn('friend_help')) return { enabled: false, reason: 'friend_help_off' };
    if (!isAutomationOn('friend_help_protect_dog_ignore_exp_limit')) {
        return { enabled: false, reason: 'protect_dog_bypass_off' };
    }
    return { enabled: true, reason: '' };
}

function resetPacingForDate(): void {
    const today = getSystemDateKey();
    if (pacingDateKey === today) return;
    pacingDateKey = today;
    roundQuota = SYNC_MAX_PER_ROUND_BASE;
    quotaRampLocked = false;
}

function classifyGatewayDefer(): 'gateway_contention' | 'gateway_busy' {
    if (isGatewayHealthyForBusiness(getGatewayLoad())) return 'gateway_contention';
    syncBlockedUntil = Date.now() + SYNC_BUSY_COOLDOWN_MS;
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

async function waitForFriendTaskIdle(): Promise<boolean> {
    const deadline = Date.now() + FRIEND_TASK_WAIT_MAX_MS;
    while (schedulerRef().isFriendCheckRunning()) {
        if (Date.now() >= deadline) return false;
        await sleep(FRIEND_TASK_POLL_MS);
    }
    return true;
}

type ProbeOutcome = 'ok' | 'failed' | 'yield';

async function probeFriendDog(gid: number, name: string): Promise<ProbeOutcome> {
    let entered = false;
    try {
        await enterFriendFarm(gid, 'low');
        entered = true;
        return 'ok';
    } catch (e: any) {
        if (isGatewayYieldError(e)) return 'yield';
        const handled = visitStrategyRef().handleFriendEnterError(gid, name, e);
        if (!handled.handled) {
            logWarn('好友', `同步宠物时进入 ${name} 农场失败: ${e.message}`, {
                module: 'friend',
                event: '好友宠物同步',
                result: 'error',
                friendName: name,
                friendGid: gid,
            });
        }
        return 'failed';
    } finally {
        if (entered) {
            await runWithRequestClass('friend', () => leaveFriendFarm(gid, 'normal'));
        }
    }
}

export function collectPendingFriends(
    friends: any[],
    myGid: number,
    blacklist: Set<number>,
    invalid: Set<number>,
): FriendRef[] {
    const pending: FriendRef[] = [];
    const seen = new Set<number>();
    for (const friend of (Array.isArray(friends) ? friends : [])) {
        const gid = toNum(friend?.gid);
        if (gid <= 0 || gid === myGid || seen.has(gid)) continue;
        seen.add(gid);
        if (blacklist.has(gid) || invalid.has(gid) || isFriendDogKnownToday(gid)) continue;
        pending.push({ gid, name: friend.remark || friend.name || `GID:${gid}` });
    }
    return pending;
}

async function loadPendingFriends(myGid: number): Promise<FriendRef[] | null> {
    const cached = visitStrategyRef().getFreshFriendsListCacheOnly();
    let friends = cached;
    if (friends.length === 0) {
        if (!await waitForGatewayIdle(GATEWAY_IDLE_WAIT_MAX_MS)) return null;
        friends = extractReplyFriends(await getAllFriends(false, 'low'));
    }

    const accountId = process.env.FARM_ACCOUNT_ID || '';
    return collectPendingFriends(
        friends,
        myGid,
        new Set(getFriendBlacklist(accountId)),
        getInvalidKnownFriendGidSet(),
    );
}

async function executeTargets(pending: FriendRef[], targets: FriendRef[]): Promise<SyncExecution> {
    let checked = 0;
    let failed = 0;
    let deferred = pending.length - targets.length;
    let deferReason = deferred > 0 ? 'round_quota' : '';

    for (let index = 0; index < targets.length; index += SYNC_BATCH_SIZE) {
        const batch = targets.slice(index, index + SYNC_BATCH_SIZE);
        let yielded = false;

        for (const friend of batch) {
            if (!isSyncEnabled().enabled) {
                deferred = pending.length - checked - failed;
                deferReason = 'switch_off';
                yielded = true;
                break;
            }
            if (!await waitForFriendTaskIdle()) {
                deferred = pending.length - checked - failed;
                deferReason = 'friend_task_busy';
                yielded = true;
                break;
            }
            if (!await waitForGatewayIdle(GATEWAY_IDLE_WAIT_MAX_MS)) {
                deferred = pending.length - checked - failed;
                deferReason = classifyGatewayDefer();
                yielded = true;
                break;
            }

            const outcome: ProbeOutcome = await submitAccountTask(
                `friend.pet-sync:${friend.gid}`,
                () => probeFriendDog(friend.gid, friend.name),
                { priority: 'maintenance', dedupeKey: `friend.pet-sync:${friend.gid}` },
            );
            if (outcome === 'yield') {
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

    return { checked, failed, deferred, deferReason };
}

export function runFriendPetSync(): Promise<FriendPetSyncResult> {
    return runWithRequestClass('background', runFriendPetSyncRound);
}

async function runFriendPetSyncRound(): Promise<FriendPetSyncResult> {
    if (syncRunning) return { outcome: 'skipped', reason: 'running' };

    const gate = isSyncEnabled();
    if (!gate.enabled) return { outcome: 'skipped', reason: gate.reason };
    if (Date.now() < syncBlockedUntil) return { outcome: 'skipped', reason: 'gateway_cooldown' };
    if (isFullSyncDoneToday()) return { outcome: 'fresh', reason: 'done_today' };
    if (visitStrategyRef().inFriendQuietHours()) return { outcome: 'skipped', reason: 'quiet_hours' };

    const myGid = toNum(getUserState()?.gid);
    if (!myGid) return { outcome: 'skipped', reason: 'not_logged_in' };
    resetPacingForDate();

    syncRunning = true;
    try {
        const pending = await loadPendingFriends(myGid);
        if (!pending) return { outcome: 'deferred', reason: classifyGatewayDefer() };
        if (pending.length === 0) {
            markFullSyncDone();
            return { outcome: 'fresh', reason: 'all_known', checked: 0 };
        }

        const targets = pending.slice(0, roundQuota);
        log('好友', `开始同步好友宠物，本轮 ${targets.length} 位，待确认共 ${pending.length} 位`, {
            module: 'friend',
            event: '好友宠物同步',
            result: 'start',
            pending: pending.length,
            round: targets.length,
            quota: roundQuota,
        });

        const result = await executeTargets(pending, targets);
        if (result.deferred === 0) markFullSyncDone();

        const stats = getFriendPetCacheStats();
        const deferNote = result.deferred > 0
            ? `（让路原因：${describeDeferReason(result.deferReason)}）`
            : '';
        log('好友', `好友宠物同步完成：确认 ${result.checked}，失败 ${result.failed}，待补 ${result.deferred}${deferNote}，当日护主犬 ${stats.protect} 位`, {
            module: 'friend',
            event: '好友宠物同步',
            result: result.deferred > 0 ? 'deferred' : 'ok',
            checked: result.checked,
            failed: result.failed,
            deferred: result.deferred,
            deferReason: result.deferReason,
            known: stats.known,
            protect: stats.protect,
        });

        return {
            outcome: result.deferred > 0 ? 'deferred' : 'synced',
            reason: result.deferReason || undefined,
            checked: result.checked,
            failed: result.failed,
            deferred: result.deferred,
            pending: pending.length,
        };
    } catch (e: any) {
        if (isGatewayYieldError(e)) {
            return { outcome: 'deferred', reason: classifyGatewayDefer() };
        }
        logWarn('好友', `好友宠物同步异常: ${e.message}`, {
            module: 'friend',
            event: '好友宠物同步',
            result: 'error',
        });
        return { outcome: 'error', reason: e.message };
    } finally {
        syncRunning = false;
    }
}

function scheduleNextSyncRound(delayMs: number): void {
    if (!syncTimerActive) return;
    petSyncScheduler.setTimeoutTask('friend_pet_sync_round', Math.max(1000, delayMs), async () => {
        let nextDelayMs = SYNC_CHECK_INTERVAL_MS;
        try {
            const result = await runFriendPetSync();
            const next = pacing.planNextSyncPacing(result, {
                quota: roundQuota,
                rampLocked: quotaRampLocked,
            });
            roundQuota = next.quota;
            quotaRampLocked = next.rampLocked;
            nextDelayMs = next.delayMs;
        } catch {}
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
    syncBlockedUntil = 0;
    roundQuota = SYNC_MAX_PER_ROUND_BASE;
    quotaRampLocked = false;
    pacingDateKey = '';
}

export function isFriendPetSyncRunning(): boolean {
    return syncRunning;
}

export const planNextSyncPacing = pacing.planNextSyncPacing;
export const FRIEND_PET_SYNC_TUNING = pacing.FRIEND_PET_SYNC_TUNING;
