export {};
/**
 * 农场循环调度 - 循环管理、可变状态
 */

const { CONFIG, PlantPhase } = require('../../config/config');
const { getPlantById, getItemById } = require('../../config/gameConfig');
const { isAutomationOn, getAutomation, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../../models/store');
const { getUserState, networkEvents } = require('../../utils/network');
const { toNum, toTimeSec, serverTimeToLocalMs, log, logWarn, randomDelay } = require('../../utils/utils');
const { runWithRequestClass } = require('../../utils/request-context');
const { createScheduler } = require('../scheduler');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { recordOperation } = require('../stats');
const { getAllLands, harvest, farming, unlockLand, upgradeLand } = require('./api');
const {
    analyzeLands,
    getCurrentPhase,
    isExplicitMaturePhase,
    getCleanableFarmSocialEventItemIds,
    getNormalFertilizerTargetsFromLands,
    resolveRemovableHarvestedLands,
    getLandTypeByLevel,
    normalizeFertilizerLandTypes,
    filterLandIdsByTypes,
    ALL_FERTILIZER_LAND_TYPES,
} = require('./land-analysis');
const { autoPlantEmptyLands, getRemainingPlantDelayMs, runFertilizerByConfig } = require('./planting');
const { isRipeningOnlyMode, runRipeningFertilizer } = require('./ripening');
const { checkAndBuyFertilizerBoth } = require('../mall');
// 延迟加载以打破循环依赖: visit-strategy → farm/index → scheduler → visit-strategy
function inFarmQuietHours() {
    return require('../friend/visit-strategy').inFarmQuietHours();
}

// ============ 内部状态 ============
let isCheckingFarm: boolean = false;
let isFirstFarmCheck: boolean = true;
let farmLoopRunning: boolean = false;
let externalSchedulerMode: boolean = false;
let farmLoopGeneration = 0;
let automaticPlantPacing: any = { lastPlantAt: null, defer: true };
const farmScheduler = createScheduler('farm');
const landDeadlines = new Map<number, { at: number; plantId: number }>();
const pendingHarvest = new Map<number, any>();
const lastHarvestAttempt = new Map<number, string>();
let maturityAt = Infinity;
let pushCheckAt = Infinity;
let scheduledAt = Infinity;
let wakeQueued = false;
let nextOrdinaryPushAt = 0;

// ============ 农场循环 ============

function canContinueFarm(generation: number): boolean {
    return generation === farmLoopGeneration
        && !!getUserState().gid && isAutomationOn('farm') && !inFarmQuietHours();
}

function cropKey(land: any): string {
    const plant = land.plant;
    return `${plant.id}:${plant.season}:${plant.phases[0].begin_time}`;
}

function maturePushKey(land: any): string {
    if (!land?.unlocked || !isExplicitMaturePhase(land.plant?.phases?.[0])) return '';
    const master = toNum(land.master_land_id);
    return master && master !== toNum(land.id) ? '' : cropKey(land);
}

function isTiangongCrop(plantId: number): boolean {
    return Number(getItemById(getPlantById(plantId)?.seed_id)?.rarity) === 4;
}

function armFarmWake(): void {
    const at = farmLoopRunning && canContinueFarm(farmLoopGeneration) ? Math.min(maturityAt, pushCheckAt) : Infinity;
    if (wakeQueued || isCheckingFarm || at === scheduledAt) return;
    farmScheduler.clear('farm_push_check');
    scheduledAt = at;
    if (!Number.isFinite(at)) return;
    const generation = farmLoopGeneration;
    farmScheduler.setTimeoutTask('farm_push_check', Math.max(0, at - Date.now()), async () => {
        scheduledAt = Infinity;
        wakeQueued = true;
        try {
            await runExclusiveAutomationTask('farm_push_check', async () => {
                if (generation !== farmLoopGeneration) return;
                if (!canContinueFarm(generation)) { pendingHarvest.clear(); pushCheckAt = Infinity; return; }
                if (Math.min(maturityAt, pushCheckAt) > Date.now()) return;
                await runWithRequestClass('farm', checkFarm);
            }, { detached: true });
        } finally {
            if (generation === farmLoopGeneration) { wakeQueued = false; armFarmWake(); }
        }
    });
}

function rememberMaturity(land: any): void {
    const id = toNum(land.id);
    landDeadlines.delete(id);
    const master = toNum(land.master_land_id);
    const phases = land.plant?.phases;
    if (!land.unlocked || (master && master !== id) || !phases || phases.length < 2) return;
    const plantId = toNum(land.plant.id);
    const current = getCurrentPhase(phases, false, '', plantId)?.phase;
    if (!current || current === PlantPhase.MATURE || current === PlantPhase.DEAD) return;
    const last = phases[phases.length - 1];
    const mature = phases.find(isExplicitMaturePhase)
        || (getCurrentPhase([last], false, '', plantId)?.phase === PlantPhase.MATURE ? last : null);
    if (!mature) return;
    const now = Date.now();
    const due = serverTimeToLocalMs(toTimeSec(mature.begin_time) * 1000);
    // 到点仍报生长中时，在成熟时刻后的 300ms 补查一次。
    const at = due > now ? due : due + 300;
    if (at > now) landDeadlines.set(id, { at, plantId });
}

function updateMaturityWake(): void {
    const skipTiangong = getAutomation().farm_harvest_tiangong === false;
    maturityAt = Infinity;
    for (const { at, plantId } of landDeadlines.values()) {
        if (!skipTiangong || !isTiangongCrop(plantId)) maturityAt = Math.min(maturityAt, at);
    }
    armFarmWake();
}

function observeFarmLands(lands: any[], full = false): void {
    if (full) {
        landDeadlines.clear();
        for (const [id, pending] of pendingHarvest) {
            const current = lands.find(land => toNum(land.id) === id);
            if (maturePushKey(current) !== cropKey(pending)) pendingHarvest.delete(id);
        }
    }
    for (const land of lands) {
        rememberMaturity(land);
        if (!full) pendingHarvest.delete(toNum(land.id));
    }
    updateMaturityWake();
}

function schedulePlantContinuation(generation: number, pacing: any, delayMs?: number): void {
    if (!farmLoopRunning || !canContinueFarm(generation) || pacing !== automaticPlantPacing || !pacing.deferred) return;
    farmScheduler.setTimeoutTask('farm_plant_continue', delayMs ?? getRemainingPlantDelayMs(pacing), async () => {
        // 计时器会继承创建时的异步上下文，必须独立入队，不能当作旧锁的重入。
        await runExclusiveAutomationTask('farm_plant_continue', async () => {
            if (!farmLoopRunning || !canContinueFarm(generation) || pacing !== automaticPlantPacing) return;
            await checkFarm();
        }, { detached: true });
    });
}

async function checkFarm(): Promise<boolean> {
    const state = getUserState();
    if (isCheckingFarm || !state.gid || !isAutomationOn('farm')) return false;
    if (inFarmQuietHours()) return false;
    const generation = farmLoopGeneration;
    const pacing = automaticPlantPacing;
    farmScheduler.clear('farm_plant_continue');
    pacing.deferred = false;
    isCheckingFarm = true;
    if (pushCheckAt <= Date.now()) nextOrdinaryPushAt = Date.now() + 500;
    pushCheckAt = Infinity;
    if (maturityAt <= Date.now()) {
        for (const [id, deadline] of landDeadlines) if (deadline.at <= Date.now()) landDeadlines.delete(id);
        updateMaturityWake();
    }

    try {
        // 复用手动操作逻辑
        const result = await runFarmOperation('all', null, false, { generation, pacing });
        isFirstFarmCheck = false;
        return !!(result && result.hadWork);
    } catch (err: any) {
        logWarn('巡田', `检查失败: ${err.message}`);
        return false;
    } finally {
        isCheckingFarm = false;
        schedulePlantContinuation(generation, pacing);
        armFarmWake();
    }
}

async function runMultiSeasonFertilizer(growingLandIds: any[], propagateErrors: boolean = false): Promise<void> {
    if (!isAutomationOn('fertilizer_multi_season')) return;
    const mode = getAutomation().fertilizer;
    if (mode === 'none' || isRipeningOnlyMode(mode)) return;
    const multiSeasonTargets: number[] = [...new Set(
        (Array.isArray(growingLandIds) ? growingLandIds : []).map((v: any) => toNum(v)).filter(Boolean),
    )];
    if (multiSeasonTargets.length === 0) return;

    log('施肥', `检测到多季作物进入后续季，准备执行多季补肥，目标地块 ${multiSeasonTargets.length} 块`, {
        module: 'farm',
        event: '多季节施肥',
        result: 'trigger',
        count: multiSeasonTargets.length,
        landIds: multiSeasonTargets,
    });
    try {
        await runFertilizerByConfig(multiSeasonTargets, { reason: 'multi_season', propagateErrors });
    } catch (e: any) {
        logWarn('施肥', `多季补肥执行失败: ${e.message}`, {
            module: 'farm',
            event: '多季节施肥',
            result: 'error',
        });
        if (propagateErrors) throw e;
    }
}

function autoHarvestLandIds(status: any): number[] {
    if (getAutomation().farm_harvest_tiangong !== false) return status.harvestable;
    const tiangongLandIds = new Set(status.harvestableInfo
        .filter((info: any) => isTiangongCrop(info.plantId))
        .map((info: any) => info.landId));
    return status.harvestable.filter((id: number) => !tiangongLandIds.has(id));
}

/**
 * 催熟施肥后只重查并收获一次，避免形成请求循环。
 * 跟随收获也会走多季补肥：这批作物进入下一季后，主循环里的补肥已经跑完了。
 */
async function harvestMatureOwnLandsOnce(actions: string[], propagateErrors: boolean = false): Promise<number> {
    let latest: any;
    try {
        latest = await getAllLands();
    } catch (e: any) {
        logWarn('收获', `施肥后刷新土地失败: ${e.message}`);
        if (propagateErrors) throw e;
        return 0;
    }

    const lands = Array.isArray(latest && latest.lands) ? latest.lands : [];
    if (lands.length === 0) return 0;

    const ownGid = toNum(getUserState().gid);
    const harvestable = autoHarvestLandIds(analyzeLands(lands, false, ownGid));
    if (harvestable.length === 0) return 0;

    try {
        const harvestReply = await harvest(harvestable);
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
        const classified = await resolveRemovableHarvestedLands(harvestable, harvestReply);
        await runMultiSeasonFertilizer(classified.growing, propagateErrors);
        return harvestable.length;
    } catch (e: any) {
        logWarn('收获', `施肥后立即收获失败: ${e.message}`, {
            module: 'farm',
            event: '施肥后收获作物',
            result: 'error',
        });
        if (propagateErrors) throw e;
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
    propagateErrors: boolean = false,
    automatic?: { generation: number; pacing: any },
): Promise<{ hadWork: boolean; actions: string[] }> {
    const actions: string[] = [];
    const harvestedLandIds: number[] = [];
    const harvestReply: { land: any[] } = { land: [] };
    const pushedIds = new Set<number>();
    async function collectHarvest(ids: number[], source: any[], isAll: boolean): Promise<void> {
        if (!ids.length) return;
        for (const land of source) {
            if (ids.includes(toNum(land.id))) lastHarvestAttempt.set(toNum(land.id), cropKey(land));
        }
        try {
            const reply = await harvest(ids, isAll);
            const updated = reply.land || [];
            const completed = isAll ? ids : ids.filter(id => updated.some((land: any) => toNum(land.id) === id));
            if (!completed.length) return;
            harvestedLandIds.push(...completed);
            harvestReply.land.push(...updated);
            const count = completed.length;
            log('收获', `收获完成 ${count} 块土地`, { module: 'farm', event: '收获作物', result: 'ok', count, landIds: completed });
            actions.push(`收获${count}`);
            recordOperation('harvest', count);
            networkEvents.emit('farmHarvested', { count, landIds: completed, opType });
        } catch (e: any) {
            logWarn('收获', e.message, { module: 'farm', event: '收获作物', result: 'error' });
            if (propagateErrors) throw e;
        }
    }
    if (automatic && pendingHarvest.size) {
        const lands = [...pendingHarvest.values()].filter(land => lastHarvestAttempt.get(toNum(land.id)) !== cropKey(land));
        pendingHarvest.clear();
        if (lands.length && isAutomationOn('farm_push')) {
            const ids = autoHarvestLandIds(analyzeLands(lands, false, getUserState().gid));
            for (const id of ids) pushedIds.add(id);
            await collectHarvest(ids, lands, false);
        }
    }
    const landsReply = await getAllLands();
    if (automatic && !canContinueFarm(automatic.generation)) return { hadWork: actions.length > 0, actions };
    if (!landsReply.lands || landsReply.lands.length === 0) {
        if (opType !== 'all') {
            log('农场', '没有土地数据');
        }
        return { hadWork: actions.length > 0, actions };
    }

    const lands = landsReply.lands;
    let fertilizerSnapshot: any[] | undefined = lands;

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

    const harvestFromRead = async () => {
        const candidates: number[] = opType === 'all' ? autoHarvestLandIds(status) : status.harvestable;
        const ids = candidates.filter(id => !pushedIds.has(id));
        if (ids.length) {
            fertilizerSnapshot = undefined;
            await collectHarvest(ids, lands, !pushedIds.size && ids.length === status.harvestable.length);
        }
    };
    if (automatic) await harvestFromRead();

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
            fertilizerSnapshot = undefined;
            try {
                await farming(farmingLandIds, socialEventItemIds);
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
                if (hasTargetLandId || propagateErrors) throw e;
            }
        }
    }

    // 执行收获
    let postHarvest: any = null;
    if (!automatic && (opType === 'all' || opType === 'harvest')) await harvestFromRead();

    // 执行种植
    if (opType === 'all' || opType === 'plant') {
        const allEmptyLands: number[] = [...new Set(status.empty)] as number[];
        let allDeadLands: number[] = [...new Set(status.dead)] as number[];

        if (opType === 'all' && harvestedLandIds.length > 0) {
            // 收获后延迟再铲除枯地
            await randomDelay(1000, 1500);
            postHarvest = await resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
            allDeadLands = [...new Set([...allDeadLands, ...postHarvest.removable])];
        }
        // 注意：如果是单纯点"一键种植"，harvestedLandIds 为空，只种当前的空地/死地
        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                if (automatic && !canContinueFarm(automatic.generation)) return { hadWork: actions.length > 0, actions };
                fertilizerSnapshot = undefined;
                const plantResult = await autoPlantEmptyLands(allDeadLands, allEmptyLands, {
                    propagateErrors, knownLands: lands,
                    pacing: automatic ? automatic.pacing : { lastPlantAt: null, delaySeconds: 0 },
                });
                const plantedCount = Array.isArray(plantResult?.plantedLands) ? plantResult.plantedLands.length : 0;
                const deferredCount = Array.isArray(plantResult?.deferredLandIds) ? plantResult.deferredLandIds.length : 0;
                if (plantedCount > 0) {
                    actions.push(`种植${plantedCount}`);
                    recordOperation('plant', plantedCount);
                }
                if (deferredCount > 0) actions.push(`预留${deferredCount}`);
            } catch (e: any) {
                logWarn('种植', e.message);
                if (propagateErrors) throw e;
            }
        }
    }
    if (opType === 'all' && postHarvest && Array.isArray(postHarvest.growing) && postHarvest.growing.length > 0) {
        await runMultiSeasonFertilizer(postHarvest.growing, propagateErrors);
    }

    // 执行土地解锁/升级（手动 upgrade 总是执行；自动 all 受开关控制）
    const shouldAutoUpgrade = opType === 'all' && isAutomationOn('land_upgrade');
    if (shouldAutoUpgrade || opType === 'upgrade') {
        if (status.unlockable.length > 0 || status.upgradable.length > 0) fertilizerSnapshot = undefined;
        if (status.unlockable.length > 0) {
            let unlocked: number = 0;
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
                    if (propagateErrors) throw e;
                }
                await randomDelay(1000, 1500);
            }
            if (unlocked > 0) {
                actions.push(`解锁${unlocked}`);
            }
        }

        if (status.upgradable.length > 0) {
            let upgraded: number = 0;
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
                    if (propagateErrors) throw e;
                }
                await randomDelay(1000, 1500);
            }
            if (upgraded > 0) {
                actions.push(`升级${upgraded}`);
                recordOperation('upgrade', upgraded);
            }
        }
    }

    if (opType === 'all') {
        if (automatic && !canContinueFarm(automatic.generation)) return { hadWork: actions.length > 0, actions };
        const automation = getAutomation();
        const fertilizerConfig = automation.fertilizer || 'none';
        const canApplyNormal = fertilizerConfig === 'normal'
            || fertilizerConfig === 'both'
            || fertilizerConfig === 'smart';
        if (isAutomationOn('fertilizer_multi_season') && canApplyNormal) {
            try {
                const latest = fertilizerSnapshot ?? (await getAllLands())?.lands;
                const latestLands = Array.isArray(latest) ? latest : [];
                fertilizerSnapshot = latestLands;
                let targets = getNormalFertilizerTargetsFromLands(latestLands);
                // 先按施肥土地范围过滤，避免范围外地块每轮都触发"检测到但目标为空"的无效调用。
                // 过滤规则与 runFertilizerByConfig 内部一致：勾满全部类型视为不限制；确认不了土地类型时跳过本轮。
                const selectedLandTypes = normalizeFertilizerLandTypes(getAutomation().fertilizer_land_types);
                if (selectedLandTypes.length > 0 && selectedLandTypes.length < ALL_FERTILIZER_LAND_TYPES.length) {
                    const landTypeById = new Map<number, string>();
                    for (const land of latestLands) {
                        if (!land) continue;
                        const landId = toNum(land.id);
                        if (!landId) continue;
                        landTypeById.set(landId, getLandTypeByLevel(land.level));
                    }
                    targets = landTypeById.size > 0
                        ? filterLandIdsByTypes(targets, landTypeById, selectedLandTypes)
                        : [];
                }
                if (targets.length > 0) {
                    log('施肥', `巡田补肥：检测到 ${targets.length} 块地仍可施普通化肥`, {
                        module: 'farm',
                        event: '多季节施肥',
                        result: 'trigger',
                        count: targets.length,
                        landIds: targets,
                    });
                    fertilizerSnapshot = undefined;
                    const result = await runFertilizerByConfig(targets, { reason: 'multi_season', propagateErrors });
                    if (result.normal > 0) actions.push(`补肥${result.normal}`);
                }
            } catch (e: any) {
                logWarn('施肥', `巡田补肥失败: ${e.message}`, {
                    module: 'farm',
                    event: '多季节施肥',
                    result: 'error',
                });
                if (propagateErrors) throw e;
            }
        }
        if (fertilizerConfig === 'smart' || isRipeningOnlyMode(fertilizerConfig)) {
            try {
                const count = await runRipeningFertilizer(getAutomation(), fertilizerSnapshot, propagateErrors);
                if (count > 0) {
                    actions.push(`催熟${count}`);
                    await harvestMatureOwnLandsOnce(actions, propagateErrors);
                }
            } catch (e: any) {
                logWarn('施肥', `巡田时施肥失败: ${e.message}`);
                if (propagateErrors) throw e;
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
        await runExclusiveAutomationTask('farm_check_loop', checkFarm);
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(CONFIG.farmCheckInterval);
    });
}

