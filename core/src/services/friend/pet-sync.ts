const { submitAccountTask } = require('../../app/account-task-runner');
const { isAutomationOn, getFriendBlacklist } = require('../../models/store');
const { getUserState } = require('../../utils/network');
const { toNum, log, logWarn, sleep } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');
const { getAllFriends, enterFriendFarm, leaveFriendFarm } = require('./api');
const { extractReplyFriends, getInvalidKnownFriendGidSet } = require('./gid-manager');
const {
    isFriendDogKnownToday,
    isFullSyncDoneToday,
    markFullSyncDone,
    getFriendPetCacheStats,
} = require('./pet-cache');

let _visitStrategy: any = null;
function visitStrategyRef(): any {
    if (!_visitStrategy) _visitStrategy = require('./visit-strategy');
    return _visitStrategy;
}

// 节奏参数对齐好友天气扫描（docs/weather-activity.md），58 位好友整轮约 40 秒
const SYNC_BATCH_SIZE: number = 5;
const SYNC_GAP_MS: number = 300;
const SYNC_BATCH_GAP_MS: number = 1000;
// 每 10 分钟看一眼当天还有没有未确认的好友；开关中途打开、让路后补扫、跳日都靠它兼容
const SYNC_CHECK_INTERVAL_MS: number = 10 * 60 * 1000;
// 不参与登录关键路径：农场 2s / 好友 8s / 每日领取 45s / 神秘商店 60s 之后再排
const SYNC_STARTUP_DELAY_MS: number = 90 * 1000;

const petSyncScheduler: any = createScheduler('friend-pet-sync');
let syncRunning: boolean = false;

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

async function probeFriendDog(gid: number, name: string): Promise<boolean> {
    let entered: boolean = false;
    try {
        // 回包里的 brief_dog_info 由 api.ts 的 enterFriendFarm 统一写进缓存，这里不需要再解析
        await enterFriendFarm(gid, 'low');
        entered = true;
        return true;
    } catch (e: any) {
        // 复用已有的封禁加黑、失效好友清理逻辑
        const handled: { handled: boolean; kind: string } = visitStrategyRef().handleFriendEnterError(gid, name, e);
        if (!handled.handled) {
            logWarn('好友', `同步宠物时进入 ${name} 农场失败: ${e.message}`, {
                module: 'friend', event: '好友宠物同步', result: 'error', friendName: name, friendGid: gid,
            });
        }
        return false;
    } finally {
        if (entered) await leaveFriendFarm(gid, 'low');
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
 */
export async function runFriendPetSync(): Promise<FriendPetSyncResult> {
    if (syncRunning) return { outcome: 'skipped', reason: 'running' };

    const gate: { enabled: boolean; reason: string } = isSyncEnabled();
    if (!gate.enabled) return { outcome: 'skipped', reason: gate.reason };
    if (isFullSyncDoneToday()) return { outcome: 'fresh', reason: 'done_today' };
    // 安静时段不进好友农场，与 checkFriends 保持一致；窗口结束后下一次定时检查会接上
    if (visitStrategyRef().inFriendQuietHours()) return { outcome: 'skipped', reason: 'quiet_hours' };

    const state: any = getUserState();
    const myGid: number = toNum(state && state.gid);
    if (!myGid) return { outcome: 'skipped', reason: 'not_logged_in' };

    syncRunning = true;
    try {
        const cachedFriends: any[] = visitStrategyRef().getFreshFriendsListCacheOnly();
        const friends: any[] = cachedFriends.length > 0
            ? cachedFriends
            : extractReplyFriends(await getAllFriends(false, 'low'));
        const accountId: string = process.env.FARM_ACCOUNT_ID || '';
        const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));
        const invalid: Set<number> = getInvalidKnownFriendGidSet();
        const pending: Array<{ gid: number; name: string }> = collectPendingFriends(friends, myGid, blacklist, invalid);

        if (pending.length === 0) {
            markFullSyncDone();
            return { outcome: 'fresh', reason: 'all_known', checked: 0 };
        }

        log('好友', `开始同步好友宠物，待确认 ${pending.length} 位`, {
            module: 'friend', event: '好友宠物同步', result: 'start', pending: pending.length,
        });

        let checked: number = 0;
        let failed: number = 0;
        let deferred: number = 0;

        for (let index: number = 0; index < pending.length; index += SYNC_BATCH_SIZE) {
            const batch: Array<{ gid: number; name: string }> = pending.slice(index, index + SYNC_BATCH_SIZE);
            let yielded: boolean = false;

            for (const friend of batch) {
                if (!isSyncEnabled().enabled) {
                    deferred = pending.length - checked - failed;
                    yielded = true;
                    break;
                }
                const probed = await submitAccountTask(
                    `friend.pet-sync:${friend.gid}`,
                    () => probeFriendDog(friend.gid, friend.name),
                    { priority: 'maintenance', dedupeKey: `friend.pet-sync:${friend.gid}` },
                );
                if (probed) checked += 1;
                else failed += 1;
                await sleep(SYNC_GAP_MS);
            }

            if (yielded) break;
            if (index + SYNC_BATCH_SIZE < pending.length) await sleep(SYNC_BATCH_GAP_MS);
        }

        // 只有真正跑完才标记当日完成，否则下一次定时检查继续补剩下的
        if (deferred === 0) markFullSyncDone();

        const stats: any = getFriendPetCacheStats();
        log('好友', `好友宠物同步完成：确认 ${checked}，失败 ${failed}，待补 ${deferred}，当日护主犬 ${stats.protect} 位`, {
            module: 'friend',
            event: '好友宠物同步',
            result: deferred > 0 ? 'deferred' : 'ok',
            checked,
            failed,
            deferred,
            known: stats.known,
            protect: stats.protect,
        });

        return {
            outcome: deferred > 0 ? 'deferred' : 'synced',
            checked,
            failed,
            deferred,
            pending: pending.length,
        };
    } catch (e: any) {
        logWarn('好友', `好友宠物同步异常: ${e.message}`, {
            module: 'friend', event: '好友宠物同步', result: 'error',
        });
        return { outcome: 'error', reason: e.message };
    } finally {
        syncRunning = false;
    }
}

export function startFriendPetSyncTimer(): void {
    stopFriendPetSyncTimer();
    petSyncScheduler.setTimeoutTask('friend_pet_sync_startup', SYNC_STARTUP_DELAY_MS, () => {
        runFriendPetSync().catch(() => null);
    });
    petSyncScheduler.setIntervalTask('friend_pet_sync_interval', SYNC_CHECK_INTERVAL_MS, () => {
        return runFriendPetSync().then(() => undefined);
    });
}

export function stopFriendPetSyncTimer(): void {
    petSyncScheduler.clearAll();
}

export function isFriendPetSyncRunning(): boolean {
    return syncRunning;
}

export const FRIEND_PET_SYNC_TUNING = {
    SYNC_BATCH_SIZE,
    SYNC_GAP_MS,
    SYNC_BATCH_GAP_MS,
    SYNC_CHECK_INTERVAL_MS,
    SYNC_STARTUP_DELAY_MS,
};
