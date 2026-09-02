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

const crypto = require('node:crypto');
const { getDataFile } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');
const { toNum, getSystemDateKey, logWarn } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');

export const PROTECT_DOG_ID: number = 90021;

const CACHE_VERSION: number = 1;
const FLUSH_DEBOUNCE_MS: number = 2000;

// protect: 当前上场的是护主犬；other: 上场了别的狗或没有上场狗；unknown: 今天还没确认过
export type FriendDogState = 'protect' | 'other' | 'unknown';

interface FriendDogEntry {
    dogId: number;
    date: string;
    checkedAt: number;
}

const petScheduler: any = createScheduler('friend-pet-cache');

// gid / dogId 可能以 Long、number 或 JSON 对象键（字符串）的形式进来，toNum 不转字符串，这里统一归一。
function normalizeId(value: any): number {
    const num: number = Number(toNum(value));
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

let entries: Map<number, FriendDogEntry> | null = null;
let lastFullSyncDate: string = '';

function getCacheFile(): string {
    const accountId: string = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token: string = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`friend-pet-${token}.json`);
}

function loadCache(): Map<number, FriendDogEntry> {
    if (entries) return entries;
    const loaded: Map<number, FriendDogEntry> = new Map();
    const today: string = getSystemDateKey();
    try {
        const state: any = readJsonFile(getCacheFile(), () => ({}));
        if (Number(state?.version) === CACHE_VERSION) {
            lastFullSyncDate = String(state?.lastFullSyncDate || '');
            const raw: any = state?.entries;
            if (raw && typeof raw === 'object') {
                for (const [key, value] of Object.entries(raw)) {
                    const gid: number = normalizeId(key);
                    const date: string = String((value as any)?.date || '');
                    // 跨日记录没有价值，加载时直接丢掉，避免文件无限增长
                    if (gid <= 0 || date !== today) continue;
                    loaded.set(gid, {
                        dogId: toNum((value as any)?.dogId),
                        date,
                        checkedAt: toNum((value as any)?.checkedAt),
                    });
                }
            }
        }
    } catch (e: any) {
        logWarn('好友', `读取好友宠物缓存失败，按空缓存处理: ${e.message}`);
    }
    if (lastFullSyncDate && lastFullSyncDate !== today) lastFullSyncDate = '';
    entries = loaded;
    return entries;
}

function flushCache(): void {
    const store: Map<number, FriendDogEntry> = loadCache();
    const payload: Record<string, FriendDogEntry> = {};
    for (const [gid, entry] of store) payload[String(gid)] = entry;
    try {
        writeJsonFileAtomic(getCacheFile(), {
            version: CACHE_VERSION,
            lastFullSyncDate,
            entries: payload,
        });
    } catch (e: any) {
        logWarn('好友', `保存好友宠物缓存失败: ${e.message}`);
    }
}

function scheduleFlush(): void {
    petScheduler.setTimeoutTask('friend_pet_cache_flush', FLUSH_DEBOUNCE_MS, () => flushCache());
}

function dropStaleEntries(): void {
    const store: Map<number, FriendDogEntry> = loadCache();
    const today: string = getSystemDateKey();
    let changed: boolean = false;
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
    if (changed) scheduleFlush();
}

/**
 * 记录一位好友当前上场的狗；dogId 为 0 表示没有上场狗，同样是有效结论。
 */
export function recordFriendDog(friendGid: any, dogId: any): void {
    const gid: number = normalizeId(friendGid);
    if (gid <= 0) return;
    dropStaleEntries();
    const store: Map<number, FriendDogEntry> = loadCache();
    const nextDogId: number = Math.max(0, normalizeId(dogId));
    const today: string = getSystemDateKey();
    const previous: FriendDogEntry | undefined = store.get(gid);
    store.set(gid, { dogId: nextDogId, date: today, checkedAt: Date.now() });
    // 同一天内狗没变就不必反复落盘，只有结论变化或首次确认才写文件
    if (!previous || previous.dogId !== nextDogId) scheduleFlush();
}

/**
 * 从 Enter 回包顺手记录，供所有进入好友农场的调用复用（零额外 RPC）。
 */
export function recordFriendDogFromEnterReply(friendGid: any, enterReply: any): void {
    if (!enterReply) return;
    const dogInfo: any = enterReply.brief_dog_info ?? enterReply.briefDogInfo;
    // 没有上场狗时服务端不下发 brief_dog_info，缺省即 dogId 0
    recordFriendDog(friendGid, dogInfo ? (dogInfo.dog_id ?? dogInfo.dogId) : 0);
}

export function getFriendDogState(friendGid: any): FriendDogState {
    const gid: number = normalizeId(friendGid);
    if (gid <= 0) return 'unknown';
    dropStaleEntries();
    const entry: FriendDogEntry | undefined = loadCache().get(gid);
    if (!entry) return 'unknown';
    return entry.dogId === PROTECT_DOG_ID ? 'protect' : 'other';
}

export function isFriendDogKnownToday(friendGid: any): boolean {
    return getFriendDogState(friendGid) !== 'unknown';
}

export function getFriendDogId(friendGid: any): number {
    const gid: number = normalizeId(friendGid);
    if (gid <= 0) return 0;
    dropStaleEntries();
    return toNum(loadCache().get(gid)?.dogId);
}

export function forgetFriendDog(friendGid: any): void {
    const gid: number = normalizeId(friendGid);
    if (gid <= 0) return;
    if (loadCache().delete(gid)) scheduleFlush();
}

export function isFullSyncDoneToday(): boolean {
    dropStaleEntries();
    return lastFullSyncDate === getSystemDateKey();
}

/**
 * 停机前把防抖里的待写落盘，避免丢掉当天已确认的结论。
 */
export function flushFriendPetCacheNow(): void {
    petScheduler.clear('friend_pet_cache_flush');
    flushCache();
}

export function markFullSyncDone(): void {
    lastFullSyncDate = getSystemDateKey();
    flushCache();
}

export function getFriendPetCacheStats(): { date: string; known: number; protect: number; fullSyncDone: boolean } {
    dropStaleEntries();
    const store: Map<number, FriendDogEntry> = loadCache();
    let protect: number = 0;
    for (const entry of store.values()) {
        if (entry.dogId === PROTECT_DOG_ID) protect += 1;
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
export function resetFriendPetCacheMemory(): void {
    petScheduler.clearAll();
    entries = null;
    lastFullSyncDate = '';
}
