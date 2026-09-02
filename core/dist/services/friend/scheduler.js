"use strict";
/**
 * 好友巡查调度 - 循环管理、每日重置、经验限制、自动接受好友、启动捣乱
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkDailyReset = checkDailyReset;
exports.isBadOperationLimitReached = isBadOperationLimitReached;
exports.markBadOperationLimitReached = markBadOperationLimitReached;
exports.autoDisableHelpByExpLimit = autoDisableHelpByExpLimit;
exports.updateOperationLimits = updateOperationLimits;
exports.canGetExpByCandidates = canGetExpByCandidates;
exports.canGetExp = canGetExp;
exports.canOperate = canOperate;
exports.getRemainingTimes = getRemainingTimes;
exports.getRemainingBadOperationTimes = getRemainingBadOperationTimes;
exports.getOperationLimits = getOperationLimits;
exports.getCanGetHelpExp = getCanGetHelpExp;
exports.setCanGetHelpExp = setCanGetHelpExp;
exports.isFriendCheckRunning = isFriendCheckRunning;
exports.checkFriends = checkFriends;
exports.startFriendCheckLoop = startFriendCheckLoop;
exports.stopFriendCheckLoop = stopFriendCheckLoop;
exports.refreshFriendCheckLoop = refreshFriendCheckLoop;
exports.onFriendApplicationReceived = onFriendApplicationReceived;
exports.isHelpExpLimitReached = isHelpExpLimitReached;
const { CONFIG } = require('../../config/config');
const crypto = require('node:crypto');
const { getUserState, networkEvents } = require('../../utils/network');
const { toNum, getSystemDateKey, log, logWarn, randomDelay } = require('../../utils/utils');
const { getDataFile } = require('../../config/runtime-paths');
const { createScheduler } = require('../scheduler');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');
const { setOperationLimitsCallback } = require('../farm');
const { isAutomationOn, getFriendBlacklist, getAutoAcceptFriendMinLevel, getAutoAcceptRequireOwnLevel, getAutoAcceptHarvestStealEnabled, getAutoAcceptHarvestStealHarvest, getAutoAcceptHarvestStealSteal, } = require('../../models/store');
const { sellAllFruits } = require('../warehouse');
const { getCareerInfo } = require('../career');
const { getAllFriends, acceptFriends, rejectFriends, getApplications, } = require('./api');
const { isHarvestStealFilterEnabled, evaluateLevelFilter, evaluateHarvestStealFilter, } = require('./application-filter');
const { extractReplyFriends, clearAllInvalidKnownFriendGidCooldowns, } = require('./gid-manager');
const { visitFriend, inFriendQuietHours, cacheFriendsListFromReply, clearFriendsListCache, } = require('./visit-strategy');
const { buildFriendVisitPlan } = require('./visit-plan');
const { getFriendDogState, flushFriendPetCacheNow } = require('./pet-cache');
// 延迟引用 pet-sync，它反向依赖本模块的 isFriendCheckRunning
function petSyncRef() {
    return require('./pet-sync');
}
// ============ 内部状态 ============
let isCheckingFriends = false;
let friendLoopRunning = false;
let externalSchedulerMode = false;
let lastResetDate = ''; // 上次重置日期 (YYYY-MM-DD)
const friendScheduler = createScheduler('friend');
const operationLimits = new Map();
let canGetHelpExp = true;
let helpAutoDisabledByLimit = false;
let badOperationLimitReached = false;
// Captured PutWeeds/PutInsects replies both consume operation 10003.
// PutInsects additionally reports 10004, but 10003 is the shared daily quota.
const BAD_SHARED_LIMIT_ID = 10003;
const BAD_DAILY_STATE_VERSION = 1;
// 一轮最多对多少位「没可偷也没可帮」的好友做纯捣乱访问（按等级降序）
const MAX_BAD_ONLY_VISITS_PER_ROUND = 20;
const OP_NAMES = {
    10001: '浇水',
    10002: '除虫',
    10003: '捣乱共享额度',
    10004: '放虫',
    10005: '帮助操作 #10005',
    10006: '帮助操作 #10006',
    10007: '帮助操作 #10007',
    10008: '铲除',
};
// ============ 操作限制相关 ============
function getBadDailyStateFile() {
    const accountId = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`friend-bad-state-${token}.json`);
}
function loadBadDailyStop(today) {
    const state = readJsonFile(getBadDailyStateFile(), () => ({}));
    return Number(state?.version) === BAD_DAILY_STATE_VERSION
        && String(state?.date || '') === today
        && state?.stopped === true;
}
function persistBadDailyStop(today) {
    writeJsonFileAtomic(getBadDailyStateFile(), {
        version: BAD_DAILY_STATE_VERSION,
        date: today,
        stopped: true,
    });
}
/**
 * 检查是否需要重置每日限制 (0点刷新)
 */
