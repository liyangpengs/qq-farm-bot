/**
 * 已知好友 GID 管理 + QQ 好友列表获取
 */

const { parentPort } = require('node:worker_threads');
const { sendMsgAsync, getGatewayLoad, GatewayError, GatewayBusyError } = require('../../utils/network');
const { isGatewayHealthyForBusiness, isGatewayYieldError } = require('../../utils/low-priority-gate');
const { types } = require('../../utils/proto');
const { toNum, toLong, log, logWarn, randomDelay } = require('../../utils/utils');
const {
    getKnownFriendGids,
    getKnownFriendGidSyncCooldownSec,
    getFriendBlacklist,
    applyConfigSnapshot,
} = require('../../models/store');
const { getInteractRecords } = require('../interact');

function shouldStopFriendRead(error: any): boolean {
    return isGatewayYieldError(error) || String(error.message).includes('stage=pending')
        || !isGatewayHealthyForBusiness(getGatewayLoad());
}

// ============ 内部常量与状态 ============
export const QQ_FRIEND_LIST_BATCH_SIZE: number = 35;
const DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS: number = 10 * 60 * 1000;
const MIN_QQ_VISITOR_GID_SYNC_RETRY_MS: number = 30 * 1000;
const MAX_QQ_VISITOR_GID_SYNC_RETRY_MS: number = 2 * 60 * 1000;
const INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS: number = 24 * 60 * 60 * 1000;

let lastVisitorGidSyncAt: number = 0;
const invalidKnownFriendGidCooldownUntil: Map<number, number> = new Map();

// ============ 内部工具函数 ============

export function postToMaster(payload: any): boolean {
    try {
        if (process.send) {
            process.send(payload);
            return true;
        }
        if (parentPort && typeof parentPort.postMessage === 'function') {
            parentPort.postMessage(payload);
            return true;
        }
    } catch {}
    return false;
}

export function pruneInvalidKnownFriendGidCooldown(nowMs: number = Date.now()): void {
    for (const [gid, until] of invalidKnownFriendGidCooldownUntil.entries()) {
        if (!gid || until <= nowMs) invalidKnownFriendGidCooldownUntil.delete(gid);
    }
}

export function clearInvalidKnownFriendGidMarks(gids: any[]): void {
    for (const gid of normalizeFriendGids(gids)) {
        invalidKnownFriendGidCooldownUntil.delete(gid);
    }
}

export function markKnownFriendGidInvalid(friendGid: any, nowMs: number = Date.now()): void {
    const gid: number = toNum(friendGid);
    if (!gid) return;
    invalidKnownFriendGidCooldownUntil.set(gid, nowMs + INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS);
}

export function getInvalidKnownFriendGidSet(nowMs: number = Date.now()): Set<number> {
    pruneInvalidKnownFriendGidCooldown(nowMs);
    return new Set(invalidKnownFriendGidCooldownUntil.keys());
}

export function clearAllInvalidKnownFriendGidCooldowns(): void {
    invalidKnownFriendGidCooldownUntil.clear();
}

function getKnownFriendGidSyncIntervalMs(): number {
    const sec: number = Number(getKnownFriendGidSyncCooldownSec ? getKnownFriendGidSyncCooldownSec() : 0);
    if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS;
    return Math.max(30 * 1000, sec * 1000);
}

function getKnownFriendGidSyncRetryMs(): number {
    const intervalMs: number = getKnownFriendGidSyncIntervalMs();
    return Math.max(MIN_QQ_VISITOR_GID_SYNC_RETRY_MS, Math.min(intervalMs, MAX_QQ_VISITOR_GID_SYNC_RETRY_MS));
}

