/**
 * 拜访好友策略 - 访问逻辑、好友分析、错误处理、安静时段
 */

const { PlantPhase } = require('../../config/config');
const { getPlantName, getPlantById } = require('../../config/gameConfig');
const {
    isAutomationOn,
    getFriendQuietHours,
    getFriendBlacklist,
    getPlantBlacklist,
    getFriendsListCacheTtlSec,
} = require('../../models/store');
const { getUserState } = require('../../utils/network');
const { toNum, getServerTimeSec, getSystemClockMinutes, log, logWarn, sleep, randomDelay } = require('../../utils/utils');

const {
    getCurrentPhase,
    buildLandMap,
    buildLandDetail,
    getPlantStatusFlags,
    isOccupiedSlaveLand,
} = require('../farm');
const { getCareerInfoOrNull } = require('../career');
const { recordOperation } = require('../stats');
const { sellAllFruits } = require('../warehouse');
const {
    getAllFriends,
    delFriend,
    enterFriendFarm,
    leaveFriendFarm,
    helpFarming,
    stealHarvest,
    putInsects,
    putWeeds,
    putInsectsDetailed,
    putWeedsDetailed,
} = require('./api');
const {
    extractReplyFriends,
    postToMaster,
    removeKnownFriendGid,
} = require('./gid-manager');
const { PROTECT_DOG_ID, getFriendDogState, getFriendDogId } = require('./pet-cache');
const { getItemById, getItemImageById } = require('../../config/gameConfig');

// 延迟引用 scheduler 模块，避免循环依赖
let _scheduler: any = null;
function schedulerRef(): any {
    if (!_scheduler) _scheduler = require('./scheduler');
    return _scheduler;
}

// ============ 内部状态 ============
let friendsListCache: any[] | null = null;
let friendsListCacheTime: number = 0;

function isProtectDog(dogInfo: any): boolean {
    return toNum(dogInfo && (dogInfo.dog_id ?? dogInfo.dogId)) === PROTECT_DOG_ID;
}

function canBypassHelpExpLimitForProtectDog(enterReply: any): boolean {
    return !!isAutomationOn('friend_help_protect_dog_ignore_exp_limit')
        && isProtectDog(enterReply && (enterReply.brief_dog_info ?? enterReply.briefDogInfo));
}

interface FarmingOutcome {
    effect: 'confirmed' | 'noop' | 'uncertain';
    operationCount: number;
    landCount: number;
    landIds: number[];
    operationLimits: any[];
    dogSkillGiftCount: number;
    code?: number;
}

interface RecentHelpEntry {
    state: 'in_flight' | 'confirmed' | 'noop';
    snapshotKey: string;
    expiresAt: number;
}

const recentHelp = new Map<string, RecentHelpEntry>();
const HELP_IN_FLIGHT_TTL_MS = 15000;
const HELP_RESULT_TTL_MS = 30000;
const HELP_CACHE_MAX = 2048;

function getHelpKey(hostGid: number, landId: number): string {
    return `${hostGid}:${landId}`;
}

function pruneRecentHelp(now: number = Date.now()): void {
    for (const [key, entry] of recentHelp) {
        if (entry.expiresAt <= now) recentHelp.delete(key);
    }
    while (recentHelp.size > HELP_CACHE_MAX) {
        const oldestKey = recentHelp.keys().next().value;
        if (!oldestKey) break;
        recentHelp.delete(oldestKey);
    }
}

function getHelpSnapshotKey(lands: any[]): string {
    return (Array.isArray(lands) ? lands : []).map((land: any) => {
        const plant: any = land && land.plant;
        const phase: any = plant && Array.isArray(plant.phases) ? getCurrentPhase(plant.phases) : null;
        const weeds: string = (plant && Array.isArray(plant.weed_owners) ? plant.weed_owners : []).map(toNum).join(',');
        const insects: string = (plant && Array.isArray(plant.insect_owners) ? plant.insect_owners : []).map(toNum).join(',');
        return [
            toNum(land && land.id),
            toNum(plant && plant.id),
            toNum(phase && phase.phase),
            toNum(plant && plant.dry_num),
            weeds,
            insects,
        ].join(':');
    }).join('|');
}

function filterRecentHelp(hostGid: number, landIds: number[], snapshotKey: string): number[] {
    const now = Date.now();
    pruneRecentHelp(now);
    return [...new Set<number>(landIds.map((id: any) => toNum(id)).filter((id: number) => id > 0))].filter((landId: number) => {
        const key = getHelpKey(hostGid, landId);
        const entry = recentHelp.get(key);
        if (!entry || entry.expiresAt <= now) return true;
        if (entry.snapshotKey !== snapshotKey) {
            recentHelp.delete(key);
            return true;
        }
        return false;
    });
}

