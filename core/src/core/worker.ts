export {};
/**
 * 子进程 Worker - 负责运行单个账号的挂机逻辑
 */
const { parentPort, workerData } = require('node:worker_threads');

const {
    closeAccountTaskQueue,
    getAccountTaskRunnerSnapshot,
    openAccountTaskQueue,
    submitAccountTask,
} = require('../app/account-task-runner');
const { BackgroundJob } = require('../app/background-job');
const { runStartupSequence } = require('../app/startup-sequence');
const { executeWorkerApiCall } = require('../app/worker-api-dispatcher');
const { runClaimedInviteBatch } = require('../app/worker-invite-batch');
const { createWorkerApiRegistry } = require('../app/worker-api-registry');
const { CONFIG, updateRuntimeConfig } = require('../config/config');
const { getLevelExpProgress, loadConfigs } = require('../config/gameConfig');
const { getAutomation, getPreferredSeed, getConfigSnapshot, applyConfigSnapshot } = require('../models/store');
const { checkAndClaimEmails } = require('../services/email');
const { getEmailDailyState } = require('../services/email');
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, runFertilizerByConfig } = require('../services/farm');
const {
    acknowledgeKnownFriendGids,
    checkFriends,
    flushPendingKnownFriendGids,
    reapplyPendingKnownFriendGids,
    refreshFriendCheckLoop,
    startFriendCheckLoop,
    stopFriendCheckLoop,
} = require('../services/friend');
const { processInviteCodes } = require('../services/invite');
const { buyFreeGifts, getFreeGiftDailyState } = require('../services/mall');
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