function startFarmCheckLoop(options: { externalScheduler?: boolean } = {}): void {
    if (farmLoopRunning) return;
    farmLoopGeneration++;
    externalSchedulerMode = !!options.externalScheduler;
    farmLoopRunning = true;
    networkEvents.on('ownFarmLandsUpdated', observeFarmLands);
    networkEvents.on('landsChanged', onLandsChangedPush);
    networkEvents.on('farmSocialEventsChanged', onFarmSocialEventsChangedPush);
    if (!externalSchedulerMode) {
        scheduleNextFarmCheck(2000);
    }
    // 启动化肥自动购买检测定时器
    startFertilizerBuyCheckTimer();
}

function queuePushCheck(urgent: boolean, social: boolean, count: number): void {
    if (!canContinueFarm(farmLoopGeneration) || (isCheckingFarm && !urgent)) return;
    const now = Date.now();
    const at = urgent ? now : Math.max(now + 100, nextOrdinaryPushAt);
    if (at >= pushCheckAt) return;
    pushCheckAt = at;
    log('农场', social ? `收到农场社交事件推送: ${count}个，检查中...` : `收到推送: ${count}块土地变化，检查中...`, {
        module: 'farm', event: social ? '农场社交事件通知' : '土地推送通知', result: 'trigger_check', count,
    });
    armFarmWake();
}