function markRecentHelp(hostGid: number, landIds: number[], state: RecentHelpEntry['state'], ttlMs: number, snapshotKey: string): void {
    const expiresAt = Date.now() + ttlMs;
    for (const landId of landIds) recentHelp.set(getHelpKey(hostGid, landId), { state, snapshotKey, expiresAt });
    pruneRecentHelp();
}

function releaseRecentHelp(hostGid: number, landIds: number[]): void {
    for (const landId of landIds) recentHelp.delete(getHelpKey(hostGid, landId));
}

function getFriendsListCacheTtlMs(): number {
    const sec: number = Number(getFriendsListCacheTtlSec ? getFriendsListCacheTtlSec() : 0);
    if (!Number.isFinite(sec) || sec <= 0) return 60 * 1000;
    return Math.max(10 * 1000, sec * 1000);
}

// ============ 错误处理 ============

function isEnterFarmBannedError(error: any): boolean {
    const message: string = String((error && error.message) || error || '');
    if (!message) return false;
    return message.includes('1002003');
}

function parseRpcErrorCode(error: any): number {
    const message: string = String((error && error.message) || error || '');
    const match: RegExpMatchArray | null = message.match(/code=(\d+)/i);
    return match ? (Number.parseInt(match[1], 10) || 0) : 0;
}

function isTransientNetworkError(error: any): boolean {
    const message: string = String((error && error.message) || error || '');
    if (!message) return false;
    return [
        '连接未打开',
        '请求超时',
        '请求已中断',
        '连接关闭',
        '连接已在加密途中关闭',
        'worker exited',
    ].some(keyword => message.includes(keyword));
}

function isInvalidFriendAccessError(error: any): boolean {
    const message: string = String((error && error.message) || error || '');
    if (!message || isEnterFarmBannedError(error) || isTransientNetworkError(error)) {
        return false;
    }

    const lowerMessage: string = message.toLowerCase();
    const hasInvalidKeyword: boolean = [
        '无效',
        '不存在',
        '删除',
        '关系',
        'not found',
        'invalid',
        'not friend',
        'friend',
    ].some(keyword => lowerMessage.includes(keyword.toLowerCase()));

    return hasInvalidKeyword && parseRpcErrorCode(error) > 0;
}

function addFriendToBlacklist(friendGid: any, friendName: string, reason: string = ''): boolean {
    const gid: number = toNum(friendGid);
    if (!gid) return false;
    const accountId: string = process.env.FARM_ACCOUNT_ID || '';
    const currentList: any = getFriendBlacklist(accountId);
    const current: number[] = Array.isArray(currentList) ? currentList : [];
    if (current.includes(gid)) return false;

    const sent: boolean = postToMaster({
        type: 'friend_blacklist_add',
        gid,
        friendName: friendName || `GID:${gid}`,
        reason: String(reason || ''),
    });
    if (!sent) return false;

    logWarn('好友', `检测到封禁好友，已自动加入黑名单: ${friendName || `GID:${gid}`}`, {
        module: 'friend',
        event: '加黑名单',
        result: 'auto_blocked',
        friendName: friendName || `GID:${gid}`,
        friendGid: gid,
        reason: String(reason || ''),
    });
    return true;
}

export function handleFriendEnterError(friendGid: any, friendName: string, error: any): { handled: boolean; kind: string } {
    const gid: number = toNum(friendGid);
    const displayName: string = String(friendName || '').trim() || `GID:${gid}`;
    const reason: string = String((error && error.message) || error || '');
    if (isEnterFarmBannedError(error)) {
        addFriendToBlacklist(gid, displayName, reason);
        return { handled: true, kind: 'blacklist' };
    }
    if (isInvalidFriendAccessError(error)) {
        removeKnownFriendGid(gid, displayName, reason);
        return { handled: true, kind: 'invalid_removed' };
    }
    return { handled: false, kind: 'error' };
}

// ============ 安静时段 ============

