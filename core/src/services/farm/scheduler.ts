export {};
/**
 * 农场循环调度 - 循环管理、可变状态
 */

const { runAccountTaskStep, submitAccountTask } = require('../../app/account-task-runner');
const { CONFIG } = require('../../config/config');
const { isAutomationOn, getAutomation, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../../models/store');
const { getUserState, networkEvents } = require('../../utils/network');
const { toNum, log, logWarn, randomDelay } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');
const { recordOperation } = require('../stats');
const { getAllLands, harvest, farming, unlockLand, upgradeLand } = require('./api');
const {
    analyzeLands,
    getCleanableFarmSocialEventItemIds,
    resolveRemovableHarvestedLands,
} = require('./land-analysis');
const { autoPlantEmptyLands, runFertilizerByConfig } = require('./planting');
const { checkAndBuyFertilizerBoth } = require('../mall');
// 延迟加载以打破循环依赖: visit-strategy → farm/index → scheduler → visit-strategy
function inFarmQuietHours() {
    return require('../friend/visit-strategy').inFarmQuietHours();
}

function runFarmPhase<T>(name: string, run: () => Promise<T> | T): Promise<T> {
    return runAccountTaskStep(`farm.phase.${name}`, run);
}

// ============ 内部状态 ============
let isFirstFarmCheck: boolean = true;
let farmLoopRunning: boolean = false;
let externalSchedulerMode: boolean = false;
const farmScheduler = createScheduler('farm');
let lastPushTime: number = 0;

// ============ 农场循环 ============

async function runFarmCheck(): Promise<boolean> {
    const state = getUserState();
    if (!state.gid || !isAutomationOn('farm')) return false;
    if (inFarmQuietHours()) return false;

    try {
        // 复用手动操作逻辑
        const result = await runFarmOperation('all');
        isFirstFarmCheck = false;
        return !!(result && result.hadWork);
    } catch (err: any) {
        logWarn('巡田', `检查失败: ${err.message}`);
        return false;
    }
}

async function checkFarm(options: { priority?: 'event' | 'scheduled' } = {}): Promise<boolean> {
    return submitAccountTask('farm.check', runFarmCheck, {
        priority: options.priority || 'scheduled',
        dedupeKey: 'farm.check',
    });
}

/**
 * smart 有机肥可能让作物在本轮成熟。施肥后只重查并收获一次，避免形成请求循环。
 */
async function harvestMatureOwnLandsOnce(actions: string[]): Promise<number> {
    let latest: any;
    try {
        latest = await runFarmPhase('post-fertilizer-get-lands', getAllLands);
    } catch (e: any) {
        logWarn('收获', `施肥后刷新土地失败: ${e.message}`);
        return 0;
    }

    const lands = Array.isArray(latest && latest.lands) ? latest.lands : [];
    if (lands.length === 0) return 0;

    const ownGid = toNum(getUserState().gid);
    const harvestable = analyzeLands(lands, false, ownGid).harvestable;
    if (harvestable.length === 0) return 0;

    try {
        await runFarmPhase('post-fertilizer-harvest', () => harvest(harvestable));
        actions.push(`施肥后收获${harvestable.length}`);
        recordOperation('harvest', harvestable.length);
        networkEvents.emit('farmHarvested', {
            count: harvestable.length,
            landIds: [...harvestable],
            opType: 'fertilizer_followup',
        });
        log('收获', `施肥后立即收获 ${harvestable.length} 块土地`, {
            module: 'farm',
            event: '施肥后收获作物',
            result: 'ok',
            count: harvestable.length,
            landIds: [...harvestable],
        });
        return harvestable.length;
    } catch (e: any) {
        logWarn('收获', `施肥后立即收获失败: ${e.message}`, {
            module: 'farm',
            event: '施肥后收获作物',
            result: 'error',
        });
        return 0;
    }
}

/**
 * 手动/自动执行农场操作
 * @param opType - 'all', 'harvest', 'clear', 'plant', 'upgrade'
 */
async function runFarmOperation(
    opType: string,
    targetLandIdInput: unknown = null,
): Promise<{ hadWork: boolean; actions: string[] }> {
    const landsReply: any = await runFarmPhase<any>('get-lands', getAllLands);
    if (!landsReply.lands || landsReply.lands.length === 0) {
        if (opType !== 'all') {
            log('农场', '没有土地数据');
        }
        return { hadWork: false, actions: [] };
    }

    const lands = landsReply.lands;

    const state = getUserState();
    const status = analyzeLands(lands, isFirstFarmCheck, state.gid);
    const socialEventItemIds: number[] = getCleanableFarmSocialEventItemIds(landsReply);
    const hasTargetLandId = targetLandIdInput !== null
        && targetLandIdInput !== undefined
        && String(targetLandIdInput).trim() !== '';
    const targetLandId = toNum(targetLandIdInput);
    if (hasTargetLandId && (!Number.isSafeInteger(targetLandId) || targetLandId <= 0)) {
        throw new Error('地块编号无效');
    }
    if (hasTargetLandId && opType !== 'clear') {
        throw new Error('指定地块仅支持单点务农');
    }

    // 摘要
    const statusParts: string[] = [];
    if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
    const farmingCount = new Set([...status.needWeed, ...status.needBug, ...status.needInteractionCleanup]).size
        + socialEventItemIds.length;
    if (farmingCount > 0) statusParts.push(`农:${farmingCount}`);
    if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
    if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
    if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
    if (status.unlockable.length) statusParts.push(`解:${status.unlockable.length}`);
    if (status.upgradable.length) statusParts.push(`升:${status.upgradable.length}`);
    statusParts.push(`长:${status.growing.length}`);

    const actions: string[] = [];

    // 执行一键务农 (除草+除虫+浇水) - 串行执行以降低并发压力
    if (opType === 'all' || opType === 'clear') {
        // 检查是否跳过一键务农（仅自动模式生效，手动clear不受影响）
        const skipOwnWeedBug = opType === 'all' && isAutomationOn('skip_own_weed_bug');
        let farmingLandIds = [...new Set([
            ...status.needWeed,
            ...status.needBug,
            ...status.needWater,
            ...status.needInteractionCleanup,
        ])];

        const validSingleLandIds = new Set<number>([
            ...status.growing,
            ...status.harvestable,
            ...status.dead,
        ]);
        if (hasTargetLandId) {
            if (!validSingleLandIds.has(targetLandId)) {
                throw new Error(`土地#${targetLandId} 当前不能执行务农`);
            }
            const targetNeedsFarming = farmingLandIds.includes(targetLandId);
            farmingLandIds = targetNeedsFarming || socialEventItemIds.length > 0 ? [targetLandId] : [];
        } else if (socialEventItemIds.length > 0 && farmingLandIds.length === 0) {
            // 青蛙属于农场级事件，但 Farming 仍需携带一块有效作物地；官方单点抓包也是该结构。
            const fallbackLandId = status.growing[0] || status.harvestable[0] || status.dead[0] || 0;
            if (fallbackLandId > 0) farmingLandIds = [fallbackLandId];
        }

        if (!skipOwnWeedBug && farmingLandIds.length > 0) {
            try {
                await runFarmPhase('farming', () => farming(farmingLandIds, socialEventItemIds));
                const parts: string[] = [];
                if (status.needWeed.length) parts.push(`草${status.needWeed.length}`);
                if (status.needBug.length) parts.push(`虫${status.needBug.length}`);
                if (status.needWater.length) parts.push(`水${status.needWater.length}`);
                if (status.needInteractionCleanup.length) parts.push(`道具${status.needInteractionCleanup.length}`);
                if (socialEventItemIds.length) parts.push(`青蛙${socialEventItemIds.length}`);
                actions.push(hasTargetLandId
                    ? `单点务农#${targetLandId}${parts.length ? `(${parts.join('/')})` : ''}`
                    : `一键务农${parts.join('/')}`);
                recordOperation('farming', farmingLandIds.length);
            } catch (e: any) {
                logWarn(hasTargetLandId ? '单点务农' : '一键务农', e.message);
                if (hasTargetLandId) throw e;
            }
        }
    }

    // 执行收获
    let harvestedLandIds: number[] = [];
    let harvestReply: any = null;
    let postHarvest: any = null;
    if (opType === 'all' || opType === 'harvest') {
        if (status.harvestable.length > 0) {
            try {
                harvestReply = await runFarmPhase('harvest', () => harvest(status.harvestable));
                log('收获', `收获完成 ${status.harvestable.length} 块土地`, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'ok',
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                });
                actions.push(`收获${status.harvestable.length}`);
                recordOperation('harvest', status.harvestable.length);
                harvestedLandIds = [...status.harvestable];
                networkEvents.emit('farmHarvested', {
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                    opType,
                });
            } catch (e: any) {
                logWarn('收获', e.message, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'error',
                });
            }
        }
    }

    // 执行种植
    if (opType === 'all' || opType === 'plant') {
        const allEmptyLands: number[] = [...new Set(status.empty)] as number[];
        let allDeadLands: number[] = [...new Set(status.dead)] as number[];

        if (opType === 'all' && harvestedLandIds.length > 0) {
            postHarvest = await runFarmPhase('post-harvest', async () => {
                await randomDelay(1000, 1500);
                return resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
            });
            allDeadLands = [...new Set([...allDeadLands, ...postHarvest.removable])];
        }
        // 注意：如果是单纯点"一键种植"，harvestedLandIds 为空，只种当前的空地/死地
        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                const plantCount = allDeadLands.length + allEmptyLands.length;
                await runFarmPhase('plant', () => autoPlantEmptyLands(allDeadLands, allEmptyLands));
                actions.push(`种植${plantCount}`);
                recordOperation('plant', plantCount);
            } catch (e: any) { logWarn('种植', e.message); }
        }
    }
    if (opType === 'all' && postHarvest && Array.isArray(postHarvest.growing) && postHarvest.growing.length > 0 && isAutomationOn('fertilizer_multi_season')) {
        const multiSeasonTargets: number[] = [...new Set(postHarvest.growing.map((v: any) => toNum(v)).filter(Boolean))] as number[];
        if (multiSeasonTargets.length > 0) {
            log('施肥', `检测到多季作物进入后续季，准备执行多季补肥，目标地块 ${multiSeasonTargets.length} 块`, {
                module: 'farm',
                event: '多季节施肥',
                result: 'trigger',
                count: multiSeasonTargets.length,
                landIds: multiSeasonTargets,
            });
            try {
                await runFarmPhase(
                    'fertilize-multi-season',
                    () => runFertilizerByConfig(multiSeasonTargets, { reason: 'multi_season' }),
                );
            } catch (e: any) {
                logWarn('施肥', `多季补肥执行失败: ${e.message}`, {
                    module: 'farm',
                    event: '多季节施肥',
                    result: 'error',
                });
            }
        }
    }

    // 执行土地解锁/升级（手动 upgrade 总是执行；自动 all 受开关控制）
    const shouldAutoUpgrade = opType === 'all' && isAutomationOn('land_upgrade');
    if (shouldAutoUpgrade || opType === 'upgrade') {
        if (status.unlockable.length > 0) {
            let unlocked: number = 0;
            await runFarmPhase('unlock', async () => {
                for (const landId of status.unlockable) {
                    try {
                        await unlockLand(landId, false);
                        log('解锁', `土地#${landId} 解锁成功`, {
                            module: 'farm', event: '解锁土地', result: 'ok', landId
                        });
                        unlocked++;
                    } catch (e: any) {
                        logWarn('解锁', `土地#${landId} 解锁失败: ${e.message}`, {
                            module: 'farm', event: '解锁土地', result: 'error', landId
                        });
                    }
                    await randomDelay(1000, 1500);
                }
            });
            if (unlocked > 0) {
                actions.push(`解锁${unlocked}`);
            }
        }

        if (status.upgradable.length > 0) {
            let upgraded: number = 0;
            await runFarmPhase('upgrade', async () => {
                for (const landId of status.upgradable) {
                    try {
                        const reply = await upgradeLand(landId);
                        const newLevel = reply.land ? toNum(reply.land.level) : '?';
                        log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
                            module: 'farm', event: '升级土地', result: 'ok', landId, level: newLevel
                        });
                        upgraded++;
                    } catch (e: any) {
                        log('升级', `土地#${landId} 升级失败: ${e.message}`, {
                            module: 'farm', event: '升级土地', result: 'error', landId
                        });
                    }
                    await randomDelay(1000, 1500);
                }
            });
            if (upgraded > 0) {
                actions.push(`升级${upgraded}`);
                recordOperation('upgrade', upgraded);
            }
        }
    }

    if (opType === 'all') {
        const fertilizerConfig = getAutomation().fertilizer || 'none';
        if (fertilizerConfig === 'smart') {
            try {
                const result = await runFarmPhase(
                    'fertilize-smart',
                    () => runFertilizerByConfig([], { skipNormal: true }),
                );
                if (result.organic > 0) {
                    actions.push(`有机肥${result.organic}`);
                    await harvestMatureOwnLandsOnce(actions);
                }
            } catch (e: any) {
                logWarn('施肥', `巡田时施肥失败: ${e.message}`);
            }
        }
    }
    // 日志
    const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
    if (actions.length > 0) {
         log('农场', `[${statusParts.join(' ')}]${actionStr}`, {
             module: 'farm', event: '农场循环', opType, actions
         });
    }
    return { hadWork: actions.length > 0, actions };
}

