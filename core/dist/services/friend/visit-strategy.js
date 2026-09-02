"use strict";
/**
 * 拜访好友策略 - 访问逻辑、好友分析、错误处理、安静时段
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleFriendEnterError = handleFriendEnterError;
exports.parseTimeToMinutes = parseTimeToMinutes;
exports.inFriendQuietHours = inFriendQuietHours;
exports.inFarmQuietHours = inFarmQuietHours;
exports.analyzeFriendLands = analyzeFriendLands;
exports.getFriendsList = getFriendsList;
exports.getFriendLandsDetail = getFriendLandsDetail;
exports.runBatchWithFallback = runBatchWithFallback;
exports.doFriendOperation = doFriendOperation;
exports.visitFriend = visitFriend;
exports.visitFriendForSteal = visitFriendForSteal;
exports.visitFriendForHelp = visitFriendForHelp;
exports.clearFriendsListCache = clearFriendsListCache;
const { PlantPhase } = require('../../config/config');
const { getPlantName, getPlantById } = require('../../config/gameConfig');
const { isAutomationOn, getFriendQuietHours, getFriendBlacklist, getPlantBlacklist, getFriendsListCacheTtlSec, } = require('../../models/store');
const { getUserState } = require('../../utils/network');
const { toNum, getServerTimeSec, getSystemClockMinutes, log, logWarn, sleep, randomDelay } = require('../../utils/utils');
const { types } = require('../../utils/proto');
const { getCurrentPhase, buildLandMap, buildLandDetail, getPlantStatusFlags, isOccupiedSlaveLand, } = require('../farm');
const { recordOperation } = require('../stats');
const { sellAllFruits } = require('../warehouse');
const { getAllFriends, enterFriendFarm, leaveFriendFarm, helpFarming, stealHarvest, putInsects, putWeeds, putInsectsDetailed, putWeedsDetailed, } = require('./api');
const { postToMaster, removeKnownFriendGid, } = require('./gid-manager');
// 延迟引用 scheduler 模块，避免循环依赖
let _scheduler = null;
function schedulerRef() {
    if (!_scheduler)
        _scheduler = require('./scheduler');
    return _scheduler;
}
// ============ 内部状态 ============
let friendsListCache = null;
let friendsListCacheTime = 0;
const recentHelp = new Map();
const HELP_IN_FLIGHT_TTL_MS = 15000;
const HELP_RESULT_TTL_MS = 30000;
const HELP_CACHE_MAX = 2048;
function getHelpKey(hostGid, landId) {
    return `${hostGid}:${landId}`;
}
function pruneRecentHelp(now = Date.now()) {
    for (const [key, entry] of recentHelp) {
        if (entry.expiresAt <= now)
            recentHelp.delete(key);
    }
    while (recentHelp.size > HELP_CACHE_MAX) {
        const oldestKey = recentHelp.keys().next().value;
        if (!oldestKey)
            break;
        recentHelp.delete(oldestKey);
    }
}
function getHelpSnapshotKey(lands) {
    return (Array.isArray(lands) ? lands : []).map((land) => {
        const plant = land && land.plant;
        const phase = plant && Array.isArray(plant.phases) ? getCurrentPhase(plant.phases) : null;
        const weeds = (plant && Array.isArray(plant.weed_owners) ? plant.weed_owners : []).map(toNum).join(',');
        const insects = (plant && Array.isArray(plant.insect_owners) ? plant.insect_owners : []).map(toNum).join(',');
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
function filterRecentHelp(hostGid, landIds, snapshotKey) {
    const now = Date.now();
    pruneRecentHelp(now);
    return [...new Set(landIds.map((id) => toNum(id)).filter((id) => id > 0))].filter((landId) => {
        const key = getHelpKey(hostGid, landId);
        const entry = recentHelp.get(key);
        if (!entry || entry.expiresAt <= now)
            return true;
        if (entry.snapshotKey !== snapshotKey) {
            recentHelp.delete(key);
            return true;
        }
        return false;
    });
}
function markRecentHelp(hostGid, landIds, state, ttlMs, snapshotKey) {
    const expiresAt = Date.now() + ttlMs;
    for (const landId of landIds)
        recentHelp.set(getHelpKey(hostGid, landId), { state, snapshotKey, expiresAt });
    pruneRecentHelp();
}
function releaseRecentHelp(hostGid, landIds) {
    for (const landId of landIds)
        recentHelp.delete(getHelpKey(hostGid, landId));
}
function getFriendsListCacheTtlMs() {
    const sec = Number(getFriendsListCacheTtlSec ? getFriendsListCacheTtlSec() : 0);
    if (!Number.isFinite(sec) || sec <= 0)
        return 60 * 1000;
    return Math.max(10 * 1000, sec * 1000);
}
// ============ 错误处理 ============
function isEnterFarmBannedError(error) {
    const message = String((error && error.message) || error || '');
    if (!message)
        return false;
    return message.includes('1002003');
}
function parseRpcErrorCode(error) {
    const message = String((error && error.message) || error || '');
    const match = message.match(/code=(\d+)/i);
    return match ? (Number.parseInt(match[1], 10) || 0) : 0;
}
function isTransientNetworkError(error) {
    const message = String((error && error.message) || error || '');
    if (!message)
        return false;
    return [
        '连接未打开',
        '请求超时',
        '请求已中断',
        '连接关闭',
        '连接已在加密途中关闭',
        'worker exited',
    ].some(keyword => message.includes(keyword));
}
function isInvalidFriendAccessError(error) {
    const message = String((error && error.message) || error || '');
    if (!message || isEnterFarmBannedError(error) || isTransientNetworkError(error)) {
        return false;
    }
    const lowerMessage = message.toLowerCase();
    const hasInvalidKeyword = [
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
function addFriendToBlacklist(friendGid, friendName, reason = '') {
    const gid = toNum(friendGid);
    if (!gid)
        return false;
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    const currentList = getFriendBlacklist(accountId);
    const current = Array.isArray(currentList) ? currentList : [];
    if (current.includes(gid))
        return false;
    const sent = postToMaster({
        type: 'friend_blacklist_add',
        gid,
        friendName: friendName || `GID:${gid}`,
        reason: String(reason || ''),
    });
    if (!sent)
        return false;
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
function handleFriendEnterError(friendGid, friendName, error) {
    const gid = toNum(friendGid);
    const displayName = String(friendName || '').trim() || `GID:${gid}`;
    const reason = String((error && error.message) || error || '');
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
function parseTimeToMinutes(timeStr) {
    const m = String(timeStr || '').match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m)
        return null;
    const h = Number.parseInt(m[1], 10);
    const min = Number.parseInt(m[2], 10);
    if (Number.isNaN(h) || Number.isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59)
        return null;
    return h * 60 + min;
}
function inFriendQuietHours(now) {
    const cfg = getFriendQuietHours();
    if (!cfg || !cfg.enabled)
        return false;
    const start = parseTimeToMinutes(cfg.start);
    const end = parseTimeToMinutes(cfg.end);
    if (start === null || end === null)
        return false;
    const cur = now instanceof Date
        ? getSystemClockMinutes(now.getTime())
        : getSystemClockMinutes();
    if (start === end)
        return true; // 起止相同视为全天静默
    if (start < end)
        return cur >= start && cur < end;
    return cur >= start || cur < end; // 跨天时段
}
function inFarmQuietHours(now) {
    if (!inFriendQuietHours(now))
        return false;
    const cfg = getFriendQuietHours();
    return cfg.continueFarm === false;
}
function analyzeFriendLands(lands, myGid, friendName = '', options = {}) {
    const { plantBlacklist = null } = options;
    const result = {
        stealable: [], // 可偷
        stealableInfo: [], // 可偷植物信息 { landId, plantId, name }
        needWater: [], // 需要浇水
        needWeed: [], // 需要除草
        needBug: [], // 需要除虫
        canPutWeed: [], // 可以放草
        canPutBug: [], // 可以放虫
    };
    const landsMap = buildLandMap(lands);
    for (const land of lands) {
        const id = toNum(land.id);
        if (isOccupiedSlaveLand(land, landsMap)) {
            continue;
        }
        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) {
            continue;
        }
        const currentPhase = getCurrentPhase(plant.phases, false, `[${friendName}]土地#${id}`);
        if (!currentPhase) {
            continue;
        }
        const phaseVal = currentPhase.phase;
        if (phaseVal === PlantPhase.MATURE) {
            if (plant.stealable) {
                const plantId = toNum(plant.id);
                const plantName = getPlantName(plantId) || plant.name || '未知';
                // 获取种子ID用于黑名单检查（前端黑名单使用seedId）
                const plantCfg = getPlantById(plantId);
                const seedId = plantCfg ? toNum(plantCfg.seed_id) : 0;
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
        if (phaseVal === PlantPhase.DEAD)
            continue;
        // 帮助操作
        const statusFlags = getPlantStatusFlags(plant, currentPhase);
        if (statusFlags.needWater)
            result.needWater.push(id);
        if (statusFlags.needWeed)
            result.needWeed.push(id);
        if (statusFlags.needBug)
            result.needBug.push(id);
        // 捣乱操作: 检查是否可以放草/放虫
        // 条件: 植物未成熟 + 没有草/虫且我没放过 + 每块地最多2个草/虫
        if (phaseVal !== PlantPhase.MATURE) {
            const weedOwners = plant.weed_owners || [];
            const insectOwners = plant.insect_owners || [];
            const iAlreadyPutWeed = weedOwners.some((gid) => toNum(gid) === myGid);
            const iAlreadyPutBug = insectOwners.some((gid) => toNum(gid) === myGid);
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
/**
 * 获取好友列表 (供面板)
 */
