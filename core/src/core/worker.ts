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
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, getLandsDetail, getAvailableSeeds, runFarmOperation, runFertilizerByConfig } = require('../services/farm');
const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, runBadOnceOnStartup, isHelpExpLimitReached, getFriendsList, getFriendLandsDetail, doFriendOperation } = require('../services/friend');
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
const { connect, cleanup, getWs, getUserState, networkEvents } = require('../utils/network');
const { loadProto } = require('../utils/proto');
const { setLogHook, log, logWarn, toNum, getSystemDateKey, formatSystemDateTime24 } = require('../utils/utils');

// Extend CONFIG with help/steal interval properties used by this worker
interface WorkerRuntimeConfig {
    helpCheckIntervalMin: number;
    helpCheckIntervalMax: number;
    stealCheckIntervalMin: number;
    stealCheckIntervalMax: number;
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
let helpTaskRunning: boolean = false;
let nextHelpRunAt: number = 0;
let stealTaskRunning: boolean = false;
let nextStealRunAt: number = 0;
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

function startDailyRoutineTimer(): void {
    stopDailyRoutineTimer();
    lastDailyRunDate = getSystemDateKey();
    // 新账号登录后强制执行一次领取
    runDailyRoutines(true).catch(() => null);
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

    // 帮助和偷菜的独立间隔
    const helpRange = normalizeIntervalRangeSec(data.helpMin, data.helpMax, 10);
    workerConfig.helpCheckIntervalMin = helpRange.min * 1000;
    workerConfig.helpCheckIntervalMax = helpRange.max * 1000;

    const stealRange = normalizeIntervalRangeSec(data.stealMin, data.stealMax, 10);
    workerConfig.stealCheckIntervalMin = stealRange.min * 1000;
    workerConfig.stealCheckIntervalMax = stealRange.max * 1000;
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
    const helpMs = randomIntervalMs(
        workerConfig.helpCheckIntervalMin || 10000,
        workerConfig.helpCheckIntervalMax || 10000
    );
    const stealMs = randomIntervalMs(
        workerConfig.stealCheckIntervalMin || 10000,
        workerConfig.stealCheckIntervalMax || 10000
    );
    const now = Date.now();
    nextFarmRunAt = now + farmMs;
    nextHelpRunAt = now + helpMs;
    nextStealRunAt = now + stealMs;
}

async function runFarmTick(auto: any): Promise<void> {
    if (farmTaskRunning) return;
    farmTaskRunning = true;
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    try {
        if (auto.farm) await checkFarm();
        if (auto.task) await checkAndClaimTasks();
        if (auto.email) await checkAndClaimEmails();
        if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
    } catch {
        // ignore
    } finally {
        nextFarmRunAt = Date.now() + farmMs;
        farmTaskRunning = false;
    }
}

// ============ 帮助巡查（独立调度） ============
async function runHelpTick(auto: any): Promise<void> {
    if (helpTaskRunning) {
        return;
    }
    if (!auto.friend_help) {
        return;
    }
    // 检查是否开启了经验满不帮忙，且经验已达上限
    const stopWhenExpLimit = !!auto.friend_help_exp_limit;
    if (stopWhenExpLimit && isHelpExpLimitReached()) {
        // 计算下次调度时间，但不执行巡查
        const helpMs = randomIntervalMs(
            workerConfig.helpCheckIntervalMin || 10000,
            workerConfig.helpCheckIntervalMax || 10000
        );
        nextHelpRunAt = Date.now() + helpMs;
        return;
    }
    helpTaskRunning = true;
    const helpMs = randomIntervalMs(
        workerConfig.helpCheckIntervalMin || 10000,
        workerConfig.helpCheckIntervalMax || 10000
    );
    try {
        await checkFriends({ onlyHelp: true });
    } catch (e: any) {
        log('系统', `帮助巡查执行失败: ${e.message}`, { module: 'system', event: '帮助巡查', result: 'error' });
    } finally {
        nextHelpRunAt = Date.now() + helpMs;
        helpTaskRunning = false;
    }
}

// ============ 偷菜巡查（独立调度） ============
async function runStealTick(auto: any): Promise<void> {
    if (stealTaskRunning) {
        return;
    }
    if (!auto.friend_steal) {
        return;
    }
    stealTaskRunning = true;
    const stealMs = randomIntervalMs(
        workerConfig.stealCheckIntervalMin || 10000,
        workerConfig.stealCheckIntervalMax || 10000
    );
    try {
        await checkFriends({ onlySteal: true });
    } catch (e: any) {
        log('系统', `偷菜巡查执行失败: ${e.message}`, { module: 'system', event: '偷菜巡查', result: 'error' });
    } finally {
        nextStealRunAt = Date.now() + stealMs;
        stealTaskRunning = false;
    }
}

async function runUnifiedTick(): Promise<void> {
    if (!unifiedSchedulerRunning || !loginReady) return;
    const now = Date.now();
    const dueFarm = now >= nextFarmRunAt;
    const dueHelp = now >= nextHelpRunAt;
    const dueSteal = now >= nextStealRunAt;
    if (!dueFarm && !dueHelp && !dueSteal) return;

    const auto = getAutomation();
    // 串行执行而非并行，避免并发请求过多导致超时
    if (dueFarm) await runFarmTick(auto);
    if (dueHelp) await runHelpTick(auto);
    if (dueSteal) await runStealTick(auto);
}

function scheduleUnifiedNextTick(): void {
    if (!unifiedSchedulerRunning) return;
    workerScheduler.clear('unified_next_tick');
    if (!loginReady) return;

    const now = Date.now();
    const nextAt = Math.min(
        Number(nextFarmRunAt) || (now + 1000),
        Number(nextHelpRunAt) || (now + 1000),
        Number(nextStealRunAt) || (now + 1000)
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
    helpTaskRunning = false;
    stealTaskRunning = false;
    workerScheduler.clear('unified_next_tick');
}

function stopMysteryShopTimer(): void {
    workerScheduler.clear('mystery_shop_initial');
    workerScheduler.clear('mystery_shop_interval');
    workerScheduler.clear('mystery_shop_after_save');
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

function startMysteryShopTimer(): void {
    const {
        isMysteryShopWatchEnabled,
        AUTO_BUY_CHECK_INTERVAL_MS,
        AUTO_BUY_INITIAL_DELAY_MS,
    } = require('../services/mystery-shop-auto');
    stopMysteryShopTimer();
    if (!loginReady || !isMysteryShopWatchEnabled(getAutomation())) return;
    workerScheduler.setTimeoutTask('mystery_shop_initial', AUTO_BUY_INITIAL_DELAY_MS, () => {
        runMysteryShopTick().catch(() => null);
    });
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

    const { code, platform, systemTimeZone } = config;

    if (systemTimeZone !== undefined) updateRuntimeConfig({ timeZone: systemTimeZone });
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

        // 启动时执行一次放虫放草（只在账号启动时执行）
        workerScheduler.setTimeoutTask('bad_startup_once', 10000, async () => {
            try {
                await runBadOnceOnStartup();
            } catch (e: any) {
                log('好友', `启动时放虫放草执行失败: ${e.message}`, { module: 'friend', event: '启动放虫放草失败', error: e.message });
            }
        });

        if (!canContinueLogin()) return;
        startFarmCheckLoop({ externalScheduler: true });
        startFriendCheckLoop({ externalScheduler: true });
        startUnifiedScheduler();
        // 每日礼包/任务改为跨日调度，不在农场轮询内执行
        startDailyRoutineTimer();
        startMysteryShopTimer();

        // 立即发送一次状态
        syncStatus();
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
    setTimeout(() => exitWorker(0), 300);
}

function onKickout(payload: any): void {
    if (shutdownStarted) return;
    const reason = payload && payload.reason ? payload.reason : '未知';
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${reason}`);
    saveStats();
    quiesceBot(`踢下线: ${reason}`);
    sendToMaster({ type: 'account_kicked', reason });
    setTimeout(() => exitWorker(0), 300);
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
            case 'getSelfInteractionItems':
                result = await require('../services/friend-interaction-items').getSelfInteractionItems();
                break;
            case 'useSelfInteractionItemBatch':
                result = await require('../services/friend-interaction-items').useSelfInteractionItemBatch(args[0], args[1]);
                break;
            case 'doFriendOp':
                result = await doFriendOperation(args[0], args[1]);
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
                result = await runFarmOperation(args[0]); // opType
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
            case 'getActivityCenterSnapshot':
                result = await require('../services/activity-center').getActivityCenterSnapshot();
                break;
            case 'getCurrentSeasonEvent':
                result = await require('../services/activity-center').getCurrentSeasonEvent();
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
                hasGift: Object.prototype.hasOwnProperty.call(vip, 'hasGift') ? !!vip.hasGift : undefined,
                canClaim: Object.prototype.hasOwnProperty.call(vip, 'canClaim') ? !!vip.canClaim : undefined,
                result: vip.result || '',
            },
            {
                key: 'month_card_gift',
                label: '月卡礼包',
                enabled: true,
                doneToday: !!month.doneToday,
                lastAt: Number(month.lastClaimAt || month.lastCheckAt || 0),
                hasCard: Object.prototype.hasOwnProperty.call(month, 'hasCard') ? !!month.hasCard : undefined,
                hasClaimable: Object.prototype.hasOwnProperty.call(month, 'hasClaimable') ? !!month.hasClaimable : undefined,
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
    const helpRemainSec = Math.max(0, Math.ceil((Number(nextHelpRunAt || 0) - nowMs) / 1000));
    const stealRemainSec = Math.max(0, Math.ceil((Number(nextStealRunAt || 0) - nowMs) / 1000));
    const visitStrategy = require('../services/friend/visit-strategy');
    const friendQuiet = !!visitStrategy.inFriendQuietHours();
    const farmQuiet = !!visitStrategy.inFarmQuietHours();
    fullStats.nextChecks = {
        farmRemainSec,
        helpRemainSec,
        stealRemainSec,
        friendRemainSec: Math.max(helpRemainSec, stealRemainSec),
        farmQuiet,
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