export function parseTimeToMinutes(timeStr: string): number | null {
    const m: RegExpMatchArray | null = String(timeStr || '').match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return null;
    const h: number = Number.parseInt(m[1], 10);
    const min: number = Number.parseInt(m[2], 10);
    if (Number.isNaN(h) || Number.isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

export function inFriendQuietHours(now?: Date): boolean {
    const cfg: any = getFriendQuietHours();
    if (!cfg || !cfg.enabled) return false;

    const start: number | null = parseTimeToMinutes(cfg.start);
    const end: number | null = parseTimeToMinutes(cfg.end);
    if (start === null || end === null) return false;

    const cur: number = now instanceof Date
        ? getSystemClockMinutes(now.getTime())
        : getSystemClockMinutes();
    if (start === end) return true; // 起止相同视为全天静默
    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end; // 跨天时段
}

export function inFarmQuietHours(now?: Date): boolean {
    if (!inFriendQuietHours(now)) return false;
    const cfg: any = getFriendQuietHours();
    return cfg.continueFarm === false;
}

// ============ 好友土地分析 ============

interface AnalyzeResult {
    stealable: number[];
    stealableInfo: any[];
    needWater: number[];
    needWeed: number[];
    needBug: number[];
    canPutWeed: number[];
    canPutBug: number[];
}

interface AnalyzeOptions {
    plantBlacklist?: number[] | null;
}

export function analyzeFriendLands(lands: any[], myGid: number, friendName: string = '', options: AnalyzeOptions = {}): AnalyzeResult {
    const { plantBlacklist = null } = options;
    const result: AnalyzeResult = {
        stealable: [],   // 可偷
        stealableInfo: [],  // 可偷植物信息 { landId, plantId, name }
        needWater: [],   // 需要浇水
        needWeed: [],    // 需要除草
        needBug: [],     // 需要除虫
        canPutWeed: [],  // 可以放草
        canPutBug: [],   // 可以放虫
    };
    const landsMap: any = buildLandMap(lands);

    for (const land of lands) {
        const id: number = toNum(land.id);
        if (isOccupiedSlaveLand(land, landsMap)) {
            continue;
        }
        const plant: any = land.plant;

        if (!plant || !plant.phases || plant.phases.length === 0) {
            continue;
        }

        const currentPhase: any = getCurrentPhase(plant.phases, false, `[${friendName}]土地#${id}`);
        if (!currentPhase) {
            continue;
        }
        const phaseVal: number = currentPhase.phase;

        if (phaseVal === PlantPhase.MATURE) {
            if (plant.stealable) {
                const plantId: number = toNum(plant.id);
                const plantName: string = getPlantName(plantId) || plant.name || '未知';

                // 获取种子ID用于黑名单检查（前端黑名单使用seedId）
                const plantCfg: any = getPlantById(plantId);
                const seedId: number = plantCfg ? toNum(plantCfg.seed_id) : 0;

                // 蔬菜黑名单过滤 - 使用seedId检查
                if (plantBlacklist && seedId > 0 && plantBlacklist.includes(seedId)) {
                    // log('好友', `${friendName} 土地#${id}: ${plantName}(${plantId},种子${seedId}) 被蔬菜黑名单过滤跳过`,
                    //     {
                    //     module: 'friend', event: '蔬菜黑名单跳过', friendName, landId: id, plantId, seedId, plantName
                    // });
                    continue;
                }
                result.stealable.push(id);
                result.stealableInfo.push({ landId: id, plantId, name: plantName });
            }
            continue;
        }

        if (phaseVal === PlantPhase.DEAD) continue;

        // 帮助操作
        const statusFlags = getPlantStatusFlags(plant, currentPhase);
        if (statusFlags.needWater) result.needWater.push(id);
        if (statusFlags.needWeed) result.needWeed.push(id);
        if (statusFlags.needBug) result.needBug.push(id);

        // 捣乱操作: 检查是否可以放草/放虫
        // 条件: 植物未成熟 + 没有草/虫且我没放过 + 每块地最多2个草/虫
        if (phaseVal !== PlantPhase.MATURE) {
            const weedOwners: number[] = plant.weed_owners || [];
            const insectOwners: number[] = plant.insect_owners || [];
            const iAlreadyPutWeed: boolean = weedOwners.some((gid: number) => toNum(gid) === myGid);
            const iAlreadyPutBug: boolean = insectOwners.some((gid: number) => toNum(gid) === myGid);

            // 每块地最多2个草/虫，且我没放过
            if (weedOwners.length < 2 && !iAlreadyPutWeed) {
                result.canPutWeed.push(id);
            }
            if (insectOwners.length < 2 && !iAlreadyPutBug) {
                result.canPutBug.push(id);
            }
        }
    }
    return result;
}

// ============ 好友列表与土地详情 ============

export type FriendPetState = 'protect' | 'other' | 'none' | 'unknown';

/**
 * 好友上场宠物的展示信息，数据全部来自按天缓存（进好友农场时顺手写入 + 每日同步补齐），
 * 为了展示不会额外发任何 RPC；当天还没确认过的好友是 unknown，交由每日同步补齐。
 */
export function buildFriendPetView(friendGid: any): { petState: FriendPetState; pet: any } {
    if (getFriendDogState(friendGid) === 'unknown') return { petState: 'unknown', pet: null };
    const dogId: number = getFriendDogId(friendGid);
    // 当天确认过但没有上场狗，同样是有效结论
    if (dogId <= 0) return { petState: 'none', pet: null };
    const metadata: any = getItemById(dogId);
    return {
        petState: dogId === PROTECT_DOG_ID ? 'protect' : 'other',
        pet: {
            id: String(dogId),
            name: String(metadata?.name || `宠物 ${dogId}`),
            image: getItemImageById(dogId) || '',
        },
    };
}

// 宠物结论随时会被 Enter 回包刷新，所以不写进好友列表缓存，只在返回前附加
function withFriendPetView(list: any[]): any[] {
    return (Array.isArray(list) ? list : []).map((friend: any) => ({ ...friend, ...buildFriendPetView(friend.gid) }));
}

/**
 * 获取好友列表 (供面板)
 */
export function cacheFriendsListFromReply(reply: any): any[] {
    const state: any = getUserState();
    const result: any[] = extractReplyFriends(reply)
        .filter((f: any) => toNum(f.gid) !== state.gid && f.name !== '小小农夫' && f.remark !== '小小农夫')
        .map((f: any) => ({
            gid: toNum(f.gid),
            name: f.remark || f.name || `GID:${toNum(f.gid)}`,
            avatarUrl: String(f.avatar_url || '').trim(),
            level: toNum(f.level),
            gold: toNum(f.gold),
            plant: f.plant ? {
                stealNum: toNum(f.plant.steal_plant_num),
                dryNum: toNum(f.plant.dry_num),
                weedNum: toNum(f.plant.weed_num),
                insectNum: toNum(f.plant.insect_num),
            } : null,
            weather: f.weather ? {
                type: toNum(f.weather.weather_type),
                status: toNum(f.weather.status),
                beginTime: toNum(f.weather.begin_time),
                endTime: toNum(f.weather.end_time),
                source: toNum(f.weather.source),
                field8: toNum(f.weather.field_8),
                friendMarker: toNum(f.weather.field_9),
            } : null,
        }))
        .sort((a: any, b: any) => {
            // 固定顺序：先按名称，再按 GID，避免刷新时顺序抖动
            const an: string = String(a.name || '');
            const bn: string = String(b.name || '');
            const byName: number = an.localeCompare(bn, 'zh-CN');
            if (byName !== 0) return byName;
            return Number(a.gid || 0) - Number(b.gid || 0);
        });

    friendsListCache = result;
    friendsListCacheTime = Date.now();
    return result;
}

export async function getFriendsList(forceSync: boolean = false, priority: 'low' | 'normal' = 'normal'): Promise<any[]> {
    try {
        // 检查缓存
        const now: number = Date.now();
        if (!forceSync && friendsListCache && (now - friendsListCacheTime) < getFriendsListCacheTtlMs()) {
            return withFriendPetView(friendsListCache);
        }

        log('好友', '开始获取好友列表', {
            module: 'friend',
            event: '获取好友列表',
        });
        const reply: any = await getAllFriends(forceSync, priority);
        const result: any[] = cacheFriendsListFromReply(reply);

        log('好友', `获取好友列表成功，共 ${result.length} 位好友`, {
            module: 'friend',
            event: '获取好友列表',
            result: 'ok',
            count: result.length,
        });
        return withFriendPetView(result);
    } catch (e: any) {
        log('好友', `获取好友列表失败: ${e.message}`, {
            module: 'friend',
            event: '获取好友列表',
            result: 'error',
            error: e.message,
        });
        return [];
    }
}

export function getFriendsListCacheOnly(): any[] {
    if (!Array.isArray(friendsListCache)) return [];
    return withFriendPetView(friendsListCache);
}

/**
 * 获取指定好友的农田详情 (进入-获取-离开)
 */
export async function getFriendLandsDetail(friendGid: number): Promise<any> {
    let entered = false;
    try {
        const enterReply: any = await enterFriendFarm(friendGid);
        entered = true;
        const lands: any[] = enterReply.lands || [];
        const state: any = getUserState();
        const plantBlacklist: number[] = getPlantBlacklist(state.accountId);
        const analyzed: AnalyzeResult = analyzeFriendLands(lands, state.gid, '', { plantBlacklist });

        const nowSec: number = getServerTimeSec();
        const landsMap: any = buildLandMap(lands);
        const landsList: any[] = lands.map((land: any) => buildLandDetail(land, {
            friendMode: true,
            landsMap,
            nowSec,
        }));

        return {
            lands: landsList,
            summary: analyzed,
            career: await getCareerInfoOrNull(friendGid),
        };
    } finally {
        if (entered) await leaveFriendFarm(friendGid);
    }
}

// ============ 批量操作与面板操作 ============

export async function runBatchWithFallback(ids: number[], batchFn: (ids: number[]) => Promise<any>, singleFn: (ids: number[]) => Promise<any>): Promise<number> {
    const target: number[] = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (target.length === 0) return 0;
    try {
        await batchFn(target);
        return target.length;
    } catch {
        let ok: number = 0;
        for (const landId of target) {
            try {
                await singleFn([landId]);
                ok++;
            } catch { /* ignore */ }
            await sleep(100);
        }
        return ok;
    }
}

function emptyFarmingOutcome(effect: FarmingOutcome['effect'] = 'noop'): FarmingOutcome {
    return { effect, operationCount: 0, landCount: 0, landIds: [], operationLimits: [], dogSkillGiftCount: 0 };
}

function mergeFarmingOutcomes(outcomes: FarmingOutcome[]): FarmingOutcome {
    const confirmed = outcomes.filter((outcome: FarmingOutcome) => outcome.effect === 'confirmed');
    const landIds = [...new Set(confirmed.flatMap((outcome: FarmingOutcome) => outcome.landIds || []))];
    const operationLimits = confirmed.flatMap((outcome: FarmingOutcome) => outcome.operationLimits || []);
    return {
        effect: confirmed.length > 0 ? 'confirmed' : (outcomes.some((outcome: FarmingOutcome) => outcome.effect === 'uncertain') ? 'uncertain' : 'noop'),
        operationCount: confirmed.reduce((sum: number, outcome: FarmingOutcome) => sum + (Number(outcome.operationCount) || 0), 0),
        landCount: landIds.length,
        landIds,
        operationLimits,
        dogSkillGiftCount: outcomes.reduce((sum: number, outcome: FarmingOutcome) => sum + (Number(outcome.dogSkillGiftCount) || 0), 0),
    };
}

async function runFarmingWithFallback(hostGid: number, ids: number[], stopWhenExpLimit: boolean = false, snapshotKey: string = ''): Promise<FarmingOutcome> {
    const target: number[] = filterRecentHelp(hostGid, Array.isArray(ids) ? ids : [], snapshotKey);
    if (target.length === 0) return emptyFarmingOutcome();
    markRecentHelp(hostGid, target, 'in_flight', HELP_IN_FLIGHT_TTL_MS, snapshotKey);
    try {
        const batch: FarmingOutcome = await helpFarming(hostGid, target, stopWhenExpLimit);
        if (batch.effect === 'noop') {
            markRecentHelp(hostGid, target, 'noop', HELP_RESULT_TTL_MS, snapshotKey);
            return batch;
        }
        if (batch.effect === 'confirmed') {
            markRecentHelp(hostGid, batch.landIds, 'confirmed', HELP_RESULT_TTL_MS, snapshotKey);
        }
        const unconfirmed = target.filter((landId: number) => !batch.landIds.includes(landId));
        releaseRecentHelp(hostGid, unconfirmed);
        return batch;
    } catch {
        releaseRecentHelp(hostGid, target);
        const outcomes: FarmingOutcome[] = [];
        for (const landId of target) {
            markRecentHelp(hostGid, [landId], 'in_flight', HELP_IN_FLIGHT_TTL_MS, snapshotKey);
            try {
                const outcome: FarmingOutcome = await helpFarming(hostGid, [landId], stopWhenExpLimit);
                outcomes.push(outcome);
                if (outcome.effect === 'noop') markRecentHelp(hostGid, [landId], 'noop', HELP_RESULT_TTL_MS, snapshotKey);
                else if (outcome.effect === 'confirmed') markRecentHelp(hostGid, outcome.landIds, 'confirmed', HELP_RESULT_TTL_MS, snapshotKey);
                else releaseRecentHelp(hostGid, [landId]);
            } catch {
                releaseRecentHelp(hostGid, [landId]);
            }
            await sleep(100);
        }
        return mergeFarmingOutcomes(outcomes);
    }
}

/**
 * 面板手动好友操作（单个好友）
 * opType: 'steal' | 'water' | 'weed' | 'bug' | 'bad'
 */
export async function doFriendOperation(friendGid: any, opType: string): Promise<any> {
    const gid: number = toNum(friendGid);
    if (!gid) return { ok: false, message: '无效好友ID', opType };
    if (opType === 'bad' && schedulerRef().isBadOperationLimitReached()) {
        return {
            ok: true,
            opType,
            count: 0,
            bugCount: 0,
            weedCount: 0,
            message: '今日放虫/放草次数已达上限',
        };
    }

    let enterReply: any;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e: any) {
        const handled: { handled: boolean; kind: string } = handleFriendEnterError(gid, `GID:${gid}`, e);
        if (handled.handled && handled.kind === 'blacklist') {
            return { ok: true, opType, count: 0, message: '好友已自动加入黑名单' };
        }
        if (handled.handled && handled.kind === 'invalid_removed') {
            return { ok: true, opType, count: 0, message: '好友 GID 已失效，已自动移出已知列表' };
        }
        return { ok: false, message: `进入好友农场失败: ${e.message}`, opType };
    }

    try {
        const lands: any[] = enterReply.lands || [];
        const state: any = getUserState();
        const plantBlacklist: number[] = getPlantBlacklist(state.accountId);
        const status: AnalyzeResult = analyzeFriendLands(lands, state.gid, '', { plantBlacklist });
        let count: number = 0;

        if (opType === 'steal') {
            if (!status.stealable.length) return { ok: true, opType, count: 0, message: '没有可偷取土地' };
            const target: number[] = status.stealable;
            count = await runBatchWithFallback(target, (ids: number[]) => stealHarvest(gid, ids), (ids: number[]) => stealHarvest(gid, ids));
            if (count > 0) {
                recordOperation('steal', count);
                // 手动偷取成功后立即尝试出售一次果实
                try {
                    await sellAllFruits();
                } catch (e: any) {
                    logWarn('仓库', `手动偷取后自动出售失败: ${e.message}`, {
                        module: 'warehouse',
                        event: '偷菜后出售',
                        result: 'error',
                        mode: 'manual',
                    });
                }
            }
            return { ok: true, opType, count, message: `偷取完成 ${count} 块` };
        }

        if (opType === 'farming' || opType === 'water' || opType === 'weed' || opType === 'bug') {
            const landIds: number[] = opType === 'farming'
                ? [...new Set([...status.needWeed, ...status.needBug, ...status.needWater])]
                : opType === 'water' ? status.needWater
                : opType === 'weed' ? status.needWeed
                : status.needBug;
            if (!landIds.length) return { ok: true, opType, count: 0, message: '没有需要照顾的土地' };
            const outcome: FarmingOutcome = await runFarmingWithFallback(gid, landIds, false, getHelpSnapshotKey(lands));
            count = outcome.landCount;
            if (outcome.operationCount > 0) recordOperation('helpFarming', outcome.operationCount);
            return {
                ok: true,
                opType,
                count,
                landCount: outcome.landCount,
                operationCount: outcome.operationCount,
                dogSkillGiftCount: outcome.dogSkillGiftCount,
                message: `一键务农完成 ${outcome.landCount} 块 / ${outcome.operationCount} 项操作${outcome.dogSkillGiftCount > 0 ? `，自动获得同气连枝礼包 x${outcome.dogSkillGiftCount}` : ''}`,
            };
        }

        if (opType === 'bad') {
            let bugCount: number = 0;
            let weedCount: number = 0;
            if (!status.canPutBug.length && !status.canPutWeed.length) {
                return { ok: true, opType, count: 0, bugCount: 0, weedCount: 0, message: '没有可捣乱土地' };
            }

            // 手动捣乱不依赖预检查，逐块执行（与 terminal-farm-main 保持一致）
            let failDetails: string[] = [];
            if (status.canPutWeed.length) {
                const weedRet: { ok: number; failed: any[]; limitReached?: boolean } = await putWeedsDetailed(gid, status.canPutWeed);
                weedCount = weedRet.ok;
                failDetails = failDetails.concat((weedRet.failed || []).map((f: any) => `放草#${f.landId}:${f.reason}`));
                if (weedCount > 0) recordOperation('weed', weedCount);
            }
            if (!schedulerRef().isBadOperationLimitReached() && status.canPutBug.length) {
                const bugRet: { ok: number; failed: any[]; limitReached?: boolean } = await putInsectsDetailed(gid, status.canPutBug);
                bugCount = bugRet.ok;
                failDetails = failDetails.concat((bugRet.failed || []).map((f: any) => `放虫#${f.landId}:${f.reason}`));
                if (bugCount > 0) recordOperation('bug', bugCount);
            }
            count = bugCount + weedCount;
            if (schedulerRef().isBadOperationLimitReached()) {
                return {
                    ok: true,
                    opType,
                    count,
                    bugCount,
                    weedCount,
                    message: '今日放虫/放草次数已达上限',
                };
            }
            if (count <= 0) {
                const reasonPreview: string = failDetails.slice(0, 2).join(' | ');
                return {
                    ok: true,
                    opType,
                    count: 0,
                    bugCount,
                    weedCount,
                    message: reasonPreview ? `捣乱失败: ${reasonPreview}` : '捣乱失败或今日次数已用完'
                };
            }
            return { ok: true, opType, count, bugCount, weedCount, message: `捣乱完成 虫${bugCount}/草${weedCount}` };
        }

        return { ok: false, opType, count: 0, message: '未知操作类型' };
    } catch (e: any) {
        return { ok: false, opType, count: 0, message: e.message || '操作失败' };
    } finally {
        try { await leaveFriendFarm(gid); } catch { /* ignore */ }
    }
}

// ============ 拜访好友 ============

interface VisitResult {
    acted: boolean;
    entered: boolean;
    status?: 'helped' | 'skipped_exp_limit' | 'protect_dog_bypass' | 'no_action' | 'enter_failed';
    protectDogBypass?: boolean;
}

/** 单次访问要做哪几件事；默认全做，保持老调用方的行为不变。 */
export interface VisitFriendOptions {
    allowSteal?: boolean;
    allowHelp?: boolean;
    allowBad?: boolean;
    ignoreExpLimit?: boolean;
}

/**
 * 进一次好友农场，把 帮助（除草/除虫/浇水）+ 偷菜 + 捣乱（放草/放虫）一次做完。
 * 三件事都不需要做时连 Enter 都不发——省下的就是以前那一屏 Enter/Leave 超时日志。
 */
export async function visitFriend(
    friend: any,
    totalActions: any,
    myGid: number,
    accountId: string,
    options: VisitFriendOptions = {},
): Promise<VisitResult> {
    const { gid, name } = friend;
    const allowSteal: boolean = options.allowSteal !== false;
    const allowBad: boolean = options.allowBad !== false;
    const ignoreExpLimit: boolean = !!options.ignoreExpLimit;

    const stealEnabled: boolean = allowSteal && !!isAutomationOn('friend_steal');
    const badEnabled: boolean = allowBad && !!isAutomationOn('friend_bad');
    const stopWhenExpLimit: boolean = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
    if (!stopWhenExpLimit) schedulerRef().setCanGetHelpExp(true);
    const protectDogBypassEnabled: boolean = !!isAutomationOn('friend_help_protect_dog_ignore_exp_limit');
    const expLimitReachedBeforeVisit: boolean = stopWhenExpLimit && !schedulerRef().getCanGetHelpExp();
    // 经验满之后唯一还值得帮忙的对象是挂着护主犬的好友（同气连枝礼包）。
    // 护主犬只能从 Enter 回包读到，所以这里只查当天缓存，不再逐个进农场试探；
    // 缓存还没结论的好友交给 pet-sync 的每日同步补齐。
    const helpBlockedByExpLimit: boolean = expLimitReachedBeforeVisit
        && (!protectDogBypassEnabled || getFriendDogState(gid) !== 'protect');
    const helpEnabled: boolean = options.allowHelp !== false
        && !!isAutomationOn('friend_help')
        && !helpBlockedByExpLimit;

    if (!stealEnabled && !badEnabled && !helpEnabled) {
        // 这一轮对这位好友无事可做：一个请求都不发
        return {
            acted: false,
            entered: false,
            status: helpBlockedByExpLimit ? 'skipped_exp_limit' : 'no_action',
        };
    }

    let enterReply: any;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e: any) {
        const handled: { handled: boolean; kind: string } = handleFriendEnterError(gid, name, e);
        if (handled.handled && handled.kind === 'blacklist') {
            return { acted: false, entered: false };
        }
        if (handled.handled && handled.kind === 'invalid_removed') {
            return { acted: false, entered: false };
        }
        logWarn('好友', `进入 ${name} 农场失败: ${e.message}`, {
            module: 'friend', event: '进入农场', result: 'error', friendName: name, friendGid: gid
        });
        return { acted: false, entered: false };
    }

    const lands: any[] = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return { acted: false, entered: true };
    }

    const plantBlacklist: number[] = getPlantBlacklist(accountId);
    const status: AnalyzeResult = analyzeFriendLands(lands, myGid, name, { plantBlacklist });

    // 执行操作
    const actions: string[] = [];

    // 1. 帮助操作 (除草/除虫/浇水)
    const protectDogBypass: boolean = protectDogBypassEnabled && canBypassHelpExpLimitForProtectDog(enterReply);
    const effectiveStopWhenExpLimit: boolean = stopWhenExpLimit && !protectDogBypass;
    if (!helpEnabled) {
        // 自动帮忙关闭，直接跳过帮助操作
    } else if (effectiveStopWhenExpLimit && !schedulerRef().getCanGetHelpExp()) {
        // 今日已达到经验上限后停止帮忙
    } else {
        const allHelpLandIds: number[] = [...new Set([...status.needWeed, ...status.needBug, ...status.needWater])];
        const allExpIds: number[] = [10005, 10006, 10007];
        const allowByExp: boolean = (!effectiveStopWhenExpLimit) || (schedulerRef().canGetExpByCandidates(allExpIds) && schedulerRef().getCanGetHelpExp());
        if (allHelpLandIds.length > 0 && allowByExp) {
            const outcome: FarmingOutcome = await runFarmingWithFallback(gid, allHelpLandIds, stopWhenExpLimit, getHelpSnapshotKey(lands));
            if (outcome.landCount > 0) {
                const parts: string[] = [];
                if (status.needWeed.length) parts.push(`草${status.needWeed.length}`);
                if (status.needBug.length) parts.push(`虫${status.needBug.length}`);
                if (status.needWater.length) parts.push(`水${status.needWater.length}`);
                actions.push(`一键务农${outcome.landCount}块/${outcome.operationCount}项(${parts.join('/')})`);
                if (outcome.dogSkillGiftCount > 0) actions.push(`同气连枝礼包x${outcome.dogSkillGiftCount}(自动获得)`);
                totalActions.farming += outcome.landCount;
                recordOperation('helpFarming', outcome.operationCount);
            }
        }
    }

    // 2. 偷菜操作
    if (stealEnabled && status.stealable.length > 0) {
        const targetLands: number[] = status.stealable;

        let ok: number = 0;
        const stolenPlants: string[] = [];

        // 尝试批量偷取
        try {
            await stealHarvest(gid, targetLands);
            ok = targetLands.length;
            targetLands.forEach((id: number) => {
                const info: any = status.stealableInfo.find((x: any) => x.landId === id);
                if (info) stolenPlants.push(info.name);
            });
        } catch {
            // 批量失败，降级为单个
            for (const landId of targetLands) {
                try {
                    await stealHarvest(gid, [landId]);
                    ok++;
                    const info: any = status.stealableInfo.find((x: any) => x.landId === landId);
                    if (info) stolenPlants.push(info.name);
                } catch { /* ignore */ }
                await randomDelay(500, 800);
            }
        }

        if (ok > 0) {
            const plantNames: string = [...new Set(stolenPlants)].join('/');
            actions.push(`偷${ok}${plantNames ? `(${  plantNames  })` : ''}`);
            totalActions.steal += ok;
            recordOperation('steal', ok);
            await randomDelay(500, 800);
        }
    }

    // 3. 捣乱操作 (放虫/放草)
    if (badEnabled && !schedulerRef().isBadOperationLimitReached()) {
        if (status.canPutWeed.length > 0) {
            const remaining: number = schedulerRef().getRemainingBadOperationTimes();
            const toProcess: number[] = status.canPutWeed.slice(0, remaining);
            const ok: number = await putWeeds(gid, toProcess);
            if (ok > 0) { actions.push(`放草${ok}`); totalActions.putWeed += ok; }
            if (!schedulerRef().isBadOperationLimitReached()) await randomDelay(500, 800);
        }

        if (!schedulerRef().isBadOperationLimitReached() && status.canPutBug.length > 0) {
            const remaining: number = schedulerRef().getRemainingBadOperationTimes();
            const toProcess: number[] = status.canPutBug.slice(0, remaining);
            const ok: number = await putInsects(gid, toProcess);
            if (ok > 0) { actions.push(`放虫${ok}`); totalActions.putBug += ok; }
            await randomDelay(500, 800);
        }
    }

    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: '照顾好友', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }

    await leaveFriendFarm(gid);
    return { acted: actions.length > 0, entered: true };
}