async function getFriendsList(forceSync = false) {
    try {
        // 检查缓存
        const now = Date.now();
        if (!forceSync && friendsListCache && (now - friendsListCacheTime) < getFriendsListCacheTtlMs()) {
            return friendsListCache;
        }
        log('好友', '开始获取好友列表', {
            module: 'friend',
            event: '获取好友列表',
        });
        const reply = await getAllFriends(forceSync);
        const friends = reply.game_friends || [];
        const state = getUserState();
        const result = friends
            .filter((f) => toNum(f.gid) !== state.gid && f.name !== '小小农夫' && f.remark !== '小小农夫')
            .map((f) => ({
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
        }))
            .sort((a, b) => {
            // 固定顺序：先按名称，再按 GID，避免刷新时顺序抖动
            const an = String(a.name || '');
            const bn = String(b.name || '');
            const byName = an.localeCompare(bn, 'zh-CN');
            if (byName !== 0)
                return byName;
            return Number(a.gid || 0) - Number(b.gid || 0);
        });
        // 更新缓存
        friendsListCache = result;
        friendsListCacheTime = now;
        log('好友', `获取好友列表成功，共 ${result.length} 位好友`, {
            module: 'friend',
            event: '获取好友列表',
            result: 'ok',
            count: result.length,
        });
        return result;
    }
    catch (e) {
        log('好友', `获取好友列表失败: ${e.message}`, {
            module: 'friend',
            event: '获取好友列表',
            result: 'error',
            error: e.message,
        });
        return [];
    }
}
/**
 * 获取指定好友的农田详情 (进入-获取-离开)
 */