function checkDailyReset() {
    const today = getSystemDateKey();
    if (lastResetDate !== today) {
        if (lastResetDate !== '') {
            log('系统', '跨日重置，清空操作限制缓存');
        }
        operationLimits.clear();
        canGetHelpExp = true;
        badOperationLimitReached = loadBadDailyStop(today);
        if (helpAutoDisabledByLimit) {
            helpAutoDisabledByLimit = false;
            log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
                module: 'friend',
                event: '好友巡查循环',
                result: 'ok',
            });
        }
        lastResetDate = today;
    }
}
function isBadOperationLimitReached() {
    checkDailyReset();
    return badOperationLimitReached;
}
function markBadOperationLimitReached(method = '') {
    checkDailyReset();
    if (badOperationLimitReached)
        return false;
    badOperationLimitReached = true;
    try {
        persistBadDailyStop(lastResetDate || getSystemDateKey());
    }
    catch (e) {
        logWarn('好友', `保存当日捣乱停用状态失败: ${e.message}`);
    }
    log('好友', '今日放虫/放草次数已达上限，停止两类操作', {
        module: 'friend',
        event: '放虫放草次数上限',
        result: 'limit',
        code: 1001046,
        method: String(method || ''),
    });
    return true;
}
function autoDisableHelpByExpLimit() {
    if (!canGetHelpExp)
        return;
    canGetHelpExp = false;
    helpAutoDisabledByLimit = true;
    log('好友', '今日帮助经验已达上限，自动停止帮忙', {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
    });
}
/**
 * 更新操作限制状态
 */
function updateOperationLimits(limits) {
    if (!limits || limits.length === 0)
        return;
    checkDailyReset();
    for (const limit of limits) {
        const id = toNum(limit.id);
        if (id > 0) {
            const data = {
                dayTimes: toNum(limit.day_times),
                dayTimesLimit: toNum(limit.day_times_lt),
                dayExpTimes: toNum(limit.day_exp_times),
                dayExpTimesLimit: toNum(limit.day_ex_times_lt), // 协议字段名为 day_ex_times_lt
            };
            operationLimits.set(id, data);
            if (id === BAD_SHARED_LIMIT_ID && data.dayTimesLimit > 0 && data.dayTimes >= data.dayTimesLimit) {
                markBadOperationLimitReached('operation_limit');
            }
        }
    }
}
function canGetExpByCandidates(opIds = []) {
    const ids = Array.isArray(opIds) ? opIds : [opIds];
    for (const id of ids) {
        if (canGetExp(toNum(id)))
            return true;
    }
    return false;
}
/**
 * 检查某操作是否还能获得经验
 */
function canGetExp(opId) {
    const limit = operationLimits.get(opId);
    if (!limit)
        return false; // 没有限制信息，保守起见不帮助（等待限制数据）
    if (limit.dayExpTimesLimit <= 0)
        return true; // 没有经验上限
    return limit.dayExpTimes < limit.dayExpTimesLimit;
}
/**
 * 检查某操作是否还有次数
 */
function canOperate(opId) {
    checkDailyReset();
    if ((opId === BAD_SHARED_LIMIT_ID || opId === 10004) && badOperationLimitReached)
        return false;
    const limit = operationLimits.get(opId);
    if (!limit)
        return true;
    if (limit.dayTimesLimit <= 0)
        return true;
    return limit.dayTimes < limit.dayTimesLimit;
}
/**
 * 获取某操作剩余次数
 */
function getRemainingTimes(opId) {
    checkDailyReset();
    if ((opId === BAD_SHARED_LIMIT_ID || opId === 10004) && badOperationLimitReached)
        return 0;
    const limit = operationLimits.get(opId);
    if (!limit || limit.dayTimesLimit <= 0)
        return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}
function getRemainingBadOperationTimes() {
    checkDailyReset();
    if (badOperationLimitReached)
        return 0;
    const limit = operationLimits.get(BAD_SHARED_LIMIT_ID);
    if (!limit || limit.dayTimesLimit <= 0)
        return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}
/**
 * 获取操作限制详情 (供管理面板使用)
 */
