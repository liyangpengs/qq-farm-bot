export {};
/**
 * 子进程 Worker - 负责运行单个账号的挂机逻辑
 */
const { parentPort, workerData } = require('node:worker_threads');

const { CONFIG, updateRuntimeConfig } = require('../config/config');
const { getLevelExpProgress, loadConfigs } = require('../config/gameConfig');
const { getAutomation, getPreferredSeed, getConfigSnapshot, applyConfigSnapshot } = require('../models/store');
const { checkAndClaimEmails } = require('../services/email');
const { getEmailDailyState } = require('../services/email');
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, getLandsDetail, getAvailableSeeds, runFarmOperation, runFertilizerByConfig, fertilizeOwnLand } = require('../services/farm');
const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, getFriendsList, getFriendsListCacheOnly, getFriendLandsDetail, doFriendOperation, deleteFriend } = require('../services/friend');
const { getInteractRecords } = require('../services/interact');
const { processInviteCodes } = require('../services/invite');
const { autoBuyFertilizer, checkAndBuyFertilizerBoth, buyFreeGifts, getFreeGiftDailyState } = require('../services/mall');
const { performDailyMonthCardGift, getMonthCardDailyState } = require('../services/monthcard');
const { performDailyVipGift, getVipDailyState } = require('../services/qqvip');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { checkDailyShareStatus, getShareDailyState } = require('../services/share');
const { refreshActivityWindows } = require('../services/activity-windows');
const { resetSessionGains, recordOperation, initStatsWithPersistence, saveStats } = require('../services/stats');
const { initStatusBar, setStatusPlatform, statusData } = require('../services/status');
const { setRecordGoldExpHook } = require('../services/status');
const { cleanupTaskSystem, checkAndClaimTasks, getTaskClaimDailyState, getTaskDailyStateLikeApp, getGrowthTaskStateLikeApp } = require('../services/task');
const { sellAllFruits, getBag, getBagItems, openFertilizerGiftPacksSilently } = require('../services/warehouse');
const { checkAndClaimDogSkillGifts } = require('../services/dog-skill-gifts');
const { isGatewayHealthyForBusiness, nextBusinessBackoffMs } = require('../utils/low-priority-gate');
const { connect, cleanup, getWs, getUserState, networkEvents, getGatewayLoad } = require('../utils/network');
const { loadProto } = require('../utils/proto');
const { runWithRequestClass } = require('../utils/request-context');
const { setLogHook, log, logWarn, toNum, getSystemDateKey, formatSystemDateTime24 } = require('../utils/utils');

// Extend CONFIG with the unified friend-task interval used by this worker.
interface WorkerRuntimeConfig {
    friendCheckIntervalMin: number;
    friendCheckIntervalMax: number;
    [key: string]: any;
}

const workerConfig = CONFIG as WorkerRuntimeConfig;

if (parentPort && workerData && workerData.accountId && !process.env.FARM_ACCOUNT_ID) {
    process.env.FARM_ACCOUNT_ID = String(workerData.accountId);
}

function sendToMaster(payload: Record<string, any>): void {
    if (process.send) {
        process.send(payload);
        return;
    }
    if (parentPort) {
        parentPort.postMessage(payload);
    }
}

function onMasterMessage(handler: (msg: any) => void): void {
    if (process.send) {
        process.on('message', handler);
    }
    if (parentPort) {
        parentPort.on('message', handler);
    }
}

function exitWorker(code: number = 0): void {
    if (parentPort) {
        try {
            parentPort.close();
        } catch {}
        return;
    }
    process.exit(code);
}

// 捕获日志发送给主进程
setLogHook((tag: string, msg: string, isWarn: boolean, meta: any) => {
    sendToMaster({
        type: 'log',
        data: {
            time: formatSystemDateTime24(),
            tag,
            msg,
            isWarn,
            meta: meta || {},
        }
    });
});

// 捕获金币经验变化
setRecordGoldExpHook((gold: number, exp: number) => {
    // 更新内部统计
    const { recordGoldExp } = require('../services/stats');
    recordGoldExp(gold, exp);

    // 发送给主进程
    sendToMaster({ type: 'stat_update', data: { gold, exp } });
});

let isRunning: boolean = false;
let loginReady: boolean = false;
let appliedConfigRevision: number = 0;
let unifiedSchedulerRunning: boolean = false;
let farmTaskRunning: boolean = false;
let nextFarmRunAt: number = 0;
let friendTaskRunning: boolean = false;
let nextFriendRunAt: number = 0;
// 网关卡住时两条定时任务各自的退避时长（毫秒），0 表示按正常间隔跑
const businessBackoffMs: Record<string, number> = { farm: 0, friend: 0 };
let lastStatusHash: string = '';
let lastStatusSentAt: number = 0;
let onSellGain: ((deltaGold: any) => void) | null = null;
let onFarmHarvested: (() => Promise<void>) | null = null;
let onDogSkillGiftPending: ((count: any) => void) | null = null;
let harvestSellRunning: boolean = false;
let onWsError: ((payload: any) => void) | null = null;
let onDisconnected: ((payload: any) => void) | null = null;
let wsErrorHandledAt: number = 0;
let shutdownStarted: boolean = false;
let runtimeGeneration: number = 0;
let lastDailyRunDate: string = '';
const workerScheduler = createScheduler('worker');

async function runDailyRoutines(force: boolean = false): Promise<void> {
    if (!loginReady) return;
    try {
        await checkAndClaimEmails(force);
        await checkDailyShareStatus(force);
        await performDailyMonthCardGift(force);
        await buyFreeGifts(force);
        await performDailyVipGift(force);
    } catch (e: any) {
        log('系统', `每日任务调度失败: ${e.message}`, { module: 'system', event: '每日任务', result: 'error' });
    }
}