async function getFriendLandsDetail(friendGid) {
    let entered = false;
    try {
        const enterReply = await enterFriendFarm(friendGid);
        entered = true;
        const lands = enterReply.lands || [];
        const state = getUserState();
        const plantBlacklist = getPlantBlacklist(state.accountId);
        const analyzed = analyzeFriendLands(lands, state.gid, '', { plantBlacklist });
        const nowSec = getServerTimeSec();
        const landsMap = buildLandMap(lands);
        const landsList = lands.map((land) => buildLandDetail(land, {
            friendMode: true,
            landsMap,
            nowSec,
        }));
        return {
            lands: landsList,
            summary: analyzed,
        };
    }
    finally {
        if (entered)
            await leaveFriendFarm(friendGid);
    }
}
// ============ 批量操作与面板操作 ============
async function runBatchWithFallback(ids, batchFn, singleFn) {
    const target = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (target.length === 0)
        return 0;
    try {
        await batchFn(target);
        return target.length;
    }
    catch {
        let ok = 0;
        for (const landId of target) {
            try {
                await singleFn([landId]);
                ok++;
            }
            catch { /* ignore */ }
            await sleep(100);
        }
        return ok;
    }
}
function emptyFarmingOutcome(effect = 'noop') {
    return { effect, operationCount: 0, landCount: 0, landIds: [], operationLimits: [], dogSkillGiftCount: 0 };
}
function mergeFarmingOutcomes(outcomes) {
    const confirmed = outcomes.filter((outcome) => outcome.effect === 'confirmed');
    const landIds = [...new Set(confirmed.flatMap((outcome) => outcome.landIds || []))];
    const operationLimits = confirmed.flatMap((outcome) => outcome.operationLimits || []);
    return {
        effect: confirmed.length > 0 ? 'confirmed' : (outcomes.some((outcome) => outcome.effect === 'uncertain') ? 'uncertain' : 'noop'),
        operationCount: confirmed.reduce((sum, outcome) => sum + (Number(outcome.operationCount) || 0), 0),
        landCount: landIds.length,
        landIds,
        operationLimits,
        dogSkillGiftCount: outcomes.reduce((sum, outcome) => sum + (Number(outcome.dogSkillGiftCount) || 0), 0),
    };
}
async function runFarmingWithFallback(hostGid, ids, stopWhenExpLimit = false, snapshotKey = '') {
    const target = filterRecentHelp(hostGid, Array.isArray(ids) ? ids : [], snapshotKey);
    if (target.length === 0)
        return emptyFarmingOutcome();
    markRecentHelp(hostGid, target, 'in_flight', HELP_IN_FLIGHT_TTL_MS, snapshotKey);
    try {
        const batch = await helpFarming(hostGid, target, stopWhenExpLimit);
        if (batch.effect === 'noop') {
            markRecentHelp(hostGid, target, 'noop', HELP_RESULT_TTL_MS, snapshotKey);
            return batch;
        }
        if (batch.effect === 'confirmed') {
            markRecentHelp(hostGid, batch.landIds, 'confirmed', HELP_RESULT_TTL_MS, snapshotKey);
        }
        const unconfirmed = target.filter((landId) => !batch.landIds.includes(landId));
        releaseRecentHelp(hostGid, unconfirmed);
        return batch;
    }
    catch {
        releaseRecentHelp(hostGid, target);
        const outcomes = [];
        for (const landId of target) {
            markRecentHelp(hostGid, [landId], 'in_flight', HELP_IN_FLIGHT_TTL_MS, snapshotKey);
            try {
                const outcome = await helpFarming(hostGid, [landId], stopWhenExpLimit);
                outcomes.push(outcome);
                if (outcome.effect === 'noop')
                    markRecentHelp(hostGid, [landId], 'noop', HELP_RESULT_TTL_MS, snapshotKey);
                else if (outcome.effect === 'confirmed')
                    markRecentHelp(hostGid, outcome.landIds, 'confirmed', HELP_RESULT_TTL_MS, snapshotKey);
                else
                    releaseRecentHelp(hostGid, [landId]);
            }
            catch {
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
async function doFriendOperation(friendGid, opType) {
    const gid = toNum(friendGid);
    if (!gid)
        return { ok: false, message: '无效好友ID', opType };
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
    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    }
    catch (e) {
        const handled = handleFriendEnterError(gid, `GID:${gid}`, e);
        if (handled.handled && handled.kind === 'blacklist') {
            return { ok: true, opType, count: 0, message: '好友已自动加入黑名单' };
        }
        if (handled.handled && handled.kind === 'invalid_removed') {
            return { ok: true, opType, count: 0, message: '好友 GID 已失效，已自动移出已知列表' };
        }
        return { ok: false, message: `进入好友农场失败: ${e.message}`, opType };
    }
    try {
        const lands = enterReply.lands || [];
        const state = getUserState();
        const plantBlacklist = getPlantBlacklist(state.accountId);
        const status = analyzeFriendLands(lands, state.gid, '', { plantBlacklist });
        let count = 0;
        if (opType === 'steal') {
            if (!status.stealable.length)
                return { ok: true, opType, count: 0, message: '没有可偷取土地' };
            const target = status.stealable;
            count = await runBatchWithFallback(target, (ids) => stealHarvest(gid, ids), (ids) => stealHarvest(gid, ids));
            if (count > 0) {
                recordOperation('steal', count);
                // 手动偷取成功后立即尝试出售一次果实
                try {
                    await sellAllFruits();
                }
                catch (e) {
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
            const landIds = opType === 'farming'
                ? [...new Set([...status.needWeed, ...status.needBug, ...status.needWater])]
                : opType === 'water' ? status.needWater
                    : opType === 'weed' ? status.needWeed
                        : status.needBug;
            if (!landIds.length)
                return { ok: true, opType, count: 0, message: '没有需要照顾的土地' };
            const outcome = await runFarmingWithFallback(gid, landIds, false, getHelpSnapshotKey(lands));
            count = outcome.landCount;
            if (outcome.operationCount > 0)
                recordOperation('helpFarming', outcome.operationCount);
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
            let bugCount = 0;
            let weedCount = 0;
            if (!status.canPutBug.length && !status.canPutWeed.length) {
                return { ok: true, opType, count: 0, bugCount: 0, weedCount: 0, message: '没有可捣乱土地' };
            }
            // 手动捣乱不依赖预检查，逐块执行（与 terminal-farm-main 保持一致）
            let failDetails = [];
            if (status.canPutWeed.length) {
                const weedRet = await putWeedsDetailed(gid, status.canPutWeed);
                weedCount = weedRet.ok;
                failDetails = failDetails.concat((weedRet.failed || []).map((f) => `放草#${f.landId}:${f.reason}`));
                if (weedCount > 0)
                    recordOperation('weed', weedCount);
            }
            if (!schedulerRef().isBadOperationLimitReached() && status.canPutBug.length) {
                const bugRet = await putInsectsDetailed(gid, status.canPutBug);
                bugCount = bugRet.ok;
                failDetails = failDetails.concat((bugRet.failed || []).map((f) => `放虫#${f.landId}:${f.reason}`));
                if (bugCount > 0)
                    recordOperation('bug', bugCount);
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
                const reasonPreview = failDetails.slice(0, 2).join(' | ');
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
    }
    catch (e) {
        return { ok: false, opType, count: 0, message: e.message || '操作失败' };
    }
    finally {
        try {
            await leaveFriendFarm(gid);
        }
        catch { /* ignore */ }
    }
}
async function visitFriend(friend, totalActions, myGid, accountId) {
    const { gid, name } = friend;
    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    }
    catch (e) {
        const handled = handleFriendEnterError(gid, name, e);
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
    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return { acted: false, entered: true };
    }
    const plantBlacklist = getPlantBlacklist(accountId);
    const status = analyzeFriendLands(lands, myGid, name, { plantBlacklist });
    // 执行操作
    const actions = [];
    // 1. 帮助操作 (除草/除虫/浇水)
    const helpEnabled = !!isAutomationOn('friend_help');
    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit');
    if (!stopWhenExpLimit)
        schedulerRef().setCanGetHelpExp(true);
    if (!helpEnabled) {
        // 自动帮忙关闭，直接跳过帮助操作
    }
    else if (stopWhenExpLimit && !schedulerRef().getCanGetHelpExp()) {
        // 今日已达到经验上限后停止帮忙
    }
    else {
        const allHelpLandIds = [...new Set([...status.needWeed, ...status.needBug, ...status.needWater])];
        const allExpIds = [10005, 10006, 10007];
        const allowByExp = (!stopWhenExpLimit) || (schedulerRef().canGetExpByCandidates(allExpIds) && schedulerRef().getCanGetHelpExp());
        if (allHelpLandIds.length > 0 && allowByExp) {
            const outcome = await runFarmingWithFallback(gid, allHelpLandIds, stopWhenExpLimit, getHelpSnapshotKey(lands));
            if (outcome.landCount > 0) {
                const parts = [];
                if (status.needWeed.length)
                    parts.push(`草${status.needWeed.length}`);
                if (status.needBug.length)
                    parts.push(`虫${status.needBug.length}`);
                if (status.needWater.length)
                    parts.push(`水${status.needWater.length}`);
                actions.push(`一键务农${outcome.landCount}块/${outcome.operationCount}项(${parts.join('/')})`);
                if (outcome.dogSkillGiftCount > 0)
                    actions.push(`同气连枝礼包x${outcome.dogSkillGiftCount}(自动获得)`);
                totalActions.farming += outcome.landCount;
                recordOperation('helpFarming', outcome.operationCount);
            }
        }
    }
    // 2. 偷菜操作
    if (isAutomationOn('friend_steal') && status.stealable.length > 0) {
        const targetLands = status.stealable;
        let ok = 0;
        const stolenPlants = [];
        // 尝试批量偷取
        try {
            await stealHarvest(gid, targetLands);
            ok = targetLands.length;
            targetLands.forEach((id) => {
                const info = status.stealableInfo.find((x) => x.landId === id);
                if (info)
                    stolenPlants.push(info.name);
            });
        }
        catch {
            // 批量失败，降级为单个
            for (const landId of targetLands) {
                try {
                    await stealHarvest(gid, [landId]);
                    ok++;
                    const info = status.stealableInfo.find((x) => x.landId === landId);
                    if (info)
                        stolenPlants.push(info.name);
                }
                catch { /* ignore */ }
                await randomDelay(500, 800);
            }
        }
        if (ok > 0) {
            const plantNames = [...new Set(stolenPlants)].join('/');
            actions.push(`偷${ok}${plantNames ? `(${plantNames})` : ''}`);
            totalActions.steal += ok;
            recordOperation('steal', ok);
            await randomDelay(500, 800);
        }
    }
    // 3. 捣乱操作 (放虫/放草)
    const autoBad = isAutomationOn('friend_bad');
    if (autoBad && !schedulerRef().isBadOperationLimitReached()) {
        if (status.canPutWeed.length > 0) {
            const remaining = schedulerRef().getRemainingBadOperationTimes();
            const toProcess = status.canPutWeed.slice(0, remaining);
            const ok = await putWeeds(gid, toProcess);
            if (ok > 0) {
                actions.push(`放草${ok}`);
                totalActions.putWeed += ok;
            }
            if (!schedulerRef().isBadOperationLimitReached())
                await randomDelay(500, 800);
        }
        if (!schedulerRef().isBadOperationLimitReached() && status.canPutBug.length > 0) {
            const remaining = schedulerRef().getRemainingBadOperationTimes();
            const toProcess = status.canPutBug.slice(0, remaining);
            const ok = await putInsects(gid, toProcess);
            if (ok > 0) {
                actions.push(`放虫${ok}`);
                totalActions.putBug += ok;
            }
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
// ============ 仅偷菜 ============
async function visitFriendForSteal(friend, totalActions, myGid, accountId) {
    const { gid, name } = friend;
    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    }
    catch (e) {
        const handled = handleFriendEnterError(gid, name, e);
        if (handled.handled) {
            return { acted: false, entered: false };
        }
        logWarn('好友', `进入 ${name} 农场失败: ${e.message}`, {
            module: 'friend', event: '进入农场', result: 'error', friendName: name, friendGid: gid
        });
        return { acted: false, entered: false };
    }
    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return { acted: false, entered: true };
    }
    const plantBlacklist = getPlantBlacklist(accountId);
    const status = analyzeFriendLands(lands, myGid, name, { plantBlacklist });
    const actions = [];
    // 检查是否所有可偷蔬菜都被黑名单过滤了（只统计成熟的、可偷的植物）
    const hasStealableBeforeFilter = lands.some((land) => {
        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0)
            return false;
        const currentPhase = getCurrentPhase(land.plant.phases, false);
        if (!currentPhase || currentPhase.phase !== PlantPhase.MATURE)
            return false;
        if (!plant.stealable)
            return false;
        // stealers 字段为 bytes 类型，需手动解析为 StealPlayer 数组
        let stealInfo = [];
        if (plant.stealers && plant.stealers.length > 0 && plant.stealers[0] === 0x08) {
            try {
                const decoded = types.StealPlayer.decode(plant.stealers);
                stealInfo = [decoded];
            }
            catch { }
        }
        if (stealInfo.length === 0)
            return true; // 无人偷过，可偷
        const mySteal = stealInfo.find((s) => toNum(s.gid) === myGid);
        const stealCount = mySteal ? toNum(mySteal.num) : 0;
        // steal_num 为 bytes 类型，手动解析 varint
        let maxSteal = 2;
        if (plant.steal_num && plant.steal_num.length > 0) {
            let v = 0;
            let s = 0;
            for (let i = 0; i < plant.steal_num.length && i < 10; i++) {
                v |= (plant.steal_num[i] & 0x7F) << s;
                if ((plant.steal_num[i] & 0x80) === 0)
                    break;
                s += 7;
            }
            if (v > 0)
                maxSteal = v;
        }
        return stealCount < maxSteal;
    });
    if (hasStealableBeforeFilter && status.stealable.length === 0) {
        // log('好友', `${name}: 跳过，所有可偷蔬菜都被黑名单过滤`, {
        //     module: 'friend', event: '偷菜全部过滤', friendName: name, friendGid: gid
        // });
        await leaveFriendFarm(gid);
        return;
    }
    // 只执行偷菜
    if (status.stealable.length > 0) {
        const targetLands = status.stealable;
        let ok = 0;
        const stolenPlants = [];
        // 尝试批量偷取
        try {
            await stealHarvest(gid, targetLands);
            ok = targetLands.length;
            targetLands.forEach((id) => {
                const info = status.stealableInfo.find((x) => x.landId === id);
                if (info)
                    stolenPlants.push(info.name);
            });
        }
        catch {
            // 批量失败，降级为单个
            for (const landId of targetLands) {
                try {
                    await stealHarvest(gid, [landId]);
                    ok++;
                    const info = status.stealableInfo.find((x) => x.landId === landId);
                    if (info)
                        stolenPlants.push(info.name);
                }
                catch { /* ignore */ }
                await randomDelay(500, 800);
            }
        }
        if (ok > 0) {
            const plantNames = [...new Set(stolenPlants)].join('/');
            actions.push(`偷${ok}${plantNames ? `(${plantNames})` : ''}`);
            totalActions.steal += ok;
            recordOperation('steal', ok);
            await randomDelay(500, 800);
        }
    }
    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: '偷好友菜', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }
    await leaveFriendFarm(gid);
    return { acted: actions.length > 0, entered: true };
}
// ============ 仅帮助 ============
async function visitFriendForHelp(friend, totalActions, myGid, accountId, ignoreExpLimit = false) {
    const { gid, name } = friend;
    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
    if (!stopWhenExpLimit)
        schedulerRef().setCanGetHelpExp(true);
    if (stopWhenExpLimit && !schedulerRef().getCanGetHelpExp()) {
        return { acted: false, entered: false };
    }
    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    }
    catch (e) {
        const handled = handleFriendEnterError(gid, name, e);
        if (handled.handled) {
            return { acted: false, entered: false };
        }
        logWarn('好友', `进入 ${name} 农场失败: ${e.message}`, {
            module: 'friend', event: '进入农场', result: 'error', friendName: name, friendGid: gid
        });
        return { acted: false, entered: false };
    }
    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return;
    }
    const status = analyzeFriendLands(lands, myGid, name, {});
    const actions = [];
    const allHelpLandIds = [...new Set([...status.needWeed, ...status.needBug, ...status.needWater])];
    const allExpIds = [10005, 10006, 10007];
    const allowByExp = (!stopWhenExpLimit) || (schedulerRef().canGetExpByCandidates(allExpIds) && schedulerRef().getCanGetHelpExp());
    if (allHelpLandIds.length > 0 && allowByExp) {
        const outcome = await runFarmingWithFallback(gid, allHelpLandIds, stopWhenExpLimit, getHelpSnapshotKey(lands));
        if (outcome.landCount > 0) {
            const parts = [];
            if (status.needWeed.length)
                parts.push(`草${status.needWeed.length}`);
            if (status.needBug.length)
                parts.push(`虫${status.needBug.length}`);
            if (status.needWater.length)
                parts.push(`水${status.needWater.length}`);
            actions.push(`一键务农${outcome.landCount}块/${outcome.operationCount}项(${parts.join('/')})`);
            if (outcome.dogSkillGiftCount > 0)
                actions.push(`同气连枝礼包x${outcome.dogSkillGiftCount}(自动获得)`);
            totalActions.farming += outcome.landCount;
            recordOperation('helpFarming', outcome.operationCount);
        }
    }
    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: '帮助好友', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }
    await leaveFriendFarm(gid);
    return { acted: actions.length > 0, entered: true };
}
// ============ 缓存管理 ============
function clearFriendsListCache() {
    friendsListCache = null;
    friendsListCacheTime = 0;
    recentHelp.clear();
}
//# sourceMappingURL=visit-strategy.js.map