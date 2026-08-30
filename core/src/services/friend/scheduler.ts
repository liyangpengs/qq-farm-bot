/**
 * 好友巡查调度 - 循环管理、每日重置、经验限制、自动接受好友、启动捣乱
 */

const { submitAccountTask } = require('../../app/account-task-runner');
const { CONFIG } = require('../../config/config');
const crypto = require('node:crypto');
const { getUserState, networkEvents } = require('../../utils/network');
const { toNum, getSystemDateKey, log, logWarn, randomDelay } = require('../../utils/utils');
const { getDataFile } = require('../../config/runtime-paths');
const { createScheduler } = require('../scheduler');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');
const { setOperationLimitsCallback } = require('../farm');
const {
    isAutomationOn,
    getFriendBlacklist,
    getAutoAcceptFriendMinLevel,
    getAutoAcceptRequireOwnLevel,
    getAutoAcceptHarvestStealEnabled,
    getAutoAcceptHarvestStealHarvest,
    getAutoAcceptHarvestStealSteal,
} = require('../../models/store');
const { sellAllFruits } = require('../warehouse');
const { getCareerInfo } = require('../career');
const {
    getAllFriends,
    acceptFriends,
    rejectFriends,
    getApplications,
} = require('./api');
const {
    isHarvestStealFilterEnabled,
    evaluateLevelFilter,
    evaluateHarvestStealFilter,
} = require('./application-filter');
const {
    extractReplyFriends,
    clearAllInvalidKnownFriendGidCooldowns,
} = require('./gid-manager');
const {
    visitFriend,
    inFriendQuietHours,
    cacheFriendsListFromReply,
    clearFriendsListCache,
} = require('./visit-strategy');
const { buildFriendVisitPlan } = require('./visit-plan');
const { getFriendDogState, flushFriendPetCacheNow } = require('./pet-cache');

function petSyncRef(): any {
    return require('./pet-sync');
}

// ============ 内部状态 ============
let isCheckingFriends: boolean = false;
let friendLoopRunning: boolean = false;
let externalSchedulerMode: boolean = false;
let lastResetDate: string = '';  // 上次重置日期 (YYYY-MM-DD)
const friendScheduler: any = createScheduler('friend');

const operationLimits: Map<number, any> = new Map();

let canGetHelpExp: boolean = true;
let helpAutoDisabledByLimit: boolean = false;
let badOperationLimitReached: boolean = false;

// Captured PutWeeds/PutInsects replies both consume operation 10003.
// PutInsects additionally reports 10004, but 10003 is the shared daily quota.
const BAD_SHARED_LIMIT_ID: number = 10003;
const BAD_DAILY_STATE_VERSION: number = 1;
const MAX_BAD_ONLY_VISITS_PER_ROUND: number = 20;

const OP_NAMES: Record<number, string> = {
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

function getBadDailyStateFile(): string {
    const accountId: string = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token: string = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`friend-bad-state-${token}.json`);
}

function loadBadDailyStop(today: string): boolean {
    const state: any = readJsonFile(getBadDailyStateFile(), () => ({}));
    return Number(state?.version) === BAD_DAILY_STATE_VERSION
        && String(state?.date || '') === today
        && state?.stopped === true;
}

function persistBadDailyStop(today: string): void {
    writeJsonFileAtomic(getBadDailyStateFile(), {
        version: BAD_DAILY_STATE_VERSION,
        date: today,
        stopped: true,
    });
}

/**
 * 检查是否需要重置每日限制 (0点刷新)
 */