function stopDailyRoutineTimer(): void {
    workerScheduler.clear('daily_routine_interval');
}

function startDailyRoutineTimer(runImmediately: boolean = true): void {
    stopDailyRoutineTimer();
    lastDailyRunDate = getSystemDateKey();
    // 新账号登录后强制执行一次领取
    if (runImmediately) runDailyRoutines(true).catch(() => null);
    workerScheduler.setIntervalTask('daily_routine_interval', 30 * 1000, () => {
        if (!loginReady) return;
        const today = getSystemDateKey();
        if (today === lastDailyRunDate) return;
        lastDailyRunDate = today;
        runDailyRoutines(true).catch(() => null);
    });
}

function normalizeIntervalRangeSec(minSec: any, maxSec: any, fallbackSec: any): { min: number; max: number } {
    const fallback = Math.max(1, Number.parseInt(fallbackSec, 10) || 1);
    let min = Math.max(1, Number.parseInt(minSec, 10) || fallback);
    let max = Math.max(1, Number.parseInt(maxSec, 10) || fallback);
    if (min > max) [min, max] = [max, min];
    return { min, max };
}

function applyIntervalsToRuntime(intervals: any): void {
    const data = (intervals && typeof intervals === 'object') ? intervals : {};

    const farmLegacy = Math.max(1, Number.parseInt(data.farm, 10) || 2);
    const farmRange = normalizeIntervalRangeSec(data.farmMin, data.farmMax, farmLegacy);
    CONFIG.farmCheckIntervalMin = farmRange.min * 1000;
    CONFIG.farmCheckIntervalMax = farmRange.max * 1000;
    CONFIG.farmCheckInterval = CONFIG.farmCheckIntervalMin;

    // 好友帮助、偷菜、放虫放草共用一个好友任务间隔。
    const helpMin = Number.parseInt(data.helpMin, 10) || 12;
    const helpMax = Number.parseInt(data.helpMax, 10) || 15;
    const stealMin = Number.parseInt(data.stealMin, 10) || 12;
    const stealMax = Number.parseInt(data.stealMax, 10) || 15;
    const friendMin = data.friendMin ?? Math.min(helpMin, stealMin);
    const friendMax = data.friendMax ?? Math.min(helpMax, stealMax);
    const friendRange = normalizeIntervalRangeSec(friendMin, friendMax, 12);
    workerConfig.friendCheckIntervalMin = friendRange.min * 1000;
    workerConfig.friendCheckIntervalMax = friendRange.max * 1000;
}

function randomIntervalMs(minMs: number, maxMs: number): number {
    const minSec = Math.max(1, Math.floor(Math.max(1000, Number(minMs) || 1000) / 1000));
    const maxSec = Math.max(minSec, Math.floor(Math.max(1000, Number(maxMs) || minSec * 1000) / 1000));
    if (maxSec === minSec) return minSec * 1000;
    const sec = minSec + Math.floor(Math.random() * (maxSec - minSec + 1));
    return sec * 1000;
}

function resetUnifiedSchedule(): void {
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    const friendMs = randomIntervalMs(
        workerConfig.friendCheckIntervalMin || 12000,
        workerConfig.friendCheckIntervalMax || 15000
    );
    const now = Date.now();
    nextFarmRunAt = now + farmMs;
    nextFriendRunAt = now + friendMs;
    businessBackoffMs.farm = 0;
    businessBackoffMs.friend = 0;
}

const BUSINESS_TICK_LABEL: Record<string, string> = { farm: '农场定时任务', friend: '好友定时任务' };

function describeGatewayStall(load: any): string {
    const parts: string[] = [];
    const misses = Number(load && load.heartbeatMisses) || 0;
    const oldest = Number(load && load.oldestPendingAgeMs) || 0;
    if (misses > 0) parts.push(`心跳漏 ${misses} 次`);
    if (oldest > 0) parts.push(`最老在途 ${(oldest / 1000).toFixed(1)}s`);
    parts.push(`pending=${Number(load && load.pending) || 0}`);
    parts.push(`queued=${Number(load && load.queued) || 0}`);
    return parts.join(', ');
}

/**
 * 网关卡住（心跳漏拍或有在途请求超过 5 秒没回包）时定时任务整轮让路，把连接留给心跳和 ACE 上报。
 * 返回本轮需要推迟的毫秒数，0 表示可以正常跑。日志只在进入/退出退避时各打一次，避免刷屏。
 */
function nextBusinessTickDeferMs(kind: string): number {
    const load = getGatewayLoad();
    if (isGatewayHealthyForBusiness(load)) {
        if (businessBackoffMs[kind] > 0) {
            businessBackoffMs[kind] = 0;
            log('系统', `网关已恢复，${BUSINESS_TICK_LABEL[kind]}回到正常间隔`, {
                module: 'system',
                event: '网关退避',
                result: 'resume',
                requestClass: kind,
            });
        }
        return 0;
    }

    const firstDefer = businessBackoffMs[kind] === 0;
    const backoffMs = nextBusinessBackoffMs(businessBackoffMs[kind]);
    businessBackoffMs[kind] = backoffMs;
    if (firstDefer) {
        logWarn('系统', `网关无回包，${BUSINESS_TICK_LABEL[kind]}退避 ${Math.round(backoffMs / 1000)}s (${describeGatewayStall(load)})`, {
            module: 'system',
            event: '网关退避',
            result: 'defer',
            requestClass: kind,
            backoffMs,
        });
    }
    return backoffMs;
}