function getOperationLimits() {
    const result = {};
    for (const id of [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008]) {
        const limit = operationLimits.get(id);
        if (limit) {
            result[id] = {
                name: OP_NAMES[id] || `#${id}`,
                ...limit,
                remaining: getRemainingTimes(id),
            };
        }
    }
    return result;
}
// ============ 帮助经验状态访问器 ============
function getCanGetHelpExp() {
    return canGetHelpExp;
}
function setCanGetHelpExp(val) {
    canGetHelpExp = val;
}
// 好友巡查与面板的好友天气扫描共用“进入好友农场”这一游戏状态，
// 扫描靠这个标志让位，保证好友任务优先执行。
function isFriendCheckRunning() {
    return isCheckingFriends;
}
async function checkFriends(options = {}) {
    const state = getUserState();
    if (!isAutomationOn('friend'))
        return false;
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    const helpEnabled = !!isAutomationOn('friend_help');
    const stealEnabled = !!isAutomationOn('friend_steal');
    const badEnabled = !!isAutomationOn('friend_bad');
    const onlyHelp = options.onlyHelp || false;
    const onlySteal = options.onlySteal || false;
    const onlyBad = options.onlyBad || false;
    const ignoreExpLimit = options.ignoreExpLimit || false;
    const effectiveHelpEnabled = onlyHelp ? true : (onlySteal || onlyBad ? false : helpEnabled);
    const effectiveStealEnabled = onlySteal ? true : (onlyHelp || onlyBad ? false : stealEnabled);
    const effectiveBadEnabled = onlyBad ? true : (onlyHelp || onlySteal ? false : badEnabled);
    const hasAnyFriendOp = effectiveHelpEnabled || effectiveStealEnabled || effectiveBadEnabled;
    if (isCheckingFriends || !state.gid || !hasAnyFriendOp)
        return false;
    if (inFriendQuietHours())
        return false;
    isCheckingFriends = true;
    checkDailyReset();
    try {
        const friendsReply = await getAllFriends();
        // 巡查结果同时刷新面板好友列表缓存，避免页面再次请求同一份列表。
        cacheFriendsListFromReply(friendsReply);
        const friends = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友', { module: 'friend', event: '好友扫描', result: 'empty' });
            return false;
        }
        const blacklist = new Set(getFriendBlacklist(accountId));
        // 经验满不帮时，本轮只帮当天缓存已确认是护主犬的好友；缓存没结论的交给每日宠物同步补齐。
        const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
        const protectDogBypassEnabled = !!isAutomationOn('friend_help_protect_dog_ignore_exp_limit');
        const helpAllowedForAll = !stopWhenExpLimit || canGetHelpExp;
        // 一次算清每位好友这轮要做哪几件事，然后每位好友只进一次农场把三件事一起做完。
        const plan = buildFriendVisitPlan({
            friends,
            myGid: state.gid,
            blacklist,
            stealEnabled: effectiveStealEnabled,
            helpEnabled: effectiveHelpEnabled,
            badEnabled: effectiveBadEnabled && !isBadOperationLimitReached(),
            helpAllowedForAll,
            protectDogBypassEnabled,
            getDogState: getFriendDogState,
            badBudget: getRemainingBadOperationTimes(),
            maxBadOnlyVisits: MAX_BAD_ONLY_VISITS_PER_ROUND,
        });
        const totalActions = { steal: 0, farming: 0, putBug: 0, putWeed: 0 };
        if (plan.skippedExpLimit > 0) {
            log('好友', `经验已达上限，本轮跳过 ${plan.skippedExpLimit} 位非护主犬好友（未进农场，其中 ${plan.skippedUnknownDog} 位宠物待同步）`, {
                module: 'friend',
                event: '好友巡查跳过',
                reason: 'protect_dog_cache_filtered',
                count: plan.skippedExpLimit,
                unknownDog: plan.skippedUnknownDog,
            });
        }
        if (plan.visits.length === 0)
            return false;
        log('好友', `开始好友巡查，本轮 ${plan.visits.length} 位（可偷 ${plan.stealCount} / 需帮 ${plan.helpCount} / 纯捣乱 ${plan.badOnlyCount}）`, {
            module: 'friend',
            event: '开始好友巡查',
            count: plan.visits.length,
            steal: plan.stealCount,
            help: plan.helpCount,
            bad: plan.badOnlyCount,
        });
        // 经验在本轮中途满掉之后被跳过的好友数
        let midRoundExpSkipped = 0;
        for (const target of plan.visits) {
            if (target.wantBad) {
                // 纯捣乱的好友都排在队尾，额度一用完这一轮就可以收工
                if (isBadOperationLimitReached() || getRemainingBadOperationTimes() <= 0) {
                    log('好友', '放虫放草次数已用完，停止执行', { module: 'friend', event: '放虫放草次数用完' });
                    break;
                }
            }
            else if (target.wantHelp && !target.wantSteal && stopWhenExpLimit && !canGetHelpExp) {
                // 帮忙是这次进农场的唯一目的，但经验在本轮中途满了：不是护主犬就别进去了
                if (!protectDogBypassEnabled || getFriendDogState(target.gid) !== 'protect') {
                    midRoundExpSkipped += 1;
                    continue;
                }
            }
            try {
                await visitFriend(target, totalActions, state.gid, state.accountId, {
                    allowSteal: target.wantSteal,
                    allowHelp: target.wantHelp,
                    allowBad: target.wantBad,
                    ignoreExpLimit,
                });
            }
            catch (e) {
                log('好友', `巡查好友失败: ${target.name}, 错误: ${e.message}`, {
                    module: 'friend', event: '好友巡查失败', friendName: target.name, error: e.message,
                });
            }
            // 捣乱访问之间放慢一些，其余保持原节奏
            if (target.wantBad)
                await randomDelay(2000, 3500);
            else
                await randomDelay(500, 800);
        }
        if (midRoundExpSkipped > 0) {
            log('好友', `本轮帮助经验在中途达到上限，跳过剩余 ${midRoundExpSkipped} 位非护主犬好友`, {
                module: 'friend', event: '好友巡查跳过', reason: 'exp_limit', count: midRoundExpSkipped,
            });
        }
        // 偷菜后自动出售
        if (totalActions.steal > 0) {
            try {
                await sellAllFruits();
            }
            catch {
                // ignore
            }
        }
        // 生成总结日志
        const summary = [];
        if (totalActions.steal > 0)
            summary.push(`偷${totalActions.steal}`);
        if (totalActions.farming > 0)
            summary.push(`一键务农${totalActions.farming}`);
        if (totalActions.putBug > 0)
            summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0)
            summary.push(`放草${totalActions.putWeed}`);
        const totalVisited = plan.visits.length;
        if (summary.length > 0) {
            log('好友', `巡查完成 → ${summary.join('/')}`, {
                module: 'friend', event: '好友巡查循环', result: 'ok', visited: totalVisited, summary
            });
        }
        return summary.length > 0;
    }
    catch (err) {
        logWarn('好友', `巡查异常: ${err.message}`);
        return false;
    }
    finally {
        isCheckingFriends = false;
    }
}
// ============ 循环控制 ============
/**
 * 好友巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function friendCheckLoop() {
    if (externalSchedulerMode)
        return;
    if (!friendLoopRunning)
        return;
    await checkFriends();
    if (!friendLoopRunning)
        return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, CONFIG.friendCheckInterval), () => friendCheckLoop());
}
function startFriendCheckLoop(options = {}) {
    if (friendLoopRunning)
        return;
    externalSchedulerMode = !!options.externalScheduler;
    friendLoopRunning = true;
    // 注册操作限制更新回调，从农场检查中获取限制信息
    setOperationLimitsCallback(updateOperationLimits);
    // 监听好友申请推送 (微信同玩)
    networkEvents.on('friendApplicationReceived', onFriendApplicationReceived);
    if (!externalSchedulerMode) {
        // 延迟 5 秒后启动循环，等待登录和首次农场检查完成
        friendScheduler.setTimeoutTask('friend_check_loop', 5000, () => friendCheckLoop());
    }
    // 启动时检查一次待处理的好友申请
    friendScheduler.setTimeoutTask('friend_check_bootstrap_applications', 3000, () => checkAndAcceptApplications());
    // 好友宠物每日同步（自带启动错峰与定时重试）
    petSyncRef().startFriendPetSyncTimer();
}
function stopFriendCheckLoop() {
    friendLoopRunning = false;
    externalSchedulerMode = false;
    petSyncRef().stopFriendPetSyncTimer();
    flushFriendPetCacheNow();
    clearAllInvalidKnownFriendGidCooldowns();
    clearFriendsListCache();
    networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
    friendScheduler.clearAll();
}
function refreshFriendCheckLoop(delayMs = 200) {
    if (!friendLoopRunning || externalSchedulerMode)
        return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, delayMs), () => friendCheckLoop());
}
// ============ 自动同意好友申请 (微信同玩) ============
let applicationQueue = Promise.resolve();
function getApplicationFilterConfig() {
    return {
        minLevel: getAutoAcceptFriendMinLevel(),
        requireOwnLevel: getAutoAcceptRequireOwnLevel(),
        ownLevel: toNum((getUserState() || {}).level),
        harvestStealEnabled: getAutoAcceptHarvestStealEnabled(),
        harvestPart: getAutoAcceptHarvestStealHarvest(),
        stealPart: getAutoAcceptHarvestStealSteal(),
    };
}
function enqueueApplications(applications) {
    applicationQueue = applicationQueue
        .then(() => processFriendApplications(applications))
        .catch((e) => {
        logWarn('申请', `处理好友申请失败: ${e && e.message ? e.message : e}`);
    });
}
/**
 * 处理服务器推送的好友申请
 */