function scheduleNextFarmCheck(delayMs: number = CONFIG.farmCheckInterval): void {
    if (externalSchedulerMode) return;
    if (!farmLoopRunning) return;
    farmScheduler.setTimeoutTask('farm_check_loop', Math.max(0, delayMs), async () => {
        if (!farmLoopRunning) return;
        await checkFarm();
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(CONFIG.farmCheckInterval);
    });
}

function startFarmCheckLoop(options: { externalScheduler?: boolean } = {}): void {
    if (farmLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    farmLoopRunning = true;
    networkEvents.on('landsChanged', onLandsChangedPush);
    networkEvents.on('farmSocialEventsChanged', onFarmSocialEventsChangedPush);
    if (!externalSchedulerMode) {
        scheduleNextFarmCheck(2000);
    }
    // 启动化肥自动购买检测定时器
    startFertilizerBuyCheckTimer();
}

function onLandsChangedPush(lands: any[]): void {
    if (!isAutomationOn('farm_push')) {
        return;
    }
    const now: number = Date.now();
    if (now - lastPushTime < 500) return;
    lastPushTime = now;
    log('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
        module: 'farm', event: '土地推送通知', result: 'trigger_check', count: lands.length
    });
    farmScheduler.setTimeoutTask('farm_push_check', 100, async () => {
        await checkFarm({ priority: 'event' });
    });
}