async function runFarmTick(auto: any): Promise<void> {
    if (farmTaskRunning) return;
    const farmDeferMs = nextBusinessTickDeferMs('farm');
    if (farmDeferMs > 0) {
        nextFarmRunAt = Date.now() + farmDeferMs;
        return;
    }
    farmTaskRunning = true;
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    try {
        // 自己农场的定时任务统一挂在 farm 班次：优先级高于好友任务，低于用户前台操作。
        await runWithRequestClass('farm', async () => {
            if (auto.farm) await checkFarm();
            if (auto.task) await checkAndClaimTasks();
            if (auto.email) await checkAndClaimEmails();
            if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
        });
    } catch {
        // ignore
    } finally {
        nextFarmRunAt = Date.now() + farmMs;
        farmTaskRunning = false;
    }
}

// ============ 好友统一任务：偷菜、帮助、放虫放草 ============
async function runFriendTick(auto: any): Promise<void> {
    if (friendTaskRunning) return;
    const friendMs = randomIntervalMs(
        workerConfig.friendCheckIntervalMin || 12000,
        workerConfig.friendCheckIntervalMax || 15000
    );
    // friend 总开关仍控制好友任务总入口；关闭时也要推进到期时间，避免调度器每秒空转。
    if (!auto.friend) {
        nextFriendRunAt = Date.now() + friendMs;
        return;
    }

    const friendDeferMs = nextBusinessTickDeferMs('friend');
    if (friendDeferMs > 0) {
        nextFriendRunAt = Date.now() + friendDeferMs;
        return;
    }

    friendTaskRunning = true;
    try {
        // checkFriends 内部保留各自开关、经验上限、黑名单和每日捣乱次数判断。
        // 好友农场任务排在自己农场之后，前台操作永远优先于它。
        await runWithRequestClass('friend', () => checkFriends());
    } catch (e: any) {
        log('系统', `好友统一任务执行失败: ${e.message}`, { module: 'system', event: '好友统一任务', result: 'error' });
    } finally {
        nextFriendRunAt = Date.now() + friendMs;
        friendTaskRunning = false;
    }
}

async function runUnifiedTick(): Promise<void> {
    if (!unifiedSchedulerRunning || !loginReady) return;
    const now = Date.now();
    const dueFarm = now >= nextFarmRunAt;
    const dueFriend = now >= nextFriendRunAt;
    if (!dueFarm && !dueFriend) return;

    const auto = getAutomation();
    // 串行执行而非并行，避免并发请求过多导致超时
    if (dueFarm) await runFarmTick(auto);
    if (dueFriend) await runFriendTick(auto);
}

function scheduleUnifiedNextTick(): void {
    if (!unifiedSchedulerRunning) return;
    workerScheduler.clear('unified_next_tick');
    if (!loginReady) return;

    const now = Date.now();
    const nextAt = Math.min(
        Number(nextFarmRunAt) || (now + 1000),
        Number(nextFriendRunAt) || (now + 1000)
    );
    const delayMs = Math.max(1000, nextAt - now); // 最低 1 秒

    workerScheduler.setTimeoutTask('unified_next_tick', delayMs, async () => {
        try {
            await runUnifiedTick();
        } finally {
            scheduleUnifiedNextTick();
        }
    });
}

function startUnifiedScheduler(): void {
    if (unifiedSchedulerRunning) return;
    unifiedSchedulerRunning = true;
    resetUnifiedSchedule();
    scheduleUnifiedNextTick();
}

function stopUnifiedScheduler(): void {
    unifiedSchedulerRunning = false;
    farmTaskRunning = false;
    friendTaskRunning = false;
    workerScheduler.clear('unified_next_tick');
}

function stopMysteryShopTimer(): void {
    workerScheduler.clear('mystery_shop_initial');
    workerScheduler.clear('mystery_shop_interval');
    workerScheduler.clear('mystery_shop_after_save');
}


/**
 * 登录完成后的启动序列。
 *
 * 以前这里是四个错峰定时器（2s / 8s / 45s / 60s），结果每日礼包和任务要等到登录一分钟后
 * 才领，而且那时农场和好友循环已经在跑，几件事叠在一起反而把连接打满。
 * 现在改成登录动作一结束就**串行**跑完：串行意味着同一时刻只有一个业务请求在飞，
 * 既领得及时，也不会和心跳抢连接。
 */
async function runStartupSequence(canContinue: () => boolean = () => loginReady): Promise<void> {
    if (!loginReady || !canContinue()) return;

    // 这个序列跑在登录初始化的 await 链上（心跳和 ACE 此时已经启动），
    // 抛出去会被 network.ts 当成「登录初始化失败」直接掐掉连接，所以整段自己兜住异常。
    try {
        // 先把主循环挂起来。两个循环都有自己的间隔节流，挂上不等于立刻发请求。
        startFarmCheckLoop({ externalScheduler: true });
        startFriendCheckLoop({ externalScheduler: true });
        startUnifiedScheduler();

        // 登录期要领的东西按 farm 班次串行跑完：邮件 / 每日分享 / 月卡 / 免费礼包 / VIP → 任务 → 神秘商店。
        await runWithRequestClass('farm', async () => {
            if (!loginReady || !canContinue()) return;
            await runDailyRoutines(true);

            if (!loginReady || !canContinue()) return;
            try {
                await checkAndClaimTasks();
            } catch (e: any) {
                log('系统', `登录后领取任务失败: ${e.message}`, { module: 'system', event: '启动序列', result: 'error' });
            }

            if (!loginReady || !canContinue()) return;
            try {
                await runMysteryShopTick();
            } catch {
                // 神秘商店失败不影响启动
            }
        });

        if (!loginReady || !canContinue()) return;
        // 串行部分跑完才挂上后续的周期性定时器，避免刚领完又立刻重复领一遍。
        startDailyRoutineTimer(false);
        startMysteryShopTimer({ runInitial: false });
    } catch (e: any) {
        log('系统', `登录启动序列执行失败: ${e.message}`, { module: 'system', event: '启动序列', result: 'error' });
    }
}