export function normalizeFriendGids(values: any[]): number[] {
    const normalized: number[] = [];
    for (const item of (Array.isArray(values) ? values : [])) {
        const value: number = toNum(item);
        if (value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

export function extractReplyFriends(reply: any): any[] {
    if (Array.isArray(reply && reply.game_friends)) return reply.game_friends;
    if (Array.isArray(reply && reply.gameFriends)) return reply.gameFriends;
    return [];
}

export function dedupeFriendsByGid(friends: any[]): any[] {
    const result: any[] = [];
    const seen: Set<number> = new Set();
    for (const friend of (Array.isArray(friends) ? friends : [])) {
        const gid: number = toNum(friend && friend.gid);
        if (gid <= 0 || seen.has(gid)) continue;
        seen.add(gid);
        result.push(friend);
    }
    return result;
}

export function buildFriendReply(friends: any[]): any {
    const list: any[] = dedupeFriendsByGid(friends);
    return {
        game_friends: list,
        gameFriends: list,
    };
}

// ============ 公开函数 ============

export function syncKnownFriendGidsFromFriends(friends: any[]): number[] {
    const fetchedGids: number[] = normalizeFriendGids((Array.isArray(friends) ? friends : []).map(friend => friend && friend.gid));
    if (fetchedGids.length === 0) return [];

    clearInvalidKnownFriendGidMarks(fetchedGids);

    const current: number[] = normalizeFriendGids(getKnownFriendGids());
    const merged: number[] = normalizeFriendGids([...current, ...fetchedGids]);
    if (merged.length === current.length && merged.every((gid: number, index: number) => gid === current[index])) {
        return merged;
    }

    applyConfigSnapshot({ knownFriendGids: merged }, { persist: false });
    const sent: boolean = postToMaster({
        type: 'known_friend_gids_sync',
        gids: merged,
    });
    if (!sent) {
        applyConfigSnapshot({ knownFriendGids: merged }, { persist: true });
    }
    return merged;
}

export function getEffectiveKnownQqFriendGids(): number[] {
    const currentKnownGids: number[] = normalizeFriendGids(getKnownFriendGids());
    clearInvalidKnownFriendGidMarks(currentKnownGids);
    const accountId: string = process.env.FARM_ACCOUNT_ID || '';

    const invalidGidSet: Set<number> = getInvalidKnownFriendGidSet();
    const blacklistSet: Set<number> = new Set(getFriendBlacklist(accountId));
    return normalizeFriendGids(currentKnownGids).filter((gid: number) => !invalidGidSet.has(gid) && !blacklistSet.has(gid));
}

export async function syncKnownFriendGidsFromRecentVisitors(force: boolean = false, priority: 'low' | 'normal' = 'normal'): Promise<number[]> {
    const now: number = Date.now();
    const interval: number = lastVisitorGidSyncAt > 0 ? getKnownFriendGidSyncIntervalMs() : 0;
    if (!force && interval > 0 && now - lastVisitorGidSyncAt < interval) {
        return getEffectiveKnownQqFriendGids();
    }

    const accountId: string = process.env.FARM_ACCOUNT_ID || '';

    try {
        const records: any[] = await getInteractRecords(priority);
        const invalidGidSet: Set<number> = getInvalidKnownFriendGidSet(now);
        const visitorGids: number[] = normalizeFriendGids(
            (Array.isArray(records) ? records : []).map(record => record && record.visitorGid),
        ).filter((gid: number) => !invalidGidSet.has(gid));
        lastVisitorGidSyncAt = now;

        if (visitorGids.length === 0) {
            return getEffectiveKnownQqFriendGids();
        }

        const merged: number[] = normalizeFriendGids([
            ...getKnownFriendGids(),
            ...visitorGids,
        ]);
        const current: number[] = normalizeFriendGids(getKnownFriendGids());
        const addedCount: number = merged.filter((gid: number) => !current.includes(gid)).length;
        if (addedCount > 0) {
            applyConfigSnapshot({ knownFriendGids: merged }, { persist: false, accountId });
            const sent: boolean = postToMaster({
                type: 'known_friend_gids_sync',
                gids: merged,
            });
            if (!sent) {
                applyConfigSnapshot({ knownFriendGids: merged }, { persist: true, accountId });
            }
            log('好友', `已从最近访客自动补充 ${addedCount} 个 GID，当前已知好友 GID 共 ${merged.length} 个`, {
                module: 'friend',
                event: '访客补充好友GID',
                result: 'ok',
                addedFromVisitors: addedCount,
                totalKnownGids: merged.length,
            });
        }
        return normalizeFriendGids([
            ...merged,
            ...getFriendBlacklist(accountId),
        ]);
    } catch (e: any) {
        if (shouldStopFriendRead(e)) throw e;
        const retryMs: number = getKnownFriendGidSyncRetryMs();
        const intervalMs: number = getKnownFriendGidSyncIntervalMs();
        if (now - lastVisitorGidSyncAt >= retryMs) {
            lastVisitorGidSyncAt = now - (intervalMs - retryMs);
        }
        logWarn('好友', `同步最近访客 GID 失败: ${e.message}`, {
            module: 'friend',
            event: '同步好友GID',
            result: 'error',
        });
        return getEffectiveKnownQqFriendGids();
    }
}

export function removeKnownFriendGid(friendGid: any, friendName?: string, reason: string = ''): boolean {
    const gid: number = toNum(friendGid);
    if (!gid) return false;

    const current: number[] = normalizeFriendGids(getKnownFriendGids());
    const next: number[] = current.filter((item: number) => item !== gid);
    markKnownFriendGidInvalid(gid);
    if (next.length !== current.length) {
        applyConfigSnapshot({ knownFriendGids: next }, { persist: false });
    }

    const sent: boolean = postToMaster({
        type: 'known_friend_gid_remove',
        gid,
        friendName: friendName || `GID:${gid}`,
        reason: String(reason || ''),
    });
    if (!sent && next.length !== current.length) {
        applyConfigSnapshot({ knownFriendGids: next }, { persist: true });
    }

    logWarn('好友', `检测到失效好友 GID，已自动移除: ${friendName || `GID:${gid}`}`, {
        module: 'friend',
        event: '检测失效好友GID',
        result: 'auto_removed',
        friendName: friendName || `GID:${gid}`,
        friendGid: gid,
        reason: String(reason || ''),
    });
    return true;
}

export async function fetchFriendsByGids(gids: number[], sceneId: 1 | 2, priority: 'low' | 'normal' = 'normal'): Promise<any[]> {
    if (!isGatewayHealthyForBusiness(getGatewayLoad())) {
        throw new GatewayBusyError('好友列表读取已让路，等待连接恢复');
    }
    const body = types.GetGameFriendsRequest.encode(types.GetGameFriendsRequest.create({
        gids: gids.map((gid: number) => toLong(gid)),
        global_scene_id: sceneId,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetGameFriends', body, { priority });
    return extractReplyFriends(types.GetAllFriendsReply.decode(replyBody));
}

export async function fetchAllFriendsForScene(sceneId: 1 | 2, priority: 'low' | 'normal' = 'normal'): Promise<any> {
    const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({ global_scene_id: sceneId })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body, { priority });
    return types.GetAllFriendsReply.decode(replyBody);
}

export async function fetchQqFriendsByKnownGids(priority: 'low' | 'normal' = 'normal'): Promise<any[]> {
    if (!types.GetGameFriendsRequest || !types.GetAllFriendsReply) {
        throw new Error('GetGameFriends 接口类型未加载');
    }

    const knownGids: number[] = getEffectiveKnownQqFriendGids();
    if (knownGids.length === 0) {
        return [];
    }

    const allFriends: any[] = [];
    for (let i: number = 0; i < knownGids.length; i += QQ_FRIEND_LIST_BATCH_SIZE) {
        const batch: number[] = knownGids.slice(i, i + QQ_FRIEND_LIST_BATCH_SIZE);
        try {
            allFriends.push(...await fetchFriendsByGids(batch, 1, priority));
        } catch (e: any) {
            // 连接异常影响整份名单，不继续把剩余几百位好友逐批排到故障连接上。
            if (shouldStopFriendRead(e)) throw e;
            logWarn('好友', `QQ 新好友接口分批请求失败(${i + 1}-${i + batch.length}/${knownGids.length}): ${e.message}`, {
                module: 'friend',
                event: '好友列表接口',
                result: 'error',
                method: 'GetGameFriends',
                batchSize: batch.length,
            });
        }
        if (i + QQ_FRIEND_LIST_BATCH_SIZE < knownGids.length) {
            await randomDelay(500, 1000);
        }
    }

    return dedupeFriendsByGid(allFriends);
}

export async function fetchQqFriendsByLegacyMethod(priority: 'low' | 'normal' = 'normal'): Promise<any[]> {
    const errors: string[] = [];
    let lastGatewayError: any = null;

    try {
        const syncReq: any = types.SyncAllRequest || types.SyncAllFriendsRequest;
        const syncRep: any = types.SyncAllReply || types.SyncAllFriendsReply;
        if (!syncReq || !syncRep) throw new Error('SyncAll 接口类型未加载');
        const body: Uint8Array = syncReq.encode(syncReq.create({ open_ids: [], global_scene_id: 1 })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'SyncAll', body, { priority });
        return extractReplyFriends(syncRep.decode(replyBody));
    } catch (e: any) {
        if (shouldStopFriendRead(e)) throw e;
        if (e instanceof GatewayError || e?.name === 'GatewayError' || typeof e?.errorMessage === 'string') lastGatewayError = e;
        errors.push(`SyncAll: ${e.message}`);
    }

    try {
        if (!types.GetAllFriendsRequest || !types.GetAllFriendsReply) throw new Error('GetAll 接口类型未加载');
        return extractReplyFriends(await fetchAllFriendsForScene(1, priority));
    } catch (e: any) {
        if (e instanceof GatewayError || e?.name === 'GatewayError' || typeof e?.errorMessage === 'string') lastGatewayError = e;
        errors.push(`GetAll: ${e.message}`);
    }

    if (lastGatewayError) throw lastGatewayError;
    throw new Error(errors.join(' | '));
}