function onFarmSocialEventsChangedPush(events: any[]): void {
    if (!isAutomationOn('farm_push')) return;
    const now: number = Date.now();
    if (now - lastPushTime < 500) return;
    lastPushTime = now;
    const count = Array.isArray(events) ? events.length : 0;
    log('农场', `收到农场社交事件推送: ${count}个，检查中...`, {
        module: 'farm', event: '农场社交事件通知', result: 'trigger_check', count
    });
    farmScheduler.setTimeoutTask('farm_push_check', 100, async () => {
        await checkFarm({ priority: 'event' });
    });
}

function stopFarmCheckLoop(): void {
    farmLoopRunning = false;
    externalSchedulerMode = false;
    farmScheduler.clearAll();
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
    networkEvents.removeListener('farmSocialEventsChanged', onFarmSocialEventsChangedPush);
    // 停止化肥自动购买检测定时器
    stopFertilizerBuyCheckTimer();
}

function refreshFarmCheckLoop(delayMs: number = 200): void {
    if (!farmLoopRunning) return;
    scheduleNextFarmCheck(delayMs);
}

// ============ 化肥自动购买定时检测 ============
function startFertilizerBuyCheckTimer(): void {
    farmScheduler.clear('fertilizer_buy_check');

    // 检查是否有开启的化肥购买功能
    if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) {
        return;
    }

    // 设置定时检测
    const intervalMinutes: number = getFertilizerBuyCheckIntervalMinutes();
    const intervalMs: number = intervalMinutes * 60 * 1000;

    farmScheduler.setIntervalTask('fertilizer_buy_check', intervalMs, checkFertilizerBuyOnce, {
        preventOverlap: true,
    });

    log('农场', `化肥自动购买检测定时器已启动，间隔 ${intervalMinutes} 分钟`, {
        module: 'farm',
        event: '购买化肥计时器',
        result: 'start',
        intervalMinutes,
    });
}