function onLandsChangedPush(lands: any[], hostGid?: number): void {
    const own = !!hostGid && hostGid === getUserState().gid;
    const enabled = isAutomationOn('farm_push') && canContinueFarm(farmLoopGeneration);
    for (const land of lands) {
        const id = toNum(land.id);
        pendingHarvest.delete(id);
        if (!own) continue;
        rememberMaturity(land);
        const key = enabled && maturePushKey(land);
        if (key && lastHarvestAttempt.get(id) !== key
            && (getAutomation().farm_harvest_tiangong !== false || !isTiangongCrop(toNum(land.plant.id)))) pendingHarvest.set(id, land);
    }
    if (own) updateMaturityWake();
    if (enabled) queuePushCheck(pendingHarvest.size > 0, false, lands.length);
}

function onFarmSocialEventsChangedPush(events: any[]): void {
    if (isAutomationOn('farm_push')) queuePushCheck(false, true, events.length);
}

function stopFarmCheckLoop(): void {
    farmLoopRunning = false;
    farmLoopGeneration++;
    automaticPlantPacing = { lastPlantAt: null, defer: true };
    externalSchedulerMode = false;
    landDeadlines.clear();
    pendingHarvest.clear();
    lastHarvestAttempt.clear();
    maturityAt = pushCheckAt = scheduledAt = Infinity;
    nextOrdinaryPushAt = 0;
    wakeQueued = false;
    farmScheduler.clearAll();
    networkEvents.removeListener('ownFarmLandsUpdated', observeFarmLands);
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
    networkEvents.removeListener('farmSocialEventsChanged', onFarmSocialEventsChangedPush);
    // 停止化肥自动购买检测定时器
    stopFertilizerBuyCheckTimer();
}

function refreshFarmCheckLoop(delayMs: number = 200): void {
    if (!farmLoopRunning) return;
    if (!canContinueFarm(farmLoopGeneration) || !isAutomationOn('farm_push')) {
        pendingHarvest.clear();
        pushCheckAt = Infinity;
    }
    updateMaturityWake();
    if (farmScheduler.has('farm_plant_continue')) {
        farmScheduler.clear('farm_plant_continue');
        schedulePlantContinuation(farmLoopGeneration, automaticPlantPacing, delayMs);
    }
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

    farmScheduler.setIntervalTask('fertilizer_buy_check', intervalMs, () => {
        runExclusiveAutomationTask('fertilizer_buy_check', checkFertilizerBuyOnce).catch(() => null);
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

async function checkFertilizerBuyOnce(): Promise<void> {
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
