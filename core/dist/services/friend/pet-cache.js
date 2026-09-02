"use strict";
/**
 * 好友护主犬缓存 - 记录每位好友当前上场的宠物，避免每轮巡查靠 Enter 试探
 *
 * 数据只有一个来源：VisitService.Enter 回包的 brief_dog_info.dog_id（visitpb.proto field 3）。
 * 因此所有进入好友农场的调用都顺手写入这里（偷菜、帮忙、捣乱、天气扫描、面板手动操作），
 * 真正额外花 RPC 的只有 pet-sync.ts 的每日补齐。
 *
 * 新鲜度按“系统日期”判定：好友随时可以换狗或让狗粮吃完，所以跨日的记录一律视为未知，
 * 由每日同步重新确认。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROTECT_DOG_ID = void 0;
exports.recordFriendDog = recordFriendDog;
exports.recordFriendDogFromEnterReply = recordFriendDogFromEnterReply;
exports.getFriendDogState = getFriendDogState;
exports.isFriendDogKnownToday = isFriendDogKnownToday;
exports.getFriendDogId = getFriendDogId;
exports.forgetFriendDog = forgetFriendDog;
exports.isFullSyncDoneToday = isFullSyncDoneToday;
exports.flushFriendPetCacheNow = flushFriendPetCacheNow;
exports.markFullSyncDone = markFullSyncDone;
exports.getFriendPetCacheStats = getFriendPetCacheStats;
exports.resetFriendPetCacheMemory = resetFriendPetCacheMemory;
const crypto = require('node:crypto');
const { getDataFile } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');
const { toNum, getSystemDateKey, logWarn } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');
exports.PROTECT_DOG_ID = 90021;
const CACHE_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 2000;
const petScheduler = createScheduler('friend-pet-cache');
// gid / dogId 可能以 Long、number 或 JSON 对象键（字符串）的形式进来，toNum 不转字符串，这里统一归一。
function normalizeId(value) {
    const num = Number(toNum(value));
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}
let entries = null;
let lastFullSyncDate = '';
function getCacheFile() {
    const accountId = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`friend-pet-${token}.json`);
}
function loadCache() {
    if (entries)
        return entries;
    const loaded = new Map();
    const today = getSystemDateKey();
    try {
        const state = readJsonFile(getCacheFile(), () => ({}));
        if (Number(state?.version) === CACHE_VERSION) {
            lastFullSyncDate = String(state?.lastFullSyncDate || '');
            const raw = state?.entries;
            if (raw && typeof raw === 'object') {
                for (const [key, value] of Object.entries(raw)) {
                    const gid = normalizeId(key);
                    const date = String(value?.date || '');
                    // 跨日记录没有价值，加载时直接丢掉，避免文件无限增长
                    if (gid <= 0 || date !== today)
                        continue;
                    loaded.set(gid, {
                        dogId: toNum(value?.dogId),
                        date,
                        checkedAt: toNum(value?.checkedAt),
                    });
                }
            }
        }
    }
    catch (e) {
        logWarn('好友', `读取好友宠物缓存失败，按空缓存处理: ${e.message}`);
    }
    if (lastFullSyncDate && lastFullSyncDate !== today)
        lastFullSyncDate = '';
    entries = loaded;
    return entries;
}
function flushCache() {
    const store = loadCache();
    const payload = {};
    for (const [gid, entry] of store)
        payload[String(gid)] = entry;
    try {
        writeJsonFileAtomic(getCacheFile(), {
            version: CACHE_VERSION,
            lastFullSyncDate,
            entries: payload,
        });
    }
    catch (e) {
        logWarn('好友', `保存好友宠物缓存失败: ${e.message}`);
    }
}
function scheduleFlush() {
    petScheduler.setTimeoutTask('friend_pet_cache_flush', FLUSH_DEBOUNCE_MS, () => flushCache());
}
function dropStaleEntries() {
    const store = loadCache();
    const today = getSystemDateKey();
    let changed = false;
    for (const [gid, entry] of store) {
        if (entry.date !== today) {
            store.delete(gid);
            changed = true;
        }
    }
    if (lastFullSyncDate && lastFullSyncDate !== today) {
        lastFullSyncDate = '';
        changed = true;
    }
    if (changed)
        scheduleFlush();
}
/**
 * 记录一位好友当前上场的狗；dogId 为 0 表示没有上场狗，同样是有效结论。
 */
function recordFriendDog(friendGid, dogId) {
    const gid = normalizeId(friendGid);
    if (gid <= 0)
        return;
    dropStaleEntries();
    const store = loadCache();
    const nextDogId = Math.max(0, normalizeId(dogId));
    const today = getSystemDateKey();
    const previous = store.get(gid);
    store.set(gid, { dogId: nextDogId, date: today, checkedAt: Date.now() });
    // 同一天内狗没变就不必反复落盘，只有结论变化或首次确认才写文件
    if (!previous || previous.dogId !== nextDogId)
        scheduleFlush();
}
/**
 * 从 Enter 回包顺手记录，供所有进入好友农场的调用复用（零额外 RPC）。
 */
function recordFriendDogFromEnterReply(friendGid, enterReply) {
    if (!enterReply)
        return;
    const dogInfo = enterReply.brief_dog_info ?? enterReply.briefDogInfo;
    // 没有上场狗时服务端不下发 brief_dog_info，缺省即 dogId 0
    recordFriendDog(friendGid, dogInfo ? (dogInfo.dog_id ?? dogInfo.dogId) : 0);
}
function getFriendDogState(friendGid) {
    const gid = normalizeId(friendGid);
    if (gid <= 0)
        return 'unknown';
    dropStaleEntries();
    const entry = loadCache().get(gid);
    if (!entry)
        return 'unknown';
    return entry.dogId === exports.PROTECT_DOG_ID ? 'protect' : 'other';
}
function isFriendDogKnownToday(friendGid) {
    return getFriendDogState(friendGid) !== 'unknown';
}
function getFriendDogId(friendGid) {
    const gid = normalizeId(friendGid);
    if (gid <= 0)
        return 0;
    dropStaleEntries();
    return toNum(loadCache().get(gid)?.dogId);
}
function forgetFriendDog(friendGid) {
    const gid = normalizeId(friendGid);
    if (gid <= 0)
        return;
    if (loadCache().delete(gid))
        scheduleFlush();
}
function isFullSyncDoneToday() {
    dropStaleEntries();
    return lastFullSyncDate === getSystemDateKey();
}
/**
 * 停机前把防抖里的待写落盘，避免丢掉当天已确认的结论。
 */
function flushFriendPetCacheNow() {
    petScheduler.clear('friend_pet_cache_flush');
    flushCache();
}
function markFullSyncDone() {
    lastFullSyncDate = getSystemDateKey();
    flushCache();
}
function getFriendPetCacheStats() {
    dropStaleEntries();
    const store = loadCache();
    let protect = 0;
    for (const entry of store.values()) {
        if (entry.dogId === exports.PROTECT_DOG_ID)
            protect += 1;
    }
    return {
        date: getSystemDateKey(),
        known: store.size,
        protect,
        fullSyncDone: isFullSyncDoneToday(),
    };
}
/**
 * 仅供停机与测试使用：丢掉内存态，下次访问重新从文件加载。
 */
function resetFriendPetCacheMemory() {
    petScheduler.clearAll();
    entries = null;
    lastFullSyncDate = '';
}
//# sourceMappingURL=pet-cache.js.map