function stopFertilizerBuyCheckTimer(): void {
    farmScheduler.clear('fertilizer_buy_check');
    log('农场', '化肥自动购买检测定时器已停止', {
        module: 'farm',
        event: '购买化肥计时器',
        result: 'stop',
    });
}

async function runFertilizerBuyCheck(): Promise<void> {
    if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) {
        return;
    }

    try {
        const options = {
            buyOrganic: isAutomationOn('fertilizer_buy_organic'),
            buyNormal: isAutomationOn('fertilizer_buy_normal'),
            organicCount: getFertilizerBuyOrganicCount(),
            organicThresholdHours: getFertilizerBuyOrganicThresholdHours(),
            normalCount: getFertilizerBuyNormalCount(),
            normalThresholdHours: getFertilizerBuyNormalThresholdHours(),
        };

        await checkAndBuyFertilizerBoth(options);
    } catch (e: any) {
        logWarn('农场', `化肥自动购买检测失败: ${e.message}`, {
            module: 'farm',
            event: 'fertilizer_auto_buy',
            result: 'error',
            error: e.message,
        });
    }
}

async function checkFertilizerBuyOnce(): Promise<void> {
    return submitAccountTask('farm.fertilizer-buy', runFertilizerBuyCheck, {
        priority: 'maintenance',
        dedupeKey: 'farm.fertilizer-buy',
    });
}

module.exports = {
    checkFarm,
    runFarmOperation,
    scheduleNextFarmCheck,
    startFarmCheckLoop,
    onLandsChangedPush,
    onFarmSocialEventsChangedPush,
    stopFarmCheckLoop,
    refreshFarmCheckLoop,
    startFertilizerBuyCheckTimer,
    stopFertilizerBuyCheckTimer,
    checkFertilizerBuyOnce,
};