function onFriendApplicationReceived(applications) {
    if (!Array.isArray(applications) || applications.length === 0)
        return;
    const names = applications.map((a) => a.name || `GID:${toNum(a.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);
    enqueueApplications(applications);
}
/**
 * 检查并处理所有待处理的好友申请
 */
async function checkAndAcceptApplications() {
    if (!isAutomationOn('friend_auto_accept'))
        return;
    try {
        const reply = await getApplications();
        const applications = reply.applications || [];
        if (applications.length === 0)
            return;
        const names = applications.map((a) => a.name || `GID:${toNum(a.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);
        await processFriendApplications(applications);
    }
    catch {
        // 静默失败，可能是 QQ 平台不支持
    }
}
async function processFriendApplications(applications) {
    if (!isAutomationOn('friend_auto_accept'))
        return;
    const list = Array.isArray(applications) ? applications : [];
    if (list.length === 0)
        return;
    const config = getApplicationFilterConfig();
    const checkRatio = isHarvestStealFilterEnabled(config);
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    const blacklist = new Set(getFriendBlacklist(accountId));
    const toAccept = [];
    const toReject = [];
    for (let i = 0; i < list.length; i++) {
        const app = list[i];
        const gid = toNum(app && app.gid);
        const name = (app && app.name) || `GID:${gid}`;
        const level = toNum(app && app.level);
        if (!gid)
            continue;
        if (blacklist.has(gid)) {
            toReject.push({ gid, name, reason: '已在本地黑名单' });
            continue;
        }
        const levelDecision = evaluateLevelFilter(level, config);
        if (levelDecision.action === 'reject') {
            toReject.push({ gid, name, reason: levelDecision.reason || '等级不足' });
            continue;
        }
        if (!checkRatio) {
            toAccept.push(gid);
            continue;
        }
        try {
            const career = await getCareerInfo(gid);
            const ratioDecision = evaluateHarvestStealFilter(career.harvest, career.steal, config);
            if (ratioDecision.action === 'reject') {
                toReject.push({ gid, name, reason: ratioDecision.reason || '收偷比不足' });
            }
            else {
                toAccept.push(gid);
            }
        }
        catch (e) {
            logWarn('申请', `${name} 生涯查询失败，暂不处理: ${e && e.message ? e.message : e}`);
        }
        if (i < list.length - 1 && checkRatio) {
            await randomDelay(150, 300);
        }
    }
    for (const item of toReject) {
        log('申请', `拒绝 ${item.name}: ${item.reason}`);
    }
    await rejectFriendsWithRetry(toReject.map((item) => item.gid));
    await acceptFriendsWithRetry(toAccept);
}
async function rejectFriendsWithRetry(gids) {
    if (gids.length === 0)
        return;
    try {
        await rejectFriends(gids);
        log('申请', `已拒绝 ${gids.length} 人`);
    }
    catch (e) {
        logWarn('申请', `拒绝失败: ${e.message}`);
    }
}
/**
 * 同意好友申请 (带重试)
 */
async function acceptFriendsWithRetry(gids) {
    if (gids.length === 0)
        return;
    try {
        const reply = await acceptFriends(gids);
        const friends = reply.friends || [];
        if (friends.length > 0) {
            const names = friends.map((f) => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
            log('申请', `已同意 ${friends.length} 人: ${names}`);
        }
    }
    catch (e) {
        logWarn('申请', `同意失败: ${e.message}`);
    }
}
// ============ 公开状态查询 ============
// 检查帮助经验是否已达上限（用于外部判断是否需要执行帮助巡查）
function isHelpExpLimitReached() {
    return helpAutoDisabledByLimit;
}
//# sourceMappingURL=scheduler.js.map