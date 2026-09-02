"use strict";
/**
 * 已知好友 GID 管理 + QQ 好友列表获取
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.postToMaster = postToMaster;
exports.pruneInvalidKnownFriendGidCooldown = pruneInvalidKnownFriendGidCooldown;
exports.clearInvalidKnownFriendGidMarks = clearInvalidKnownFriendGidMarks;
exports.markKnownFriendGidInvalid = markKnownFriendGidInvalid;
exports.getInvalidKnownFriendGidSet = getInvalidKnownFriendGidSet;
exports.clearAllInvalidKnownFriendGidCooldowns = clearAllInvalidKnownFriendGidCooldowns;
exports.normalizeFriendGids = normalizeFriendGids;
exports.extractReplyFriends = extractReplyFriends;
exports.dedupeFriendsByGid = dedupeFriendsByGid;
exports.buildFriendReply = buildFriendReply;
exports.syncKnownFriendGidsFromFriends = syncKnownFriendGidsFromFriends;
exports.getEffectiveKnownQqFriendGids = getEffectiveKnownQqFriendGids;
exports.syncKnownFriendGidsFromRecentVisitors = syncKnownFriendGidsFromRecentVisitors;
exports.removeKnownFriendGid = removeKnownFriendGid;
exports.fetchQqFriendsByKnownGids = fetchQqFriendsByKnownGids;
exports.fetchQqFriendsByLegacyMethod = fetchQqFriendsByLegacyMethod;
const { parentPort } = require('node:worker_threads');
const { sendMsgAsync } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { toNum, toLong, log, logWarn, randomDelay } = require('../../utils/utils');
const { getKnownFriendGids, getKnownFriendGidSyncCooldownSec, getFriendBlacklist, applyConfigSnapshot, } = require('../../models/store');
const { getInteractRecords } = require('../interact');
// ============ 内部常量与状态 ============
const QQ_FRIEND_LIST_BATCH_SIZE = 35;
const DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const MIN_QQ_VISITOR_GID_SYNC_RETRY_MS = 30 * 1000;
const MAX_QQ_VISITOR_GID_SYNC_RETRY_MS = 2 * 60 * 1000;
const INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let lastVisitorGidSyncAt = 0;
const invalidKnownFriendGidCooldownUntil = new Map();
// ============ 内部工具函数 ============
function postToMaster(payload) {
    try {
        if (process.send) {
            process.send(payload);
            return true;
        }
        if (parentPort && typeof parentPort.postMessage === 'function') {
            parentPort.postMessage(payload);
            return true;
        }
    }
    catch { }
    return false;
}
function pruneInvalidKnownFriendGidCooldown(nowMs = Date.now()) {
    for (const [gid, until] of invalidKnownFriendGidCooldownUntil.entries()) {
        if (!gid || until <= nowMs)
            invalidKnownFriendGidCooldownUntil.delete(gid);
    }
}
function clearInvalidKnownFriendGidMarks(gids) {
    for (const gid of normalizeFriendGids(gids)) {
        invalidKnownFriendGidCooldownUntil.delete(gid);
    }
}
function markKnownFriendGidInvalid(friendGid, nowMs = Date.now()) {
    const gid = toNum(friendGid);
    if (!gid)
        return;
    invalidKnownFriendGidCooldownUntil.set(gid, nowMs + INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS);
}
function getInvalidKnownFriendGidSet(nowMs = Date.now()) {
    pruneInvalidKnownFriendGidCooldown(nowMs);
    return new Set(invalidKnownFriendGidCooldownUntil.keys());
}
function clearAllInvalidKnownFriendGidCooldowns() {
    invalidKnownFriendGidCooldownUntil.clear();
}
function getKnownFriendGidSyncIntervalMs() {
    const sec = Number(getKnownFriendGidSyncCooldownSec ? getKnownFriendGidSyncCooldownSec() : 0);
    if (!Number.isFinite(sec) || sec <= 0)
        return DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS;
    return Math.max(30 * 1000, sec * 1000);
}
function getKnownFriendGidSyncRetryMs() {
    const intervalMs = getKnownFriendGidSyncIntervalMs();
    return Math.max(MIN_QQ_VISITOR_GID_SYNC_RETRY_MS, Math.min(intervalMs, MAX_QQ_VISITOR_GID_SYNC_RETRY_MS));
}
function normalizeFriendGids(values) {
    const normalized = [];
    for (const item of (Array.isArray(values) ? values : [])) {
        const value = toNum(item);
        if (value <= 0)
            continue;
        if (normalized.includes(value))
            continue;
        normalized.push(value);
    }
    return normalized;
}
function extractReplyFriends(reply) {
    if (Array.isArray(reply && reply.game_friends))
        return reply.game_friends;
    if (Array.isArray(reply && reply.gameFriends))
        return reply.gameFriends;
    return [];
}
function dedupeFriendsByGid(friends) {
    const result = [];
    const seen = new Set();
    for (const friend of (Array.isArray(friends) ? friends : [])) {
        const gid = toNum(friend && friend.gid);
        if (gid <= 0 || seen.has(gid))
            continue;
        seen.add(gid);
        result.push(friend);
    }
    return result;
}
function buildFriendReply(friends) {
    const list = dedupeFriendsByGid(friends);
    return {
        game_friends: list,
        gameFriends: list,
    };
}
// ============ 公开函数 ============
function syncKnownFriendGidsFromFriends(friends) {
    const fetchedGids = normalizeFriendGids((Array.isArray(friends) ? friends : []).map(friend => friend && friend.gid));
    if (fetchedGids.length === 0)
        return [];
    clearInvalidKnownFriendGidMarks(fetchedGids);
    const current = normalizeFriendGids(getKnownFriendGids());
    const merged = normalizeFriendGids([...current, ...fetchedGids]);
    if (merged.length === current.length && merged.every((gid, index) => gid === current[index])) {
        return merged;
    }
    applyConfigSnapshot({ knownFriendGids: merged }, { persist: false });
    const sent = postToMaster({
        type: 'known_friend_gids_sync',
        gids: merged,
    });
    if (!sent) {
        applyConfigSnapshot({ knownFriendGids: merged }, { persist: true });
    }
    return merged;
}
function getEffectiveKnownQqFriendGids() {
    const currentKnownGids = normalizeFriendGids(getKnownFriendGids());
    clearInvalidKnownFriendGidMarks(currentKnownGids);
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    const invalidGidSet = getInvalidKnownFriendGidSet();
    const blacklistSet = new Set(getFriendBlacklist(accountId));
    return normalizeFriendGids(currentKnownGids).filter((gid) => !invalidGidSet.has(gid) && !blacklistSet.has(gid));
}
async function syncKnownFriendGidsFromRecentVisitors(force = false, priority = 'normal') {
    const now = Date.now();
    const interval = lastVisitorGidSyncAt > 0 ? getKnownFriendGidSyncIntervalMs() : 0;
    if (!force && interval > 0 && now - lastVisitorGidSyncAt < interval) {
        return getEffectiveKnownQqFriendGids();
    }
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    try {
        const records = await getInteractRecords(priority);
        const invalidGidSet = getInvalidKnownFriendGidSet(now);
        const visitorGids = normalizeFriendGids((Array.isArray(records) ? records : []).map(record => record && record.visitorGid)).filter((gid) => !invalidGidSet.has(gid));
        lastVisitorGidSyncAt = now;
        if (visitorGids.length === 0) {
            return getEffectiveKnownQqFriendGids();
        }
        const merged = normalizeFriendGids([
            ...getKnownFriendGids(),
            ...visitorGids,
        ]);
        const current = normalizeFriendGids(getKnownFriendGids());
        const addedCount = merged.filter((gid) => !current.includes(gid)).length;
        if (addedCount > 0) {
            applyConfigSnapshot({ knownFriendGids: merged }, { persist: false, accountId });
            const sent = postToMaster({
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
    }
    catch (e) {
        const retryMs = getKnownFriendGidSyncRetryMs();
        const intervalMs = getKnownFriendGidSyncIntervalMs();
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
function removeKnownFriendGid(friendGid, friendName, reason = '') {
    const gid = toNum(friendGid);
    if (!gid)
        return false;
    const current = normalizeFriendGids(getKnownFriendGids());
    const next = current.filter((item) => item !== gid);
    markKnownFriendGidInvalid(gid);
    if (next.length !== current.length) {
        applyConfigSnapshot({ knownFriendGids: next }, { persist: false });
    }
    const sent = postToMaster({
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
async function fetchQqFriendsByKnownGids(priority = 'normal') {
    if (!types.GetGameFriendsRequest || !types.GetAllFriendsReply) {
        throw new Error('GetGameFriends 接口类型未加载');
    }
    const knownGids = getEffectiveKnownQqFriendGids();
    if (knownGids.length === 0) {
        return [];
    }
    const allFriends = [];
    for (let i = 0; i < knownGids.length; i += QQ_FRIEND_LIST_BATCH_SIZE) {
        const batch = knownGids.slice(i, i + QQ_FRIEND_LIST_BATCH_SIZE);
        const body = types.GetGameFriendsRequest.encode(types.GetGameFriendsRequest.create({
            gids: batch.map((gid) => toLong(gid)),
        })).finish();
        try {
            const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetGameFriends', body, { priority });
            const reply = types.GetAllFriendsReply.decode(replyBody);
            allFriends.push(...extractReplyFriends(reply));
        }
        catch (e) {
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
async function fetchQqFriendsByLegacyMethod(priority = 'normal') {
    const errors = [];
    try {
        const syncReq = types.SyncAllRequest || types.SyncAllFriendsRequest;
        const syncRep = types.SyncAllReply || types.SyncAllFriendsReply;
        if (!syncReq || !syncRep)
            throw new Error('SyncAll 接口类型未加载');
        const body = syncReq.encode(syncReq.create({ open_ids: [] })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'SyncAll', body, { priority });
        return extractReplyFriends(syncRep.decode(replyBody));
    }
    catch (e) {
        errors.push(`SyncAll: ${e.message}`);
    }
    try {
        if (!types.GetAllFriendsRequest || !types.GetAllFriendsReply)
            throw new Error('GetAll 接口类型未加载');
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body, { priority });
        return extractReplyFriends(types.GetAllFriendsReply.decode(replyBody));
    }
    catch (e) {
        errors.push(`GetAll: ${e.message}`);
    }
    throw new Error(errors.join(' | '));
}
//# sourceMappingURL=gid-manager.js.map