function runMysteryShopTick(): Promise<void> {
    if (!loginReady) return Promise.resolve();
    const {
        isMysteryShopWatchEnabled,
        checkMysteryShopTick,
    } = require('../services/mystery-shop-auto');
    if (!isMysteryShopWatchEnabled(getAutomation())) return Promise.resolve();
    return checkMysteryShopTick().then((result: any) => {
        if (result?.push?.title && result?.push?.content) {
            sendToMaster({ type: 'push_notify', title: result.push.title, content: result.push.content });
        }
    });
}

function startMysteryShopTimer(options: { runInitial?: boolean } = {}): void {
    const {
        isMysteryShopWatchEnabled,
        AUTO_BUY_CHECK_INTERVAL_MS,
        AUTO_BUY_INITIAL_DELAY_MS,
    } = require('../services/mystery-shop-auto');
    stopMysteryShopTimer();
    if (!loginReady || !isMysteryShopWatchEnabled(getAutomation())) return;
    // 启动序列已经串行跑过一次首查时不再重复排首查。
    if (options.runInitial !== false) {
        workerScheduler.setTimeoutTask('mystery_shop_initial', AUTO_BUY_INITIAL_DELAY_MS, () => {
            runMysteryShopTick().catch(() => null);
        });
    }
    workerScheduler.setIntervalTask('mystery_shop_interval', AUTO_BUY_CHECK_INTERVAL_MS, () => {
        runMysteryShopTick().catch(() => null);
    });
}

function applyRuntimeConfig(snapshot: any, syncNow: boolean = false): number {
    const rev = Number((snapshot || {}).__revision || 0);
    if (rev > 0 && rev < appliedConfigRevision) {
        if (syncNow) syncStatus();
        return appliedConfigRevision;
    }

    const prevAuto = getAutomation();
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    if (snapshot && snapshot.systemTimeZone !== undefined) {
        updateRuntimeConfig({ timeZone: snapshot.systemTimeZone });
    }
    if (!loginReady && snapshot && snapshot.systemServerUrl !== undefined) {
        updateRuntimeConfig({ serverUrl: String(snapshot.systemServerUrl || '') });
    }
    if (!loginReady && snapshot && snapshot.systemClientVersion !== undefined) {
        updateRuntimeConfig({ clientVersion: String(snapshot.systemClientVersion || '') });
    }
    applyConfigSnapshot(snapshot || {}, { persist: false, accountId });
    if (rev > appliedConfigRevision) appliedConfigRevision = rev;

    // 优先使用本次下发的间隔，避免 worker 内部 store 漂移导致回退默认值
    const incomingIntervals = (snapshot && snapshot.intervals && typeof snapshot.intervals === 'object')
        ? snapshot.intervals
        : null;
    if (incomingIntervals) {
        applyIntervalsToRuntime(incomingIntervals);
    }

    if (loginReady) {
        refreshFarmCheckLoop(200);
        refreshFriendCheckLoop(200);
        resetUnifiedSchedule();
        scheduleUnifiedNextTick();

        const hasAutomationPayload = !!(snapshot && snapshot.automation && typeof snapshot.automation === 'object');
        if (hasAutomationPayload) {
            const nextAuto = getAutomation();

            const prevFertilizerMode = String(prevAuto && prevAuto.fertilizer ? prevAuto.fertilizer : '').toLowerCase();
            const nextFertilizerMode = String(nextAuto && nextAuto.fertilizer ? nextAuto.fertilizer : '').toLowerCase();
            const fertilizerChanged = prevFertilizerMode !== nextFertilizerMode;
            if (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic' || nextFertilizerMode === 'smart')) {
                workerScheduler.setTimeoutTask('fertilizer_immediate_after_save', 600, async () => {
                    if (!loginReady) return;
                    try {
                        await runFertilizerByConfig([], { skipNormal: true });
                    } catch (e: any) {
                        log('施肥', `保存配置后立即施肥失败: ${e.message}`, {
                            module: 'farm',
                            event: '施肥',
                            result: 'error',
                        });
                    }
                });
            }

            const {
                mysteryShopConfigChanged,
                isMysteryShopWatchEnabled,
                AUTO_BUY_AFTER_SAVE_DELAY_MS,
            } = require('../services/mystery-shop-auto');
            startMysteryShopTimer();
            if (isMysteryShopWatchEnabled(nextAuto) && mysteryShopConfigChanged(prevAuto, nextAuto)) {
                workerScheduler.setTimeoutTask('mystery_shop_after_save', AUTO_BUY_AFTER_SAVE_DELAY_MS, () => {
                    runMysteryShopTick().catch(() => null);
                });
            }
        }
    }

    if (syncNow) syncStatus();
    return appliedConfigRevision;
}

// 接收主进程指令
onMasterMessage(async (msg: any) => {
    try {
        if (msg.type === 'start') {
            await startBot(msg.config);
        } else if (msg.type === 'stop') {
            await stopBot();
        } else if (msg.type === 'api_call') {
            handleApiCall(msg);
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        } else if (msg.type === 'reload_config') {
            if (typeof loadConfigs === 'function') loadConfigs();
        }
    } catch (e: any) {
        sendToMaster({
            type: 'error',
            error: {
                message: String(e?.message || e || 'Worker error'),
                code: e?.code,
                name: String(e?.name || 'Error'),
            },
        });
    }
});

