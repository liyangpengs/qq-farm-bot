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
exports.checkFriends = checkFriends;
exports.startFriendCheckLoop = startFriendCheckLoop;
exports.stopFriendCheckLoop = stopFriendCheckLoop;
exports.refreshFriendCheckLoop = refreshFriendCheckLoop;
exports.onFriendApplicationReceived = onFriendApplicationReceived;
exports.runBadOnceOnStartup = runBadOnceOnStartup;
exports.isHelpExpLimitReached = isHelpExpLimitReached;
const { CONFIG } = require('../../config/config');
const crypto = require('node:crypto');
const { getUserState, networkEvents } = require('../../utils/network');
const { toNum, getSystemDateKey, log, logWarn, randomDelay } = require('../../utils/utils');
const { getDataFile } = require('../../config/runtime-paths');
const { createScheduler } = require('../scheduler');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');
const { setOperationLimitsCallback } = require('../farm');
const { isAutomationOn, getFriendBlacklist, } = require('../../models/store');
const { sellAllFruits } = require('../warehouse');
const { getAllFriends, acceptFriends, getApplications, } = require('./api');
const { extractReplyFriends, clearAllInvalidKnownFriendGidCooldowns, } = require('./gid-manager');
const { visitFriend, visitFriendForSteal, visitFriendForHelp, inFriendQuietHours, clearFriendsListCache, } = require('./visit-strategy');
// ============ 内部状态 ============
let isCheckingFriends = false;
let friendLoopRunning = false;
let externalSchedulerMode = false;
let lastResetDate = ''; // 上次重置日期 (YYYY-MM-DD)
const friendScheduler = createScheduler('friend');
const operationLimits = new Map();
let canGetHelpExp = true;
let helpAutoDisabledByLimit = false;
let badExecutedOnStartup = false;
let badOperationLimitReached = false;
// Captured PutWeeds/PutInsects replies both consume operation 10003.
// PutInsects additionally reports 10004, but 10003 is the shared daily quota.
const BAD_SHARED_LIMIT_ID = 10003;
const BAD_DAILY_STATE_VERSION = 1;
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
        const friends = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友', { module: 'friend', event: '好友扫描', result: 'empty' });
            return false;
        }
        const blacklist = new Set(getFriendBlacklist(accountId));
        const stealFriends = [];
        const helpFriends = [];
        const visitedGids = new Set();
        for (const f of friends) {
            const gid = toNum(f.gid);
            if (gid === state.gid)
                continue;
            if (visitedGids.has(gid))
                continue;
            if (blacklist.has(gid))
                continue;
            const name = f.remark || f.name || `GID:${gid}`;
            const p = f.plant;
            const stealNum = p ? toNum(p.steal_plant_num) : 0;
            const dryNum = p ? toNum(p.dry_num) : 0;
            const weedNum = p ? toNum(p.weed_num) : 0;
            const insectNum = p ? toNum(p.insect_num) : 0;
            if (stealNum > 0 && effectiveStealEnabled) {
                stealFriends.push({ gid, name, stealNum });
            }
            if ((dryNum > 0 || weedNum > 0 || insectNum > 0) && effectiveHelpEnabled) {
                helpFriends.push({ gid, name, dryNum, weedNum, insectNum });
            }
            visitedGids.add(gid);
        }
        // 排序：偷菜多的优先
        stealFriends.sort((a, b) => b.stealNum - a.stealNum);
        // 排序：帮助需求多的优先
        helpFriends.sort((a, b) => {
            const helpA = a.dryNum + a.weedNum + a.insectNum;
            const helpB = b.dryNum + b.weedNum + b.insectNum;
            return helpB - helpA;
        });
        const totalActions = { steal: 0, farming: 0, putBug: 0, putWeed: 0 };
        // 第二阶段：批量偷菜
        if (stealFriends.length > 0 && effectiveStealEnabled) {
            // log('好友', `开始批量偷菜，共 ${stealFriends.length} 个好友有可偷`, {
            //     module: 'friend', event: '开始批量偷菜', count: stealFriends.length
            // });
            for (const friend of stealFriends) {
                try {
                    await visitFriendForSteal(friend, totalActions, state.gid, state.accountId);
                }
                catch {
                    // 单个好友失败不影响整体
                }
                await randomDelay(500, 800);
            }
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
        // 第三阶段：批量帮助
        if (helpFriends.length > 0 && effectiveHelpEnabled) {
            log('好友', `开始批量帮助，共 ${helpFriends.length} 个好友需要帮助`, {
                module: 'friend', event: '开始批量帮助', count: helpFriends.length
            });
            for (let i = 0; i < helpFriends.length; i++) {
                const friend = helpFriends[i];
                log('好友', `批量帮助第 ${i + 1}/${helpFriends.length} 个好友: ${friend.name}`, { module: 'friend', event: '批量帮助开始', index: i + 1, total: helpFriends.length, friendName: friend.name });
                // 检查是否还能获得帮助经验
                // const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit');
                const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
                if (stopWhenExpLimit && !canGetHelpExp) {
                    log('好友', `批量帮助中断：经验已达上限`, { module: 'friend', event: '批量帮助中断', reason: 'exp_limit' });
                    break;
                }
                try {
                    // await visitFriendForHelp(friend, totalActions, state.gid, state.accountId);
                    await visitFriendForHelp(friend, totalActions, state.gid, state.accountId, ignoreExpLimit);
                    log('好友', `批量帮助第 ${i + 1} 个好友完成: ${friend.name}`, { module: 'friend', event: '批量帮助完成', index: i + 1, friendName: friend.name });
                }
                catch (e) {
                    log('好友', `批量帮助第 ${i + 1} 个好友失败: ${friend.name}, 错误: ${e.message}`, { module: 'friend', event: '批量帮助失败', index: i + 1, friendName: friend.name, error: e.message });
                }
                await randomDelay(500, 800);
            }
            log('好友', '批量帮助循环结束', { module: 'friend', event: '批量帮助结束' });
        }
        // 第四阶段：批量捣乱（放虫放草）
        if (effectiveBadEnabled && !isBadOperationLimitReached()) {
            log('好友', '开始自动放虫放草', { module: 'friend', event: '开始自动放虫放草' });
            const badFriends = [];
            const badVisitedGids = new Set();
            for (const f of friends) {
                const gid = toNum(f.gid);
                if (gid === state.gid)
                    continue;
                if (badVisitedGids.has(gid))
                    continue;
                if (blacklist.has(gid))
                    continue;
                const name = f.remark || f.name || `GID:${gid}`;
                const p = f.plant;
                const stealNum = p ? toNum(p.steal_plant_num) : 0;
                const dryNum = p ? toNum(p.dry_num) : 0;
                const weedNum = p ? toNum(p.weed_num) : 0;
                const insectNum = p ? toNum(p.insect_num) : 0;
                // 只没有可偷、可帮助的好友才考虑捣乱
                if (stealNum === 0 && dryNum === 0 && weedNum === 0 && insectNum === 0) {
                    const level = toNum(f.level);
                    badFriends.push({ gid, name, level });
                }
                badVisitedGids.add(gid);
            }
            // 按等级降序排序，优先处理等级高的好友
            badFriends.sort((a, b) => b.level - a.level);
            // 只取等级最高的前20个
            const topBadFriends = badFriends.slice(0, 20);
            if (topBadFriends.length > 0) {
                log('好友', `找到 ${badFriends.length} 个可捣乱的好友，处理等级最高的前${topBadFriends.length}个`, { module: 'friend', event: '放虫放草好友列表', totalCount: badFriends.length, topCount: topBadFriends.length });
                for (let i = 0; i < topBadFriends.length; i++) {
                    const friend = topBadFriends[i];
                    if (isBadOperationLimitReached())
                        break;
                    // 检查是否还有捣乱次数
                    if (getRemainingBadOperationTimes() <= 0) {
                        log('好友', `放虫放草次数已用完，停止执行`, { module: 'friend', event: '放虫放草次数用完' });
                        break;
                    }
                    try {
                        await visitFriend(friend, totalActions, state.gid, state.accountId);
                    }
                    catch {
                        // 单个好友失败不影响整体
                    }
                    if (isBadOperationLimitReached())
                        break;
                    await randomDelay(2000, 3500);
                }
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
        const totalVisited = stealFriends.length + helpFriends.length;
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
}
function stopFriendCheckLoop() {
    friendLoopRunning = false;
    externalSchedulerMode = false;
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
/**
 * 处理服务器推送的好友申请
 */
function onFriendApplicationReceived(applications) {
    const names = applications.map((a) => a.name || `GID:${toNum(a.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);
    // 自动同意
    const gids = applications.map((a) => toNum(a.gid));
    acceptFriendsWithRetry(gids);
}
/**
 * 检查并同意所有待处理的好友申请
 */
async function checkAndAcceptApplications() {
    try {
        const reply = await getApplications();
        const applications = reply.applications || [];
        if (applications.length === 0)
            return;
        const names = applications.map((a) => a.name || `GID:${toNum(a.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);
        const gids = applications.map((a) => toNum(a.gid));
        await acceptFriendsWithRetry(gids);
    }
    catch {
        // 静默失败，可能是 QQ 平台不支持
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
// ============ 启动时执行一次放虫放草 ============
async function runBadOnceOnStartup() {
    if (badExecutedOnStartup) {
        return;
    }
    const autoBadEnabled = isAutomationOn('friend_bad');
    if (!autoBadEnabled) {
        return;
    }
    const state = getUserState();
    if (!state.gid) {
        log('好友', '用户未登录，无法执行放虫放草', { module: 'friend', event: '放虫放草未登录' });
        return;
    }
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    if (isBadOperationLimitReached())
        return;
    if (isCheckingFriends) {
        friendScheduler.setTimeoutTask('bad_startup_once_retry', 5000, () => runBadOnceOnStartup());
        return;
    }
    isCheckingFriends = true;
    log('好友', '========== 启动时放虫放草开始 ==========', { module: 'friend', event: '启动放虫放草开始' });
    try {
        const friendsReply = await getAllFriends();
        const friends = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友，放虫放草结束', { module: 'friend', event: '没有游戏好友' });
            return;
        }
        const blacklist = new Set(getFriendBlacklist(accountId));
        const badFriends = [];
        const visitedGids = new Set();
        // 筛选可捣乱的好友（排除成熟植物的好友）
        for (const f of friends) {
            const gid = toNum(f.gid);
            if (gid === state.gid)
                continue;
            if (visitedGids.has(gid))
                continue;
            if (blacklist.has(gid))
                continue;
            const name = f.remark || f.name || `GID:${gid}`;
            const p = f.plant;
            const stealNum = p ? toNum(p.steal_plant_num) : 0;
            const dryNum = p ? toNum(p.dry_num) : 0;
            const weedNum = p ? toNum(p.weed_num) : 0;
            const insectNum = p ? toNum(p.insect_num) : 0;
            // 只没有可偷、可帮助的好友才考虑捣乱
            if (stealNum === 0 && dryNum === 0 && weedNum === 0 && insectNum === 0) {
                const level = toNum(f.level);
                badFriends.push({ gid, name, level });
            }
            visitedGids.add(gid);
        }
        // 按等级降序排序，优先处理等级高的好友
        badFriends.sort((a, b) => b.level - a.level);
        // 只取等级最高的前20个
        const topBadFriends = badFriends.slice(0, 20);
        log('好友', `找到 ${badFriends.length} 个可捣乱的好友，处理等级最高的前${topBadFriends.length}个`, { module: 'friend', event: '放虫放草好友列表', totalCount: badFriends.length, topCount: topBadFriends.length });
        const totalActions = { steal: 0, farming: 0, putBug: 0, putWeed: 0 };
        let processedCount = 0;
        for (let i = 0; i < topBadFriends.length; i++) {
            const friend = topBadFriends[i];
            if (isBadOperationLimitReached())
                break;
            // 检查是否还有捣乱次数
            if (getRemainingBadOperationTimes() <= 0) {
                log('好友', `放虫放草次数已用完，停止执行。已处理 ${processedCount} 个好友`, { module: 'friend', event: '放虫放草次数用完', processedCount });
                break;
            }
            log('好友', `启动时放虫放草 ${i + 1}/${topBadFriends.length}: ${friend.name} (等级${friend.level})`, { module: 'friend', event: '放虫放草处理好友', index: i + 1, total: topBadFriends.length, friendName: friend.name, level: friend.level });
            try {
                // 使用 visitFriend 函数，类似 V1 版本逻辑
                await visitFriend(friend, totalActions, state.gid);
                processedCount++;
            }
            catch (e) {
                log('好友', `放虫放草失败: ${friend.name}, 错误: ${e.message}`, { module: 'friend', event: '放虫放草失败', friendName: friend.name, error: e.message });
            }
            if (isBadOperationLimitReached())
                break;
            await randomDelay(2000, 3500);
        }
        badExecutedOnStartup = true;
        const summary = [];
        if (totalActions.putBug > 0)
            summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0)
            summary.push(`放草${totalActions.putWeed}`);
        log('好友', `========== 启动时放虫放草结束 ========== 处理${processedCount}人${summary.length > 0 ? ` → ${summary.join('/')}` : ''}`, { module: 'friend', event: '启动放虫放草结束', processedCount, summary });
    }
    catch (err) {
        logWarn('好友', `启动时放虫放草异常: ${err.message}`);
    }
    finally {
        isCheckingFriends = false;
    }
}
// ============ 公开状态查询 ============
// 检查帮助经验是否已达上限（用于外部判断是否需要执行帮助巡查）
function isHelpExpLimitReached() {
    return helpAutoDisabledByLimit;
}
//# sourceMappingURL=scheduler.js.map