export function checkDailyReset(): void {
    const today: string = getSystemDateKey();
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

export function isBadOperationLimitReached(): boolean {
    checkDailyReset();
    return badOperationLimitReached;
}

export function markBadOperationLimitReached(method: string = ''): boolean {
    checkDailyReset();
    if (badOperationLimitReached) return false;
    badOperationLimitReached = true;
    try {
        persistBadDailyStop(lastResetDate || getSystemDateKey());
    } catch (e: any) {
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

export function autoDisableHelpByExpLimit(): void {
    if (!canGetHelpExp) return;
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
export function updateOperationLimits(limits: any[]): void {
    if (!limits || limits.length === 0) return;
    checkDailyReset();
    for (const limit of limits) {
        const id: number = toNum(limit.id);
        if (id > 0) {
            const data: any = {
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

export function canGetExpByCandidates(opIds: number[] = []): boolean {
    const ids: number[] = Array.isArray(opIds) ? opIds : [opIds];
    for (const id of ids) {
        if (canGetExp(toNum(id))) return true;
    }
    return false;
}

/**
 * 检查某操作是否还能获得经验
 */
export function canGetExp(opId: number): boolean {
    const limit: any = operationLimits.get(opId);
    if (!limit) return false;  // 没有限制信息，保守起见不帮助（等待限制数据）
    if (limit.dayExpTimesLimit <= 0) return true;  // 没有经验上限
    return limit.dayExpTimes < limit.dayExpTimesLimit;
}

/**
 * 检查某操作是否还有次数
 */
export function canOperate(opId: number): boolean {
    checkDailyReset();
    if ((opId === BAD_SHARED_LIMIT_ID || opId === 10004) && badOperationLimitReached) return false;
    const limit: any = operationLimits.get(opId);
    if (!limit) return true;
    if (limit.dayTimesLimit <= 0) return true;
    return limit.dayTimes < limit.dayTimesLimit;
}

/**
 * 获取某操作剩余次数
 */
export function getRemainingTimes(opId: number): number {
    checkDailyReset();
    if ((opId === BAD_SHARED_LIMIT_ID || opId === 10004) && badOperationLimitReached) return 0;
    const limit: any = operationLimits.get(opId);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

export function getRemainingBadOperationTimes(): number {
    checkDailyReset();
    if (badOperationLimitReached) return 0;
    const limit: any = operationLimits.get(BAD_SHARED_LIMIT_ID);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

/**
 * 获取操作限制详情 (供管理面板使用)
 */
export function getOperationLimits(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const id of [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008]) {
        const limit: any = operationLimits.get(id);
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

export function getCanGetHelpExp(): boolean {
    return canGetHelpExp;
}

export function setCanGetHelpExp(val: boolean): void {
    canGetHelpExp = val;
}

// ============ 好友巡查主循环 ============

interface CheckFriendsOptions {
    onlyHelp?: boolean;
    onlySteal?: boolean;
    onlyBad?: boolean;
    ignoreExpLimit?: boolean;
    signal?: AbortSignal;
}

export function isFriendCheckRunning(): boolean {
    return isCheckingFriends;
}

export async function checkFriends(options: CheckFriendsOptions = {}): Promise<boolean> {
    const signal = options.signal;
    if (signal?.aborted) return false;

    const state: any = getUserState();
    if (!isAutomationOn('friend')) return false;

    const accountId: string = process.env.FARM_ACCOUNT_ID || '';

    const helpEnabled: boolean = !!isAutomationOn('friend_help');
    const stealEnabled: boolean = !!isAutomationOn('friend_steal');
    const badEnabled: boolean = !!isAutomationOn('friend_bad');

    const onlyHelp: boolean = options.onlyHelp || false;
    const onlySteal: boolean = options.onlySteal || false;
    const onlyBad: boolean = options.onlyBad || false;
    const ignoreExpLimit: boolean = options.ignoreExpLimit || false;

    const effectiveHelpEnabled: boolean = onlyHelp ? true : (onlySteal || onlyBad ? false : helpEnabled);
    const effectiveStealEnabled: boolean = onlySteal ? true : (onlyHelp || onlyBad ? false : stealEnabled);
    const effectiveBadEnabled: boolean = onlyBad ? true : (onlyHelp || onlySteal ? false : badEnabled);

    const hasAnyFriendOp: boolean = effectiveHelpEnabled || effectiveStealEnabled || effectiveBadEnabled;
    if (isCheckingFriends || !state.gid || !hasAnyFriendOp) return false;
    if (inFriendQuietHours()) return false;

    isCheckingFriends = true;
    checkDailyReset();

    try {
        const friendsReply: any = await submitAccountTask(
            'friend.phase.get-all-friends',
            () => getAllFriends(),
            { priority: 'scheduled', dedupeKey: 'friend.phase.get-all-friends' },
        );
        if (signal?.aborted) return false;
        // 巡查结果同时刷新面板好友列表缓存，避免页面再次请求同一份列表。
        cacheFriendsListFromReply(friendsReply);
        const friends: any[] = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友', { module: 'friend', event: '好友扫描', result: 'empty' });
            return false;
        }

        const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));

        const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
        const protectDogBypassEnabled = !!isAutomationOn('friend_help_protect_dog_ignore_exp_limit');
        const plan: any = buildFriendVisitPlan({
            friends,
            myGid: state.gid,
            blacklist,
            stealEnabled: effectiveStealEnabled,
            helpEnabled: effectiveHelpEnabled,
            badEnabled: effectiveBadEnabled && !isBadOperationLimitReached(),
            helpAllowedForAll: !stopWhenExpLimit || canGetHelpExp,
            protectDogBypassEnabled,
            getDogState: getFriendDogState,
            badBudget: getRemainingBadOperationTimes(),
            maxBadOnlyVisits: MAX_BAD_ONLY_VISITS_PER_ROUND,
        });

        if (plan.skippedExpLimit > 0) {
            log('好友', `经验已达上限，本轮跳过 ${plan.skippedExpLimit} 位非护主犬好友（未进农场，其中 ${plan.skippedUnknownDog} 位宠物待同步）`, {
                module: 'friend',
                event: '好友巡查跳过',
                reason: 'protect_dog_cache_filtered',
                count: plan.skippedExpLimit,
                unknownDog: plan.skippedUnknownDog,
            });
        }
        if (plan.visits.length === 0) return false;

        log('好友', `开始好友巡查，本轮 ${plan.visits.length} 位（可偷 ${plan.stealCount} / 需帮 ${plan.helpCount} / 纯捣乱 ${plan.badOnlyCount}）`, {
            module: 'friend',
            event: '开始好友巡查',
            count: plan.visits.length,
            steal: plan.stealCount,
            help: plan.helpCount,
            bad: plan.badOnlyCount,
        });

        const totalActions: any = { steal: 0, farming: 0, putBug: 0, putWeed: 0 };
        let midRoundExpSkipped = 0;
        let visitedCount = 0;

        for (const target of plan.visits) {
            if (signal?.aborted) break;
            if (target.wantBad) {
                if (isBadOperationLimitReached() || getRemainingBadOperationTimes() <= 0) break;
            } else if (target.wantHelp && !target.wantSteal && stopWhenExpLimit && !canGetHelpExp) {
                if (!protectDogBypassEnabled || getFriendDogState(target.gid) !== 'protect') {
                    midRoundExpSkipped += 1;
                    continue;
                }
            }

            try {
                await submitAccountTask(
                    `friend.visit:${target.gid}`,
                    () => visitFriend(target, totalActions, state.gid, state.accountId, {
                        allowSteal: target.wantSteal,
                        allowHelp: target.wantHelp,
                        allowBad: target.wantBad,
                        ignoreExpLimit,
                    }),
                    { priority: 'scheduled' },
                );
                visitedCount += 1;
            } catch (e: any) {
                if (!signal?.aborted) {
                    log('好友', `巡查好友失败: ${target.name}, 错误: ${e.message}`, {
                        module: 'friend',
                        event: '好友巡查失败',
                        friendName: target.name,
                        error: e.message,
                    });
                }
            }

            if (signal?.aborted) break;
            if (target.wantBad) await randomDelay(2000, 3500);
            else await randomDelay(500, 800);
        }

        if (signal?.aborted) return false;
        if (midRoundExpSkipped > 0) {
            log('好友', `本轮帮助经验在中途达到上限，跳过剩余 ${midRoundExpSkipped} 位非护主犬好友`, {
                module: 'friend',
                event: '好友巡查跳过',
                reason: 'exp_limit',
                count: midRoundExpSkipped,
            });
        }

        if (totalActions.steal > 0) {
            try {
                await submitAccountTask('friend.scan.sell', sellAllFruits, {
                    priority: 'scheduled',
                    dedupeKey: 'friend.scan.sell',
                });
            } catch {}
        }

        const summary: string[] = [];
        if (totalActions.steal > 0) summary.push(`偷${totalActions.steal}`);
        if (totalActions.farming > 0) summary.push(`一键务农${totalActions.farming}`);
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);

        if (summary.length > 0) {
            log('好友', `巡查完成 → ${summary.join('/')}`, {
                module: 'friend',
                event: '好友巡查循环',
                result: 'ok',
                visited: visitedCount,
                summary,
            });
        }
        return summary.length > 0;

    } catch (err: any) {
        logWarn('好友', `巡查异常: ${err.message}`);
        return false;
    } finally {
        isCheckingFriends = false;
    }
}

// ============ 循环控制 ============

/**
 * 好友巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function friendCheckLoop(): Promise<void> {
    if (externalSchedulerMode) return;
    if (!friendLoopRunning) return;
    await checkFriends();
    if (!friendLoopRunning) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, CONFIG.friendCheckInterval), () => friendCheckLoop());
}

interface StartOptions {
    externalScheduler?: boolean;
}

export function startFriendCheckLoop(options: StartOptions = {}): void {
    if (friendLoopRunning) return;
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
    friendScheduler.setTimeoutTask('friend_check_bootstrap_applications', 3000, () => {
        return submitAccountTask('friend.applications.check', checkAndAcceptApplications, {
            priority: 'event',
            dedupeKey: 'friend.applications.check',
        });
    });

    petSyncRef().startFriendPetSyncTimer();
}

export function stopFriendCheckLoop(): void {
    friendLoopRunning = false;
    externalSchedulerMode = false;
    petSyncRef().stopFriendPetSyncTimer();
    flushFriendPetCacheNow();
    clearAllInvalidKnownFriendGidCooldowns();
    clearFriendsListCache();
    networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
    friendScheduler.clearAll();
}

export function refreshFriendCheckLoop(delayMs: number = 200): void {
    if (!friendLoopRunning || externalSchedulerMode) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, delayMs), () => friendCheckLoop());
}

// ============ 自动同意好友申请 (微信同玩) ============

function getApplicationFilterConfig(): any {
    return {
        minLevel: getAutoAcceptFriendMinLevel(),
        requireOwnLevel: getAutoAcceptRequireOwnLevel(),
        ownLevel: toNum((getUserState() || {}).level),
        harvestStealEnabled: getAutoAcceptHarvestStealEnabled(),
        harvestPart: getAutoAcceptHarvestStealHarvest(),
        stealPart: getAutoAcceptHarvestStealSteal(),
    };
}

function enqueueApplications(applications: any[]): void {
    submitAccountTask(
        'friend.applications.process',
        () => processFriendApplications(applications),
        { priority: 'event', requestClass: 'friend' },
    ).catch((e: any) => {
        logWarn('申请', `处理好友申请失败: ${e && e.message ? e.message : e}`);
    });
}

/**
 * 处理服务器推送的好友申请
 */
export function onFriendApplicationReceived(applications: any[]): void {
    if (!Array.isArray(applications) || applications.length === 0) return;
    const names: string = applications.map((a: any) => a.name || `GID:${toNum(a.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);
    enqueueApplications(applications);
}

/**
 * 检查并处理所有待处理的好友申请
 */
async function checkAndAcceptApplications(): Promise<void> {
    if (!isAutomationOn('friend_auto_accept')) return;
    try {
        const reply: any = await getApplications();
        const applications: any[] = reply.applications || [];
        if (applications.length === 0) return;

        const names: string = applications.map((a: any) => a.name || `GID:${toNum(a.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);
        await processFriendApplications(applications);
    } catch {
        // 静默失败，可能是 QQ 平台不支持
    }
}

async function processFriendApplications(applications: any[]): Promise<void> {
    if (!isAutomationOn('friend_auto_accept')) return;
    const list: any[] = Array.isArray(applications) ? applications : [];
    if (list.length === 0) return;

    const config = getApplicationFilterConfig();
    const checkRatio = isHarvestStealFilterEnabled(config);
    const accountId: string = process.env.FARM_ACCOUNT_ID || '';
    const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));
    const toAccept: number[] = [];
    const toReject: Array<{ gid: number; name: string; reason: string }> = [];

    for (let i = 0; i < list.length; i++) {
        const app: any = list[i];
        const gid: number = toNum(app && app.gid);
        const name: string = (app && app.name) || `GID:${gid}`;
        const level: number = toNum(app && app.level);
        if (!gid) continue;

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
            } else {
                toAccept.push(gid);
            }
        } catch (e: any) {
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

async function rejectFriendsWithRetry(gids: number[]): Promise<void> {
    if (gids.length === 0) return;
    try {
        await rejectFriends(gids);
        log('申请', `已拒绝 ${gids.length} 人`);
    } catch (e: any) {
        logWarn('申请', `拒绝失败: ${e.message}`);
    }
}

/**
 * 同意好友申请 (带重试)
 */
async function acceptFriendsWithRetry(gids: number[]): Promise<void> {
    if (gids.length === 0) return;
    try {
        const reply: any = await acceptFriends(gids);
        const friends: any[] = reply.friends || [];
        if (friends.length > 0) {
            const names: string = friends.map((f: any) => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
            log('申请', `已同意 ${friends.length} 人: ${names}`);
        }
    } catch (e: any) {
        logWarn('申请', `同意失败: ${e.message}`);
    }
}

// ============ 公开状态查询 ============

// 检查帮助经验是否已达上限（用于外部判断是否需要执行帮助巡查）
export function isHelpExpLimitReached(): boolean {
    return helpAutoDisabledByLimit;
}