if (parentPort && workerData && workerData.accountId) {
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
let nextFarmRunAt: number = 0;
let nextFriendRunAt: number = 0;
const businessBackoffMs: Record<'farm' | 'friend', number> = { farm: 0, friend: 0 };
let lastStatusHash: string = '';
let lastStatusSentAt: number = 0;
let onSellGain: ((deltaGold: any) => void) | null = null;
let onFarmHarvested: (() => Promise<void>) | null = null;
let onDogSkillGiftPending: ((count: any) => void) | null = null;
let onWsError: ((payload: any) => void) | null = null;
let onDisconnected: ((payload: any) => void) | null = null;
let wsErrorHandledAt: number = 0;
let shutdownStarted: boolean = false;
let runtimeGeneration: number = 0;
let lastDailyRunDate: string = '';
const workerScheduler = createScheduler('worker');
const friendTickJob = new BackgroundJob();

const workerApiRegistry = createWorkerApiRegistry({
    applyRuntimeConfigSnapshot(snapshot: any) {
        return { appliedRevision: applyRuntimeConfig(snapshot, true) };
    },
    setAutomation(payload: any) {
        applyRuntimeConfig({ automation: { [payload.key]: payload.value } }, true);
        return getAutomation();
    },
    getDailyGiftOverview,
    getSchedulers: () => ({
        ...getSchedulerRegistrySnapshot(),
        accountTasks: getAccountTaskRunnerSnapshot(),
        backgroundJobs: {
            friendRound: {
                running: friendTickJob.isRunning(),
                nextRunAt: Number(nextFriendRunAt) || 0,
            },
        },
    }),
});

async function runDailyRoutines(force: boolean = false): Promise<void> {
    if (!loginReady) return;
    try {
        const routines: Array<[string, () => Promise<any>]> = [
            ['daily.email', () => checkAndClaimEmails(force)],
            ['daily.share', () => checkDailyShareStatus(force)],
            ['daily.month-card', () => performDailyMonthCardGift(force)],
            ['daily.free-gifts', () => buyFreeGifts(force)],
            ['daily.vip', () => performDailyVipGift(force)],
        ];
        for (const [name, run] of routines) {
            if (!loginReady) return;
            await submitAccountTask(name, run, { priority: 'maintenance', dedupeKey: name });
        }
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

const BUSINESS_TICK_LABEL: Record<'farm' | 'friend', string> = {
    farm: '农场定时任务',
    friend: '好友定时任务',
};

function describeGatewayStall(load: any): string {
    const parts: string[] = [];
    const misses = Number(load?.heartbeatMisses) || 0;
    const oldest = Number(load?.oldestPendingAgeMs) || 0;
    if (misses > 0) parts.push(`心跳漏 ${misses} 次`);
    if (oldest > 0) parts.push(`最老在途 ${(oldest / 1000).toFixed(1)}s`);
    parts.push(`pending=${Number(load?.pending) || 0}`);
    parts.push(`queued=${Number(load?.queued) || 0}`);
    return parts.join(', ');
}

function nextBusinessTickDeferMs(kind: 'farm' | 'friend'): number {
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
    const deferMs = nextBusinessTickDeferMs('farm');
    if (deferMs > 0) {
        nextFarmRunAt = Date.now() + deferMs;
        return;
    }
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    try {
        await runWithRequestClass('farm', async () => {
            if (auto.farm) await checkFarm();
            if (auto.task) {
                await submitAccountTask('task.claim', checkAndClaimTasks, {
                    priority: 'scheduled',
                    dedupeKey: 'task.claim',
                });
            }
            if (auto.email) {
                await submitAccountTask('email.claim', checkAndClaimEmails, {
                    priority: 'scheduled',
                    dedupeKey: 'email.claim',
                });
            }
            if (auto.fertilizer_gift) {
                await submitAccountTask('fertilizer-gift.open', openFertilizerGiftPacksSilently, {
                    priority: 'scheduled',
                    dedupeKey: 'fertilizer-gift.open',
                });
            }
        });
    } catch {
        // ignore
    } finally {
        nextFarmRunAt = Date.now() + farmMs;
    }
}

// ============ 好友统一任务：偷菜、帮助、放虫放草 ============
function runFriendTick(auto: any): boolean {
    const friendMs = randomIntervalMs(
        workerConfig.friendCheckIntervalMin || 12000,
        workerConfig.friendCheckIntervalMax || 15000
    );
    // friend 总开关仍控制好友任务总入口；关闭时也要推进到期时间，避免调度器每秒空转。
    if (!auto.friend) {
        nextFriendRunAt = Date.now() + friendMs;
        return false;
    }

    const deferMs = nextBusinessTickDeferMs('friend');
    if (deferMs > 0) {
        nextFriendRunAt = Date.now() + deferMs;
        return false;
    }

    const started = friendTickJob.start(
        (signal: AbortSignal) => runWithRequestClass('friend', () => checkFriends({ signal })),
        {
            onError: (e: any) => {
                log('系统', `好友统一任务执行失败: ${e.message}`, { module: 'system', event: '好友统一任务', result: 'error' });
            },
            onSettled: () => {
                nextFriendRunAt = Date.now() + friendMs;
            },
        },
    );
    if (!started) nextFriendRunAt = Date.now() + friendMs;
    return started;
}

async function runUnifiedTick(): Promise<void> {
    if (!unifiedSchedulerRunning || !loginReady) return;
    const now = Date.now();
    const dueFarm = now >= nextFarmRunAt;
    const dueFriend = now >= nextFriendRunAt;
    if (!dueFarm && !dueFriend) return;

    const auto = getAutomation();
    if (dueFarm) await runFarmTick(auto);
    if (!friendTickJob.isRunning() && Date.now() >= nextFriendRunAt) runFriendTick(auto);
}

function scheduleUnifiedNextTick(): void {
    if (!unifiedSchedulerRunning) return;
    workerScheduler.clear('unified_next_tick');
    if (!loginReady) return;

    const now = Date.now();
    const friendNextAt = friendTickJob.isRunning()
        ? Number.POSITIVE_INFINITY
        : (Number(nextFriendRunAt) || (now + 1000));
    const nextAt = Math.min(Number(nextFarmRunAt) || (now + 1000), friendNextAt);
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
    return submitAccountTask('mystery-shop.check', async () => {
        const result = await checkMysteryShopTick();
        if (result?.push?.title && result?.push?.content) {
            sendToMaster({ type: 'push_notify', title: result.push.title, content: result.push.content });
        }
    }, {
        priority: 'maintenance',
        dedupeKey: 'mystery-shop.check',
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
    if (options.runInitial !== false) {
        workerScheduler.setTimeoutTask('mystery_shop_initial', AUTO_BUY_INITIAL_DELAY_MS, () => {
            runMysteryShopTick().catch(() => null);
        });
    }
    workerScheduler.setIntervalTask('mystery_shop_interval', AUTO_BUY_CHECK_INTERVAL_MS, () => {
        runMysteryShopTick().catch(() => null);
    });
}

function startAutomationRuntime(): void {
    startFarmCheckLoop({ externalScheduler: true });
    startFriendCheckLoop({ externalScheduler: true });
    startUnifiedScheduler();
    startDailyRoutineTimer(false);
    startMysteryShopTimer({ runInitial: false });
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
    reapplyPendingKnownFriendGids();
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
                        await submitAccountTask(
                            'fertilizer.after-config',
                            () => runFertilizerByConfig([], { skipNormal: true }),
                            { priority: 'event', dedupeKey: 'fertilizer.after-config' },
                        );
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
            void handleRegisteredApiCall(msg);
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        } else if (msg.type === 'known_friend_gids_ack') {
            acknowledgeKnownFriendGids(msg.revision, msg.gids);
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
    openAccountTaskQueue();

    const { code, platform, systemTimeZone, systemServerUrl, systemClientVersion, inviteBatch } = config;

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
            if (!getAutomation().sell) return;
            try {
                await submitAccountTask('warehouse.sell-after-harvest', sellAllFruits, {
                    priority: 'event',
                    dedupeKey: 'warehouse.sell-after-harvest',
                    requestClass: 'farm',
                });
            } catch (e: any) {
                log('仓库', `收获后自动出售失败: ${e.message}`, { module: 'warehouse', event: '收获后出售', result: 'error' });
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        if (onDogSkillGiftPending) {
            networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        }
        onDogSkillGiftPending = (count: any) => {
            const pendingCount = Math.max(0, toNum(count));
            if (pendingCount <= 0 || !loginReady) return;
            submitAccountTask(
                'dog-skill-gift.claim',
                () => checkAndClaimDogSkillGifts(pendingCount),
                { priority: 'event', dedupeKey: 'dog-skill-gift.claim', requestClass: 'farm' },
            ).catch(() => null);
        };
        networkEvents.on('dogSkillGiftPending', onDogSkillGiftPending);

        try {
            await submitAccountTask('activity-windows.refresh', refreshActivityWindows, {
                priority: 'maintenance',
                dedupeKey: 'activity-windows.refresh',
            });
        } catch (e: any) {
            logWarn('仓库', `活动时间初始化失败: ${e?.message || e}`);
        }
        if (!canContinueLogin()) return;

        // 登录后只拉一次背包，同时初始化点券（1002）和金豆豆（1005）
        try {
            const bagReply = await submitAccountTask('bootstrap.bag', getBag, {
                priority: 'maintenance',
                dedupeKey: 'bootstrap.bag',
            });
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
        await runClaimedInviteBatch(inviteBatch, {
            notify: sendToMaster,
            processInvites: processInviteCodes,
            submitTask: submitAccountTask,
        });
        if (!canContinueLogin()) return;
        if (getAutomation().fertilizer_gift) {
            await submitAccountTask('bootstrap.fertilizer-gifts', openFertilizerGiftPacksSilently, {
                priority: 'maintenance',
                dedupeKey: 'bootstrap.fertilizer-gifts',
            }).catch(() => 0);
            if (!canContinueLogin()) return;
        }

        if (!canContinueLogin()) return;
        syncStatus();
        await runWithRequestClass('farm', () => runStartupSequence({
            steps: [
                { name: 'daily-routines', run: () => runDailyRoutines(true) },
                {
                    name: 'task-claim',
                    run: () => submitAccountTask('task.claim', checkAndClaimTasks, {
                        priority: 'maintenance',
                        dedupeKey: 'task.claim',
                    }),
                },
                { name: 'mystery-shop', run: runMysteryShopTick },
            ],
            canContinue: () => loginReady && canContinueLogin(),
            activateRuntime: startAutomationRuntime,
            onStepError: (name: string, error: any) => {
                log('系统', `启动步骤 ${name} 失败: ${error?.message || error}`, {
                    module: 'system',
                    event: '启动序列',
                    result: 'error',
                    step: name,
                });
            },
        }));
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
    friendTickJob.abort();
    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopDailyRoutineTimer();
    cleanupTaskSystem();
    closeAccountTaskQueue(reason);
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

async function handleRegisteredApiCall(msg: any): Promise<void> {
    const { id, method, args } = msg;
    const response = await executeWorkerApiCall(method, args, workerApiRegistry, {
        isAccountReady: () => isRunning && !shutdownStarted && loginReady,
        onStarted: () => sendToMaster({ type: 'api_call_started', id }),
        submitTask: submitAccountTask,
    });
    sendToMaster({ type: 'api_response', id, ...response });
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
    flushPendingKnownFriendGids();

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