async function startBot(config: any): Promise<void> {
    if (isRunning) return;
    isRunning = true;
    shutdownStarted = false;
    runtimeGeneration += 1;

    const { code, platform, systemTimeZone, systemServerUrl, systemClientVersion } = config;

    if (systemTimeZone !== undefined) updateRuntimeConfig({ timeZone: systemTimeZone });
    if (systemServerUrl !== undefined) updateRuntimeConfig({ serverUrl: String(systemServerUrl || '') });
    if (systemClientVersion !== undefined) updateRuntimeConfig({ clientVersion: String(systemClientVersion || '') });
    CONFIG.platform = platform || 'qq';
    // 注意：间隔配置由 applyIntervalsToRuntime 统一处理，不要在这里覆盖

    await loadProto();

    log('系统', '正在连接服务器...');

    // 加载保存的配置
    applyRuntimeConfig(getConfigSnapshot(), false);

    initStatusBar();
    setStatusPlatform(CONFIG.platform);

    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    onWsError = (payload: any) => {
        if ((Number(payload?.code) || 0) !== 400) return;
        const now = Date.now();
        if (now - wsErrorHandledAt < 4000) return;
        wsErrorHandledAt = now;
        log('系统', '连接被拒绝，可能需要更新 Code');
        sendToMaster({
            type: 'ws_error',
            code: 400,
            message: payload?.message || '',
        });
        if (isRunning) {
            handleTerminalDisconnect({
                source: 'ws_error',
                code: 400,
                reason: payload?.message || '连接被拒绝',
                phase: 'connecting',
            });
        }
    };
    networkEvents.on('ws_error', onWsError);

    if (onDisconnected) {
        networkEvents.off('disconnected', onDisconnected);
    }
    onDisconnected = (payload: any) => {
        handleTerminalDisconnect(payload);
    };
    networkEvents.on('disconnected', onDisconnected);
    networkEvents.on('kickout', onKickout);

    const generation = runtimeGeneration;
    const canContinueLogin = (): boolean => isRunning && !shutdownStarted && generation === runtimeGeneration;
    const onLoginSuccess = async (): Promise<void> => {
        if (!canContinueLogin() || loginReady) return;
        loginReady = true;
        if (onSellGain) {
            networkEvents.off('sell', onSellGain);
        }
        onSellGain = (deltaGold: any) => {
            const delta = Number(deltaGold || 0);
            if (!Number.isFinite(delta) || delta <= 0) return;
            recordOperation('sell', 1);
        };
        networkEvents.on('sell', onSellGain);

        if (onFarmHarvested) {
            networkEvents.off('farmHarvested', onFarmHarvested);
        }
        onFarmHarvested = async () => {
            if (harvestSellRunning) return;
            if (!getAutomation().sell) return;
            harvestSellRunning = true;
            try {
                await sellAllFruits();
            } catch (e: any) {
                log('仓库', `收获后自动出售失败: ${e.message}`, { module: 'warehouse', event: '收获后出售', result: 'error' });
            } finally {
                harvestSellRunning = false;
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        if (onDogSkillGiftPending) {
            networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        }
        onDogSkillGiftPending = (count: any) => {
            const pendingCount = Math.max(0, toNum(count));
            if (pendingCount <= 0 || !loginReady) return;
            checkAndClaimDogSkillGifts(pendingCount).catch(() => null);
        };
        networkEvents.on('dogSkillGiftPending', onDogSkillGiftPending);

        try {
            await refreshActivityWindows();
        } catch (e: any) {
            logWarn('仓库', `活动时间初始化失败: ${e?.message || e}`);
        }
        if (!canContinueLogin()) return;

        // 登录后只拉一次背包，同时初始化点券（1002）和金豆豆（1005）
        try {
            const bagReply = await getBag();
            const items = getBagItems(bagReply);
            let coupon = 0;
            let goldBean = 0;
            for (const it of (items || [])) {
                const id = toNum(it && it.id);
                if (id === 1002) {
                    coupon = toNum(it.count);
                } else if (id === 1005) {
                    goldBean = toNum(it.count);
                }
            }
            const state = getUserState();
            state.coupon = Math.max(0, coupon);
            state.goldBean = Math.max(0, goldBean);
        } catch {
            // ignore
        }
        // 登录成功后，以当前金币/经验/点券作为统计基线，并清空会话增量
        const latest = getUserState();
        const accountId = process.env.FARM_ACCOUNT_ID || '';
        initStatsWithPersistence(accountId, Number(latest.gold || 0), Number(latest.exp || 0), Number(latest.coupon || 0));
        resetSessionGains();

        // 登录成功后启动各模块
        await processInviteCodes();
        if (!canContinueLogin()) return;
        if (getAutomation().fertilizer_gift) {
            await openFertilizerGiftPacksSilently().catch(() => 0);
            if (!canContinueLogin()) return;
        }

        if (!canContinueLogin()) return;
        // 立即发送一次状态，再串行跑启动序列（不阻塞状态上报）
        syncStatus();
        await runStartupSequence(canContinueLogin);
    };

    connect(code, onLoginSuccess);

    // 启动定时状态同步
    workerScheduler.setIntervalTask('status_sync', 3000, syncStatus, { preventOverlap: true });
}

function detachRuntimeListeners(): void {
    networkEvents.off('kickout', onKickout);
    if (onDisconnected) {
        networkEvents.off('disconnected', onDisconnected);
        onDisconnected = null;
    }
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    if (onSellGain) {
        networkEvents.off('sell', onSellGain);
        onSellGain = null;
    }
    if (onFarmHarvested) {
        networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = null;
    }
    if (onDogSkillGiftPending) {
        networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        onDogSkillGiftPending = null;
    }
}

function quiesceBot(reason: string): void {
    shutdownStarted = true;
    runtimeGeneration += 1;
    isRunning = false;
    loginReady = false;
    stopUnifiedScheduler();
    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopDailyRoutineTimer();
    cleanupTaskSystem();
    workerScheduler.clearAll();
    detachRuntimeListeners();
    cleanup(reason);
    syncStatus(true);
}

async function stopBot(): Promise<void> {
    if (!shutdownStarted) {
        saveStats();
        quiesceBot('主动停止');
    }
    exitWorker(0);
}

function handleTerminalDisconnect(payload: any): void {
    if (shutdownStarted) return;
    const source = String(payload?.source || 'ws_close');
    const code = Number(payload?.code) || 0;
    const reason = String(payload?.reason || '连接已断开');
    const phase = String(payload?.phase || 'unknown');
    log('系统', `连接已断开，不再使用旧 Code 重连 (source=${source}, code=${code}, phase=${phase})`);
    saveStats();
    quiesceBot(`连接断开: ${source}`);
    sendToMaster({
        type: 'account_disconnected',
        source,
        code,
        reason,
        phase,
        connectionId: Number(payload?.connectionId) || 0,
        at: Number(payload?.at) || Date.now(),
    });
    setTimeout(exitWorker, 300, 0);
}

function onKickout(payload: any): void {
    if (shutdownStarted) return;
    const reason = payload && payload.reason ? payload.reason : '未知';
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${reason}`);
    saveStats();
    quiesceBot(`踢下线: ${reason}`);
    sendToMaster({ type: 'account_kicked', reason });
    setTimeout(exitWorker, 300, 0);
}

// 处理来自 Admin 面板的直接调用请求 (如: 购买种子、开关设置等)
async function handleApiCall(msg: any): Promise<void> {
    const { id, method, args } = msg;
    let result: any = null;
    let error: { message: string; code?: string | number; name?: string } | string | null = null;

    try {
        if (method === 'applyRuntimeConfigSnapshot') {
            const appliedRevision = applyRuntimeConfig((args && args[0]) || {}, true);
            result = { appliedRevision };
        } else {
            if (!isRunning || shutdownStarted || !loginReady) {
                throw new Error('账号未连接');
            }
            switch (method) {
            case 'getLands':
                result = await getLandsDetail();
                break;
            case 'getIllustratedSnapshot':
                result = await require('../services/illustrated').getIllustratedSnapshot();
                break;
            case 'getFriends':
                result = await getFriendsList(args[0] === true);
                break;
            case 'getFriendsCache':
                result = getFriendsListCacheOnly();
                break;
            case 'clearFriendsCache':
                require('../services/friend').clearFriendsListCache();
                result = { ok: true };
                break;
            case 'getInteractRecords':
                result = await getInteractRecords();
                break;
            case 'getFriendLands':
                result = await getFriendLandsDetail(args[0]);
                break;
            case 'getFriendInteractionItems':
                result = await require('../services/friend-interaction-items').getFriendInteractionItems();
                break;
            case 'useFriendInteractionItemBatch':
                result = await require('../services/friend-interaction-items').useFriendInteractionItemBatch(args[0], args[1], args[2]);
                break;
            case 'useFriendFarmInteractionItem':
                result = await require('../services/friend-interaction-items').useFriendFarmInteractionItem(args[0], args[1]);
                break;
            case 'getSelfInteractionItems':
                result = await require('../services/friend-interaction-items').getSelfInteractionItems();
                break;
            case 'useSelfInteractionItemBatch':
                result = await require('../services/friend-interaction-items').useSelfInteractionItemBatch(args[0], args[1]);
                break;
            case 'doFriendOp':
                result = await doFriendOperation(args[0], args[1]);
                break;
            case 'delFriend':
                result = await deleteFriend(args[0]);
                break;
            case 'getSeeds':
                result = await getAvailableSeeds();
                break;
            case 'getBag':
                result = await require('../services/warehouse').getBagDetail();
                break;
            case 'getBagSeeds':
                result = await require('../services/warehouse').getBagSeeds();
                break;
            case 'getDiamondBalance':
                result = await require('../services/pay').getDiamondBalance();
                break;
            case 'useItem': {
                const { useItem: _useItem } = require('../services/warehouse');
                const itemId = Number(args[0]) || 0;
                const count = Math.max(1, Number(args[1]) || 1);
                const uid = Number(args[2]) || 0;
                result = await _useItem(itemId, count, [], uid);
                break;
            }
            case 'sellItems': {
                const { sellItems: _sell } = require('../services/warehouse');
                const sellList = Array.isArray(args[0]) ? args[0] : [];
                result = await _sell(sellList.map((it: any) => ({
                    id: it.id,
                    count: it.count,
                    uid: it.uid || 0,
                    expire_time: it.expireTime ?? it.expire_time,
                })));
                break;
            }
            case 'setItemsLocked':
                result = await require('../services/warehouse').setItemsLocked(args[0], args[1] === true);
                break;
            case 'getDogSkillGiftStatus': {
                const dogGifts = require('../services/dog-skill-gifts');
                const info = await dogGifts.getDogInfo();
                result = { pendingCount: dogGifts.getPendingGiftCount(info) };
                break;
            }
            case 'claimDogSkillGifts':
                result = await require('../services/dog-skill-gifts').checkAndClaimDogSkillGifts();
                break;
            case 'getPetInfo':
                result = await require('../services/pets').getPetInfo();
                break;
            case 'deployDog':
                result = await require('../services/pets').deployDog(args[0]);
                break;
            case 'withdrawDog':
                result = await require('../services/pets').withdrawDog();
                break;
            case 'useDogFood':
                result = await require('../services/pets').useDogFood(args[0], args[1], args[2]);
                break;
            case 'getPetProtectLogs':
                result = await require('../services/pets').getProtectLogs();
                break;
            case 'setAutomation': {
                const payload = args && args[0] ? args[0] : {};
                applyRuntimeConfig({ automation: { [payload.key]: payload.value } }, true);
                result = getAutomation();
                break;
            }
            case 'doFarmOp':
                result = await runFarmOperation(args[0], args[1]); // opType, optional targetLandId
                break;
            case 'fertilizeOwnLand':
                result = await fertilizeOwnLand(args[0], args[1]);
                break;
            case 'buyFertilizer': {
                const fertilizerType = args[0] || 'organic';
                const fertilizerCount = Number(args[1]) || 0;
                result = await autoBuyFertilizer(true, fertilizerType, fertilizerCount);
                break;
            }
            case 'checkAndBuyFertilizer': {
                const options = args[0] || {};
                result = await checkAndBuyFertilizerBoth(options);
                break;
            }
            case 'getAnalytics': {
                const { getPlantRankings } = require('../services/analytics');
                result = getPlantRankings(args[0]); // sortBy
                break;
            }
            case 'getDailyGiftOverview':
                result = await getDailyGiftOverview();
                break;
            case 'getActivityDirectorySnapshot':
                result = await require('../services/activity-center').getActivityDirectorySnapshot();
                break;
            case 'getActivityCenterSnapshot':
                result = await require('../services/activity-center').getActivityCenterSnapshot();
                break;
            case 'getCurrentSeasonEvent':
                result = await require('../services/activity-center').getCurrentSeasonEvent();
                break;
            case 'getCurrentStellarActivity':
                result = await require('../services/activity-center').getCurrentStellarActivity();
                break;
            case 'getCurrentStarSandShop':
                result = await require('../services/activity-center').getCurrentStarSandShop();
                break;
            case 'getCurrentSolarTerms':
                result = await require('../services/activity-center').getCurrentSolarTerms();
                break;
            case 'getCurrentQixiActivity':
                result = await require('../services/activity-center').getCurrentQixiActivity();
                break;
            case 'getCurrentCharityRedFlowerActivity':
                result = await require('../services/activity-center').getCurrentCharityRedFlowerActivity();
                break;
            case 'claimCharityRedFlowerSeeds':
                result = await require('../services/activity-center').claimCharityRedFlowerSeeds();
                break;
            case 'donateCharityRedFlowerLove':
                result = await require('../services/activity-center').donateCharityRedFlowerLove();
                break;
            case 'claimCharityRedFlowerDailyGift':
                result = await require('../services/activity-center').claimCharityRedFlowerDailyGift();
                break;
            case 'getCurrentWeatherActivity':
                result = await require('../services/activity-center').getCurrentWeatherActivity();
                break;
            case 'buyWeatherBottle':
                result = await require('../services/activity-center').buyWeatherBottle(args[0]);
                break;
            case 'collectWeatherBottle':
                result = await require('../services/activity-center').collectWeatherBottle(args[0]);
                break;
            case 'lightWeatherResearch':
                result = await require('../services/activity-center').lightWeatherResearch(args[0]);
                break;
            case 'summonWeatherRain':
                result = await require('../services/activity-center').summonWeatherRain();
                break;
            case 'claimBattlePassRewards':
                result = await require('../services/activity-center').claimBattlePassRewards();
                break;
            case 'exchangeStarSandGoods':
                result = await require('../services/activity-center').exchangeStarSandGoods(args[0], args[1]);
                break;
            case 'lightConstellation':
                result = await require('../services/activity-center').lightConstellation();
                break;
            case 'claimSolarTerm':
                result = await require('../services/activity-center').claimSolarTerm(String(args[0] || ''));
                break;
            case 'getCurrentQingMeiActivity':
                result = await require('../services/activity-center').getCurrentQingMeiActivity();
                break;
            case 'claimQingMeiDailySeed':
                result = await require('../services/activity-center').claimQingMeiDailySeed();
                break;
            case 'startQingMeiBrew':
                result = await require('../services/activity-center').startQingMeiBrew(args[0]);
                break;
            case 'continueQingMeiBrew':
                result = await require('../services/activity-center').continueQingMeiBrew();
                break;
            case 'settleQingMeiBrew':
                result = await require('../services/activity-center').settleQingMeiBrew();
                break;
            case 'claimQixiBridgeRewards':
                result = await require('../services/activity-center').claimQixiBridgeRewards();
                break;
            case 'giftQixiSachet':
                result = await require('../services/activity-center').giftQixiSachet(args[0], args[1]);
                break;
            case 'exchangeWeatherCollectorBottle':
                result = await require('../services/activity-center').exchangeWeatherCollectorBottle();
                break;
            case 'getWeatherFriends':
                result = await require('../services/activity-center').getWeatherFriends();
                break;
            case 'scanWeatherFriends':
                result = await require('../services/activity-center').scanWeatherFriends(args[0]);
                break;
            case 'useWeatherCollectorBottle':
                result = await require('../services/activity-center').useWeatherCollectorBottle(args[0]);
                break;
            case 'useWeatherSummonBottle':
                result = await require('../services/activity-center').useWeatherSummonBottle();
                break;
            case 'useWeatherFrogBottle':
                result = await require('../services/activity-center').useWeatherFrogBottle(args[0]);
                break;
            case 'useWeatherCloudBottle':
                result = await require('../services/activity-center').useWeatherCloudBottle(args[0], args[1]);
                break;
            case 'advanceWeatherResearch':
                result = await require('../services/activity-center').advanceWeatherResearch(args[0]);
                break;
            case 'getMallCatalog':
                result = await require('../services/commerce').getMallCatalog(args[0], args[1]);
                break;
            case 'purchaseMallProduct':
                result = await require('../services/commerce').purchaseMallProduct(args[0], args[1]);
                break;
            case 'getMysteryShop':
                result = await require('../services/commerce').getMysteryShop();
                break;
            case 'purchaseMysteryOffer':
                result = await require('../services/commerce').purchaseMysteryOffer(args[0]);
                break;
            case 'getSchedulers':
                result = getSchedulerRegistrySnapshot();
                break;
            default:
                error = 'Unknown method';
            }
        }
    } catch (e: any) {
        error = {
            message: String(e?.message || e || 'Worker API error'),
            code: e?.code,
            name: String(e?.name || 'Error'),
        };
    }

    sendToMaster({ type: 'api_response', id, result, error });
}

async function getDailyGiftOverview(): Promise<any> {
    const auto = getAutomation() || {};
    const task = getTaskDailyStateLikeApp
        ? await getTaskDailyStateLikeApp()
        : (getTaskClaimDailyState ? getTaskClaimDailyState() : { doneToday: false, lastClaimAt: 0 });
    const growthTask = getGrowthTaskStateLikeApp
        ? await getGrowthTaskStateLikeApp()
        : { doneToday: false, completedCount: 0, totalCount: 0, tasks: [] };
    const email = getEmailDailyState ? getEmailDailyState() : { doneToday: false, lastCheckAt: 0 };
    const free = getFreeGiftDailyState ? getFreeGiftDailyState() : { doneToday: false, lastClaimAt: 0 };
    const share = getShareDailyState ? getShareDailyState() : { doneToday: false, lastClaimAt: 0 };
    const vip = getVipDailyState ? getVipDailyState() : { doneToday: false, lastClaimAt: 0 };
    const month = getMonthCardDailyState ? getMonthCardDailyState() : { doneToday: false, lastClaimAt: 0 };

    return {
        date: getSystemDateKey(),
        growth: {
            key: 'growth_task',
            label: '成长任务',
            doneToday: !!growthTask.doneToday,
            completedCount: Number(growthTask.completedCount || 0),
            totalCount: Number(growthTask.totalCount || 0),
            currentTask: growthTask.currentTask || null,
            tasks: Array.isArray(growthTask.tasks) ? growthTask.tasks : [],
        },
        gifts: [
            {
                key: 'task_claim',
                label: '每日任务',
                enabled: !!auto.task,
                doneToday: !!task.doneToday,
                lastAt: Number(task.lastClaimAt || 0),
                completedCount: Number(task.completedCount || 0),
                totalCount: Number(task.totalCount || 3),
            },
            // 以下功能默认启用，enabled 固定为 true
            { key: 'email_rewards', label: '邮箱奖励', enabled: true, doneToday: !!email.doneToday, lastAt: Number(email.lastCheckAt || 0) },
            { key: 'mall_free_gifts', label: '商城免费礼包', enabled: true, doneToday: !!free.doneToday, lastAt: Number(free.lastClaimAt || 0) },
            {
                key: 'daily_share',
                label: '分享礼包',
                enabled: true,
                mode: 'auto_claim',
                doneToday: !!share.doneToday,
                checkedToday: !!share.checkedToday,
                checkStatus: String(share.checkStatus || 'unchecked'),
                canShare: typeof share.canShare === 'boolean' ? share.canShare : null,
                lastAt: Number(share.lastClaimAt || share.lastCheckAt || 0),
            },
            {
                key: 'vip_daily_gift',
                label: '会员礼包',
                enabled: true,
                doneToday: !!vip.doneToday,
                lastAt: Number(vip.lastClaimAt || vip.lastCheckAt || 0),
                hasGift: Object.hasOwn(vip, 'hasGift') ? !!vip.hasGift : undefined,
                canClaim: Object.hasOwn(vip, 'canClaim') ? !!vip.canClaim : undefined,
                result: vip.result || '',
            },
            {
                key: 'month_card_gift',
                label: '月卡礼包',
                enabled: true,
                doneToday: !!month.doneToday,
                lastAt: Number(month.lastClaimAt || month.lastCheckAt || 0),
                hasCard: Object.hasOwn(month, 'hasCard') ? !!month.hasCard : undefined,
                hasClaimable: Object.hasOwn(month, 'hasClaimable') ? !!month.hasClaimable : undefined,
                result: month.result || '',
            },
        ],
    };
}

function syncStatus(force: boolean = false): void {
    if (!process.send && !parentPort) return;

    const userState = getUserState();
    const ws = getWs();
    const connected = !!(loginReady && ws && ws.readyState === 1);

    let expProgress: any = null;
    const level = (userState.level ?? statusData.level ?? 0);
    const exp = (userState.exp ?? statusData.exp ?? 0);

    if (level > 0 && exp >= 0) {
        expProgress = getLevelExpProgress(level, exp);
    }

    const limits = require('../services/friend').getOperationLimits();
    const fullStats = require('../services/stats').getStats(statusData, userState, connected, limits);
    const nowMs = Date.now();
    const farmRemainSec = Math.max(0, Math.ceil((Number(nextFarmRunAt || 0) - nowMs) / 1000));
    const friendRemainSec = Math.max(0, Math.ceil((Number(nextFriendRunAt || 0) - nowMs) / 1000));
    const visitStrategy = require('../services/friend/visit-strategy');
    const friendQuiet = !!visitStrategy.inFriendQuietHours();
    const farmQuiet = !!visitStrategy.inFarmQuietHours();
    fullStats.nextChecks = {
        farmRemainSec,
        helpRemainSec: friendRemainSec,
        stealRemainSec: friendRemainSec,
        friendRemainSec,
        farmQuiet,
        friendQuiet,
        helpQuiet: friendQuiet,
        stealQuiet: friendQuiet,
    };

    fullStats.automation = getAutomation();
    fullStats.preferredSeed = getPreferredSeed();
    fullStats.levelProgress = expProgress;
    fullStats.configRevision = appliedConfigRevision;
    const hash = JSON.stringify(fullStats);
    const now = Date.now();
    if (force || hash !== lastStatusHash || now - lastStatusSentAt > 8000) {
        lastStatusHash = hash;
        lastStatusSentAt = now;
        sendToMaster({ type: 'status_sync', data: fullStats });
    }
}