// ============ 缓存管理 ============

export function clearFriendsListCache(): void {
    friendsListCache = null;
    friendsListCacheTime = 0;
    recentHelp.clear();
}

export function removeFriendFromFriendsListCache(friendGid: any): void {
    const gid: number = toNum(friendGid);
    if (!gid) return;
    if (!Array.isArray(friendsListCache)) return;
    const next: any[] = friendsListCache.filter((friend: any) => toNum(friend.gid) !== gid);
    if (next.length !== friendsListCache.length) {
        friendsListCache = next;
    }
}

export async function deleteFriend(friendGid: any): Promise<{ ok: true; gid: number }> {
    const gid: number = toNum(friendGid);
    if (!gid) throw new Error('无效的好友 GID');

    const cached: any = Array.isArray(friendsListCache)
        ? friendsListCache.find((friend: any) => toNum(friend.gid) === gid)
        : null;
    const name: string = String((cached && cached.name) || '').trim() || `GID:${gid}`;

    await delFriend(gid);
    removeFriendFromFriendsListCache(gid);
    removeKnownFriendGid(gid, name, '手动删除好友');
    addFriendToBlacklist(gid, name, '手动删除好友');

    log('好友', `已删除好友: ${name}`, {
        module: 'friend',
        event: '删除好友',
        result: 'ok',
        friendName: name,
        friendGid: gid,
    });
    return { ok: true, gid };
}

