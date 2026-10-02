export {};
/**
 * 土地分析 - 纯分析函数 + 阶段/生命周期
 */

const { PlantPhase, PHASE_NAMES } = require('../../config/config');
const {
    getPlantName,
    getPlantExp,
    getPlantById,
    getSeedImageBySeedId,
    getPlantGrowTime,
    getPlantGrowPhases,
    getItemById,
    getMutantEffectsByIds,
    getMutantDisplayPlantId,
} = require('../../config/gameConfig');
const { toNum, toTimeSec, getServerTimeSec, log, logWarn } = require('../../utils/utils');

const MATURE_PHASE_RECORD_ID = 19;
const { buildLandUpgradeDetail } = require('./land-upgrade');

function int64String(value: any): string {
    if (value == null) return '0';
    const text = String(value?.toString?.() ?? value).trim();
    return /^-?\d+$/.test(text) ? text : '0';
}

// 本季普通（无机）肥剩余可施次数；proto3 下 0 不落盘，缺省或 <=0 表示本季已施过。
function getLeftInorcFertTimes(plant: any): number | null {
    if (!plant || !Object.hasOwn(plant, 'left_inorc_fert_times')) {
        return null;
    }
    return toNum(plant.left_inorc_fert_times);
}

function canApplyNormalFertilizer(plant: any): boolean {
    return (getLeftInorcFertTimes(plant) || 0) > 0;
}

function normalizePositiveId(value: any): string {
    const text = int64String(value);
    return /^\d+$/.test(text) && text !== '0' ? text : '';
}

function getPlantStatusFlags(
    plant: any,
    currentPhase: any,
    nowSec: number = getServerTimeSec(),
    options: { ownGid?: number; ignoreOwnEffects?: boolean } = {},
): { needWater: boolean; needWeed: boolean; needBug: boolean } {
    const phase = currentPhase || {};
    const ownerIds = (values: any[]): number[] => (Array.isArray(values) ? values : [])
        .map((value: any) => toNum(value));
    const ownGid = toNum(options.ownGid);
    const ignoreOwnEffects = !!options.ignoreOwnEffects && ownGid > 0;
    const hasForeignOwner = (values: any[]): boolean => {
        const ids = ownerIds(values);
        if (ids.length === 0) return false;
        if (!ignoreOwnEffects) return true;
        return ids.some(id => id !== ownGid);
    };

    const dryTime = toTimeSec(phase.dry_time);
    const weedsTime = toTimeSec(phase.weeds_time);
    const insectTime = toTimeSec(phase.insect_time);
    return {
        needWater: toNum(plant?.dry_num) > 0 || (dryTime > 0 && dryTime <= nowSec),
        needWeed: hasForeignOwner(plant?.weed_owners) || (weedsTime > 0 && weedsTime <= nowSec),
        needBug: hasForeignOwner(plant?.insect_owners) || (insectTime > 0 && insectTime <= nowSec),
    };
}

function getPlantMutantConfigIds(plant: any, currentPhase: any = null): string[] {
    const values: any[] = [];
    if (Array.isArray(plant?.mutant_config_ids)) values.push(...plant.mutant_config_ids);
    if (Array.isArray(currentPhase?.mutants)) {
        values.push(...currentPhase.mutants.map((mutant: any) => mutant?.mutant_config_id));
    } else if (Array.isArray(plant?.phases)) {
        for (const phase of plant.phases) {
            if (Array.isArray(phase?.mutants)) {
                values.push(...phase.mutants.map((mutant: any) => mutant?.mutant_config_id));
            }
        }
    }
    if (Array.isArray(plant?.extended_mutations)) {
        values.push(...plant.extended_mutations.map((record: any) => record?.mutant_config_id));
    }
    return [...new Set(values.map(normalizePositiveId).filter(Boolean))];
}

// 抓包确认：黄金虫、足球和乌云由农场主通过自家 Farming 清理，好友帮助务农不能代为清理。
// 乌云必须以 interaction_uses / interaction_targets 的实时记录为准；field_40={8,1} 只是清理后仍保留的历史。
const OWNER_CLEANABLE_INTERACTION_ITEM_IDS = new Set(['301101', '301102', '5006']);

// 5005 青蛙是农场级事件，不绑定某一块土地；清理时通过 FarmingRequest.field 5 发送。
const OWNER_CLEANABLE_FARM_SOCIAL_EVENT_ITEM_IDS = new Set(['5005']);

const QIXI_DEW_ITEM_ID = '301103';
const QIXI_MUTANT_CONFIG_ID = '13';
const QIXI_DEW_HISTORY_CODES = new Set([9, 10]);

function getPlantExtendedStatuses(plant: any): any[] {
    if (Array.isArray(plant?.field_40)) return plant.field_40.filter(Boolean);
    // 兼容旧 proto 或测试数据中的单对象形式。
    return plant?.field_40 ? [plant.field_40] : [];
}

function getQixiDewExtendedStatus(plant: any): any | null {
    if (!getPlantMutantConfigIds(plant).includes(QIXI_MUTANT_CONFIG_ID)) return null;
    return getPlantExtendedStatuses(plant).find((status: any) => (
        QIXI_DEW_HISTORY_CODES.has(toNum(status?.value_1))
        && toNum(status?.value_2) === 1
    )) || null;
}

function getExtendedStatusInteractionItemId(plant: any): string {
    return getQixiDewExtendedStatus(plant) ? QIXI_DEW_ITEM_ID : '';
}

function getInteractionItemMetadata(itemId: string): { name: string; activityId: number } {
    const item = getItemById(Number(itemId));
    return {
        name: String(item?.name || `道具${itemId}`),
        activityId: toNum(item?.activity_id),
    };
}

function getCleanableFarmSocialEventItemIds(eventsOrReply: any): number[] {
    const events: any[] = Array.isArray(eventsOrReply)
        ? eventsOrReply
        : (Array.isArray(eventsOrReply?.social_events) ? eventsOrReply.social_events : []);
    return [...new Set(events
        .map((event: any) => normalizePositiveId(event?.item_id))
        .filter((itemId: string) => OWNER_CLEANABLE_FARM_SOCIAL_EVENT_ITEM_IDS.has(itemId))
        .map((itemId: string) => Number(itemId)))];
}

function buildFarmSocialEventDetails(eventsOrReply: any): any[] {
    const events: any[] = Array.isArray(eventsOrReply)
        ? eventsOrReply
        : (Array.isArray(eventsOrReply?.social_events) ? eventsOrReply.social_events : []);
    return events.map((event: any) => {
        const itemId = normalizePositiveId(event?.item_id);
        if (!itemId) return null;
        const metadata = getInteractionItemMetadata(itemId);
        return {
            itemId,
            itemName: metadata.name,
            activityId: metadata.activityId,
            visitorGid: normalizePositiveId(event?.visitor_gid),
            occurredAt: int64String(event?.timestamp),
            cleanable: OWNER_CLEANABLE_FARM_SOCIAL_EVENT_ITEM_IDS.has(itemId),
        };
    }).filter(Boolean);
}

function hasOwnerCleanableInteraction(plant: any): boolean {
    const uses: any[] = Array.isArray(plant?.interaction_uses) ? plant.interaction_uses : [];
    const targets: any[] = Array.isArray(plant?.interaction_targets) ? plant.interaction_targets : [];
    return [...uses, ...targets]
        .some((entry: any) => OWNER_CLEANABLE_INTERACTION_ITEM_IDS.has(normalizePositiveId(entry?.item_id)));
}

function getPlantInteractionEffects(plant: any): any[] {
    const uses: any[] = Array.isArray(plant?.interaction_uses) ? plant.interaction_uses : [];
    const targets: any[] = Array.isArray(plant?.interaction_targets) ? plant.interaction_targets : [];
    const effects: any[] = [];
    const usedTargetKeys = new Set<string>();

    const findTargets = (use: any): any[] => {
        const itemId = normalizePositiveId(use?.item_id);
        const hostGid = normalizePositiveId(use?.host_gid);
        const timestamp = int64String(use?.timestamp);
        const exact = targets.filter((target: any) => (
            normalizePositiveId(target?.item_id) === itemId
            && (!hostGid || normalizePositiveId(target?.host_gid) === hostGid)
            && (!timestamp || int64String(target?.timestamp) === timestamp)
        ));
        if (exact.length > 0) return exact;
        return targets.filter((target: any) => normalizePositiveId(target?.item_id) === itemId);
    };

    for (const use of uses) {
        const itemId = normalizePositiveId(use?.item_id);
        if (!itemId) continue;
        const itemMetadata = getInteractionItemMetadata(itemId);
        const matchingTargets = findTargets(use);
        const targetList = matchingTargets.length > 0 ? matchingTargets : [null];
        for (const target of targetList) {
            const landId = normalizePositiveId(target?.land_id);
            const hostGid = normalizePositiveId(target?.host_gid ?? use?.host_gid);
            const usedAt = int64String(target?.timestamp ?? use?.timestamp);
            const targetKey = target
                ? `${itemId}:${hostGid}:${usedAt}:${landId}`
                : `${itemId}:${hostGid}:${usedAt}:`;
            if (usedTargetKeys.has(targetKey)) continue;
            usedTargetKeys.add(targetKey);
            effects.push({
                itemId,
                itemName: itemMetadata.name,
                activityId: itemMetadata.activityId,
                effectType: toNum(use?.effect_type),
                landId,
                hostGid,
                usedAt,
                confirmed: true,
                source: 'protocol-land',
            });
        }
    }

    // 通常 use/target 成对出现；若服务端只返回 target，仍保留该实时当前态。
    for (const target of targets) {
        const itemId = normalizePositiveId(target?.item_id);
        if (!itemId) continue;
        const hostGid = normalizePositiveId(target?.host_gid);
        const usedAt = int64String(target?.timestamp);
        const landId = normalizePositiveId(target?.land_id);
        const targetKey = `${itemId}:${hostGid}:${usedAt}:${landId}`;
        if (usedTargetKeys.has(targetKey)) continue;
        usedTargetKeys.add(targetKey);
        const itemMetadata = getInteractionItemMetadata(itemId);
        effects.push({
            itemId,
            itemName: itemMetadata.name,
            activityId: itemMetadata.activityId,
            effectType: 0,
            landId,
            hostGid,
            usedAt,
            confirmed: true,
            source: 'protocol-land-target',
        });
    }

    const qixiDewStatus = getQixiDewExtendedStatus(plant);
    const extendedStatusItemId = qixiDewStatus ? QIXI_DEW_ITEM_ID : '';
    if (
        extendedStatusItemId
        && !effects.some(effect => String(effect.itemId) === extendedStatusItemId)
    ) {
        const itemMetadata = getInteractionItemMetadata(extendedStatusItemId);
        effects.push({
            itemId: extendedStatusItemId,
            itemName: itemMetadata.name,
            activityId: itemMetadata.activityId,
            effectType: toNum(qixiDewStatus?.value_1),
            landId: '',
            hostGid: '',
            confirmed: true,
            source: 'protocol-land-field-40',
        });
    }
    return effects;
}

function buildLandDetail(land: any, options: { friendMode?: boolean; landsMap?: Map<number, any>; nowSec?: number } = {}): any {
    const nowSec = Number(options.nowSec) || getServerTimeSec();
    const friendMode = !!options.friendMode;
    const landsMap = options.landsMap instanceof Map ? options.landsMap : buildLandMap([land]);
    const id = toNum(land?.id);
    const level = toNum(land?.level);
    const maxLevel = toNum(land?.max_level);
    const landsLevel = toNum(land?.lands_level);
    const landSize = toNum(land?.land_size);
    const landBuff = {
        plantYieldBonus: toNum(land?.buff?.plant_yield_bonus),
        plantingTimeReduction: toNum(land?.buff?.planting_time_reduction),
        plantExpBonus: toNum(land?.buff?.plant_exp_bonus),
    };
    const context = getDisplayLandContext(land, landsMap);
    const base: any = {
        id,
        unlocked: !!land?.unlocked,
        level,
        maxLevel,
        landsLevel,
        landSize,
        landBuff,
        landInfo: friendMode ? undefined : buildLandUpgradeDetail(land, landsMap),
        couldUnlock: !!land?.could_unlock,
        couldUpgrade: !!land?.could_upgrade,
        occupiedByMaster: !!context.occupiedByMaster,
        masterLandId: toNum(context.masterLandId),
        occupiedLandIds: Array.isArray(context.occupiedLandIds) ? context.occupiedLandIds : [],
        plantSize: 1,
        rarity: 0,
        mutantConfigIds: [],
        mutantEffects: [],
        isMutated: false,
        purpleCrystalResonanceExpBonus: 0,
        interactionEffects: [],
        needInteractionCleanup: false,
        protocolField40: null,
        leftInorcFertTimes: null,
    };
    if (!base.unlocked) {
        return {
            ...base,
            status: 'locked',
            plantName: '',
            phaseName: friendMode ? '未解锁' : '',
            currentSeason: 0,
            totalSeason: 0,
            occupiedByMaster: false,
            masterLandId: 0,
            occupiedLandIds: [],
        };
    }

    const sourceLand = context.sourceLand || land;
    const plant = sourceLand?.plant;
    if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) {
        return {
            ...base,
            status: 'empty',
            plantName: '',
            phaseName: friendMode ? '空地' : '空地',
            currentSeason: 0,
            totalSeason: 0,
        };
    }

    const currentPhase = getCurrentPhase(plant.phases, false, '', toNum(plant.id));
    if (!currentPhase) {
        return { ...base, status: 'empty', plantName: '', phaseName: '', currentSeason: 0, totalSeason: 0 };
    }
    const phaseVal = toNum(currentPhase.phase);
    const plantId = toNum(plant.id);
    const mutantConfigIds = getPlantMutantConfigIds(plant, currentPhase);
    const mutantEffects = getMutantEffectsByIds(mutantConfigIds);
    // 协议没有独立的“紫晶共鸣”布尔值：紫金土地由 level 标识，
    // 是否存在加成及具体比例必须以服务端 LandInfo.buff.plant_exp_bonus 为准。
    const purpleCrystalResonanceExpBonus = level === 5 && mutantConfigIds.length > 0
        ? Math.max(0, landBuff.plantExpBonus)
        : 0;
    const displayPlantId = getMutantDisplayPlantId(plantId, mutantConfigIds);
    const plantName = getPlantName(displayPlantId) || getPlantName(plantId) || plant.name || '未知';
    const plantCfg = getPlantById(plantId);
    const seedId = toNum(plantCfg?.seed_id);
    const plantSize = Math.max(1, toNum(plantCfg?.size) || toNum(sourceLand?.land_size) || landSize || 1);
    const totalSeason = Math.max(1, toNum(plantCfg?.seasons) || 1);
    const currentSeasonRaw = toNum(plant.season);
    const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
    const maturePhase = Array.isArray(plant.phases)
        ? plant.phases
            .filter((phase: any) => phase && toTimeSec(phase.begin_time) > 0)
            .sort((left: any, right: any) => toTimeSec(right.begin_time) - toTimeSec(left.begin_time))[0]
        : null;
    const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
    const matureInSec = matureBegin > nowSec ? matureBegin - nowSec : 0;
    const statusFlags = getPlantStatusFlags(plant, currentPhase, nowSec);
    let status = 'growing';
    if (phaseVal === PlantPhase.MATURE) status = friendMode ? (plant.stealable ? 'stealable' : 'harvested') : 'harvestable';
    else if (phaseVal === PlantPhase.DEAD) status = 'dead';
    else if (phaseVal === PlantPhase.UNKNOWN) status = 'empty';

    const protocolField40 = getPlantExtendedStatuses(plant).map((status: any) => ({
        value1: int64String(status?.value_1),
        value2: int64String(status?.value_2),
    }));

    return {
        ...base,
        status,
        plantId,
        displayPlantId,
        plantName,
        seedId,
        seedImage: seedId > 0 ? getSeedImageBySeedId(seedId) : '',
        phaseName: currentPhase.phaseName || PHASE_NAMES[phaseVal] || '',
        currentSeason,
        totalSeason,
        matureInSec,
        totalGrowTime: getPlantGrowTime(plantId),
        needWater: statusFlags.needWater,
        needWeed: statusFlags.needWeed,
        needBug: statusFlags.needBug,
        stealable: !!plant.stealable,
        plantSize,
        rarity: toNum(plant?.rarity ?? plant?.rare_level ?? plant?.rarity_level),
        mutantConfigIds,
        mutantEffects,
        isMutated: mutantConfigIds.length > 0,
        purpleCrystalResonanceExpBonus,
        interactionEffects: getPlantInteractionEffects(plant),
        needInteractionCleanup: hasOwnerCleanableInteraction(plant),
        protocolField40: protocolField40.length > 0 ? protocolField40 : null,
        leftInorcFertTimes: getLeftInorcFertTimes(plant),
    };
}

function getCurrentPhase(phases: any[], debug?: boolean, landLabel?: string, plantId: number = 0): any | null {
    if (!phases || phases.length === 0) return null;

    const nowSec: number = getServerTimeSec();
    const resolvedPlantId = toNum(plantId);

    if (debug) {
        console.warn(`    ${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`);
        const growPhases = getPlantGrowPhases(resolvedPlantId);
        for (let i = 0; i < phases.length; i++) {
            const p = phases[i];
            const bt = toTimeSec(p.begin_time);
            const phaseName = growPhases[toNum(p.phase) - 1]?.name
                || PHASE_NAMES[toNum(p.phase)]
                || `阶段${p.phase}`;
            const diff = bt > 0 ? (bt - nowSec) : 0;
            const diffStr = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
            console.warn(`    ${landLabel}   [${i}] ${phaseName}(${p.phase}) begin=${bt} ${diffStr} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`);
        }
    }

    const converted = convertServerPhaseToClient(phases, phases[0], resolvedPlantId);
    if (debug) {
        console.warn(`    ${landLabel}   → 当前阶段: ${converted?.phaseName || PHASE_NAMES[converted?.phase] || converted?.phase}`);
    }
    return converted;
}

/**
 * phases 是从当前阶段开始的配置后缀，因此当前配置下标等于：
 * grow_phases 总数 - 服务端剩余 phases 数。响应 phase 只表示生长中/成熟/枯死
 * 等粗状态，phase_id 是详细阶段类型，二者都不能直接作为配置数组下标。
 */
function convertServerPhaseToClient(phases: any[], serverPhaseInfo: any, plantId: number): any | null {
    if (!serverPhaseInfo) return null;
    const serverPhase = toNum(serverPhaseInfo.phase);
    const phaseRecordId = toNum(serverPhaseInfo.phase_id);
    const growPhases = getPlantGrowPhases(plantId);
    const remainingCount = Array.isArray(phases) ? phases.length : 0;
    const phaseIndex = growPhases.length > 0 && remainingCount > 0
        ? Math.max(0, growPhases.length - remainingCount)
        : -1;
    const configuredPhase = phaseIndex >= 0 ? growPhases[phaseIndex] : null;
    const isFinalConfiguredPhase = growPhases.length > 0 && phaseIndex === growPhases.length - 1;
    // 大多数作物成熟时 phase=6，但部分作物（例如最后阶段名为“盛开”的牵牛花）
    // 仍可能返回粗状态 2，或把详细阶段 ID 19 放进 phase。成熟阶段同时可由
    // phase_id=19 和 grow_phases 的最后一个剩余阶段确定，不能只依赖粗状态。
    const isMature = serverPhase !== PlantPhase.DEAD && (
        serverPhase === PlantPhase.MATURE
        || serverPhase === MATURE_PHASE_RECORD_ID
        || phaseRecordId === MATURE_PHASE_RECORD_ID
        || (isFinalConfiguredPhase && (
            serverPhase === PlantPhase.GERMINATION
            || serverPhase > PlantPhase.DEAD
        ))
    );
    const clientPhase = isMature ? PlantPhase.MATURE : serverPhase;
    const imagePhase = serverPhase === PlantPhase.DEAD ? PlantPhase.DEAD : phaseIndex + 1;
    const isKnownClientPhase = clientPhase >= PlantPhase.SEED && clientPhase <= PlantPhase.MATURE;
    if (!configuredPhase && serverPhase !== PlantPhase.DEAD && !isKnownClientPhase) {
        return {
            ...serverPhaseInfo,
            phase_index: phaseIndex,
            image_phase: 0,
            server_phase: serverPhase,
            phase_record_id: phaseRecordId,
            phase: PlantPhase.UNKNOWN,
            phaseName: '未知阶段',
        };
    }
    return {
        ...serverPhaseInfo,
        phase_index: phaseIndex,
        image_phase: configuredPhase ? imagePhase : clientPhase,
        server_phase: serverPhase,
        phase_record_id: phaseRecordId,
        phase: clientPhase,
        phaseName: serverPhase === PlantPhase.DEAD
            ? PHASE_NAMES[PlantPhase.DEAD]
            : (configuredPhase && configuredPhase.name) || PHASE_NAMES[clientPhase],
    };
}

function getOrganicFertilizerTargetsFromLands(lands: any[]): number[] {
    const list: any[] = Array.isArray(lands) ? lands : [];
    const targets: number[] = [];
    for (const land of list) {
        if (!land || !land.unlocked) continue;
        const landId = toNum(land.id);
        if (!landId) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const currentPhase = getCurrentPhase(plant.phases, false, '', toNum(plant.id));
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;

        targets.push(landId);
    }
    return targets;
}

function getNormalFertilizerTargetsFromLands(lands: any[]): number[] {
    const list: any[] = Array.isArray(lands) ? lands : [];
    const targets: number[] = [];
    for (const land of list) {
        if (!land || !land.unlocked) continue;
        const landId = toNum(land.id);
        if (!landId) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const currentPhase = getCurrentPhase(plant.phases, false, '', toNum(plant.id));
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;
        if (currentPhase.phase === PlantPhase.MATURE) continue;
        if (!canApplyNormalFertilizer(plant)) continue;

        targets.push(landId);
    }
    return targets;
}

function filterLandIdsForNormalFertilizer(landIds: number[], lands: any[]): number[] {
    const ids: number[] = Array.isArray(landIds) ? landIds : [];
    if (ids.length === 0) return [];
    const list: any[] = Array.isArray(lands) ? lands : [];
    if (list.length === 0) return [...ids];

    const applyable = new Set(getNormalFertilizerTargetsFromLands(list));
    const knownPlanted = new Set<number>();
    for (const land of list) {
        const id = toNum(land && land.id);
        if (!id) continue;
        const plant = land.plant;
        if (plant && Array.isArray(plant.phases) && plant.phases.length > 0) knownPlanted.add(id);
    }
    return ids.filter(id => applyable.has(id) || !knownPlanted.has(id));
}

function getFastMatureLands(lands: any[], thresholdSec: number = 300): number[] {
    const list: any[] = Array.isArray(lands) ? lands : [];
    const targets: number[] = [];
    const nowSec: number = getServerTimeSec();
    const threshold: number = Math.max(0, toNum(thresholdSec) || 300);

    for (const land of list) {
        if (!land || !land.unlocked) continue;
        const landId = toNum(land.id);
        if (!landId) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const currentPhase = getCurrentPhase(plant.phases, false, '', toNum(plant.id));
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;
        if (currentPhase.phase === PlantPhase.MATURE) continue;

        const maturePhase = plant.phases
            .filter((p: any) => p && toTimeSec(p.begin_time) > 0)
            .sort((left: any, right: any) => toTimeSec(right.begin_time) - toTimeSec(left.begin_time))[0];
        if (!maturePhase) continue;

        const matureBeginTime = toTimeSec(maturePhase.begin_time);
        if (matureBeginTime <= 0) continue;

        const timeToMature = matureBeginTime - nowSec;

        if (timeToMature <= threshold && timeToMature >= 0) {
            targets.push(landId);
        }
    }
    return targets;
}

function getSlaveLandIds(land: any): number[] {
    const ids: any[] = Array.isArray(land && land.slave_land_ids) ? land.slave_land_ids : [];
    return [...new Set(ids.map((id: any) => toNum(id)).filter(Boolean))];
}

function hasPlantData(land: any): boolean {
    const plant = land && land.plant;
    return !!(plant && Array.isArray(plant.phases) && plant.phases.length > 0);
}

function getLinkedMasterLand(land: any, landsMap: Map<number, any>): any | null {
    const landId = toNum(land && land.id);
    const masterLandId = toNum(land && land.master_land_id);
    if (!masterLandId || masterLandId === landId) return null;

    const masterLand = landsMap.get(masterLandId);
    if (!masterLand) return null;

    const slaveIds = getSlaveLandIds(masterLand);
    if (slaveIds.length > 0 && !slaveIds.includes(landId)) return null;

    return masterLand;
}

function getDisplayLandContext(land: any, landsMap: Map<number, any>): {
    sourceLand: any;
    occupiedByMaster: boolean;
    masterLandId: number;
    occupiedLandIds: number[];
} {
    const masterLand = getLinkedMasterLand(land, landsMap);
    if (masterLand && hasPlantData(masterLand)) {
        const occupiedLandIds = [toNum(masterLand.id), ...getSlaveLandIds(masterLand)].filter(Boolean);
        return {
            sourceLand: masterLand,
            occupiedByMaster: true,
            masterLandId: toNum(masterLand.id),
            occupiedLandIds: occupiedLandIds.length > 0 ? occupiedLandIds : [toNum(masterLand.id)].filter(Boolean),
        };
    }

    const selfId = toNum(land && land.id);
    const selfOccupiedLandIds = [selfId, ...getSlaveLandIds(land)].filter(Boolean);
    return {
        sourceLand: land,
        occupiedByMaster: false,
        masterLandId: selfId,
        occupiedLandIds: [...new Set(selfOccupiedLandIds)],
    };
}

function isOccupiedSlaveLand(land: any, landsMap: Map<number, any>): boolean {
    return !!getDisplayLandContext(land, landsMap).occupiedByMaster;
}

function buildSlaveToMasterMap(lands: any[]): Map<number, number> {
    const map = new Map<number, number>();
    for (const land of (Array.isArray(lands) ? lands : [])) {
        const slaveIds = getSlaveLandIds(land);
        const masterId = toNum(land && land.id);
        if (slaveIds.length > 0 && masterId > 0) {
            for (const slaveId of slaveIds) {
                if (slaveId > 0 && slaveId !== masterId) {
                    map.set(slaveId, masterId);
                }
            }
        }
    }
    return map;
}

function isOccupiedSlaveLandWithMap(land: any, landsMap: Map<number, any>, slaveToMasterMap: Map<number, number>): boolean {
    const landId = toNum(land && land.id);
    if (!landId) return false;
    return slaveToMasterMap.has(landId);
}

function summarizeLandDetails(lands: any[]): {
    harvestable: number;
    growing: number;
    empty: number;
    dead: number;
    needWater: number;
    needWeed: number;
    needBug: number;
} {
    const summary = {
        harvestable: 0,
        growing: 0,
        empty: 0,
        dead: 0,
        needWater: 0,
        needWeed: 0,
        needBug: 0,
    };

    for (const land of Array.isArray(lands) ? lands : []) {
        if (!land || !land.unlocked) continue;
        if (land.occupiedByMaster) continue;

        const status = String(land.status || '');
        if (status === 'harvestable') summary.harvestable++;
        else if (status === 'dead') summary.dead++;
        else if (status === 'empty') summary.empty++;
        else if (status === 'growing' || status === 'stealable' || status === 'harvested') summary.growing++;

        if (land.needWater) summary.needWater++;
        if (land.needWeed) summary.needWeed++;
        if (land.needBug) summary.needBug++;
    }

    return summary;
}

const ALL_FERTILIZER_LAND_TYPES: string[] = ['purple-gold', 'gold', 'black', 'red', 'normal'];
const FERTILIZER_LAND_TYPE_LABELS: Record<string, string> = {
    'purple-gold': '紫金土地',
    gold: '金土地',
    black: '黑土地',
    red: '红土地',
    normal: '普通土地',
};

function getLandTypeByLevel(level: number | any): string {
    const lv = toNum(level);
    if (lv >= 5) return 'purple-gold';
    if (lv === 4) return 'gold';
    if (lv === 3) return 'black';
    if (lv === 2) return 'red';
    return 'normal';
}

function normalizeFertilizerLandTypes(input: any[] | undefined | null): string[] {
    const source: any[] = Array.isArray(input) ? input : ALL_FERTILIZER_LAND_TYPES;
    const result: string[] = [];
    for (const item of source) {
        const value = String(item || '').trim().toLowerCase();
        if (!ALL_FERTILIZER_LAND_TYPES.includes(value)) continue;
        if (result.includes(value)) continue;
        result.push(value);
    }
    return result;
}

function filterLandIdsByTypes(landIds: number[], landTypeById: Map<number, string>, selectedTypes: any[]): number[] {
    const ids: number[] = Array.isArray(landIds) ? landIds : [];
    const selected = new Set(normalizeFertilizerLandTypes(selectedTypes));
    if (selected.size === 0) return [];
    if (selected.size === ALL_FERTILIZER_LAND_TYPES.length) return [...ids];

    const filtered: number[] = [];
    for (const id of ids) {
        const type = String(landTypeById.get(id) || '');
        if (!type) continue;
        if (selected.has(type)) filtered.push(id);
    }
    return filtered;
}

function formatFertilizerLandTypes(types: any[] | undefined | null): string[] {
    return normalizeFertilizerLandTypes(types).map(type => FERTILIZER_LAND_TYPE_LABELS[type] || type);
}

function analyzeLands(lands: any[], debug?: boolean, ownGid?: number): {
    harvestable: number[];
    needWater: number[];
    needWeed: number[];
    needBug: number[];
    needInteractionCleanup: number[];
    growing: number[];
    empty: number[];
    dead: number[];
    unlockable: number[];
    upgradable: number[];
    harvestableInfo: any[];
} {
    const result = {
        harvestable: [] as number[],
        needWater: [] as number[],
        needWeed: [] as number[],
        needBug: [] as number[],
        needInteractionCleanup: [] as number[],
        growing: [] as number[],
        empty: [] as number[],
        dead: [] as number[],
        unlockable: [] as number[],
        upgradable: [] as number[],
        harvestableInfo: [] as any[],
    };

    const nowSec: number = getServerTimeSec();
    const landsMap = buildLandMap(lands);

    for (const land of lands) {
        const id = toNum(land.id);
        if (!land.unlocked) {
            if (land.could_unlock) {
                result.unlockable.push(id);
            }
            continue;
        }
        if (land.could_upgrade) {
            result.upgradable.push(id);
        }

        if (isOccupiedSlaveLand(land, landsMap)) {
            continue;
        }

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) {
            result.empty.push(id);
            continue;
        }

        const plantName = plant.name || '未知作物';
        const landLabel = `土地#${id}(${plantName})`;

        const currentPhase = getCurrentPhase(plant.phases, debug, landLabel, toNum(plant.id));
        if (!currentPhase) {
            result.empty.push(id);
            continue;
        }
        const phaseVal = currentPhase.phase;

        if (hasOwnerCleanableInteraction(plant)) {
            result.needInteractionCleanup.push(id);
        }

        if (phaseVal === PlantPhase.DEAD) {
            result.dead.push(id);
            continue;
        }

        if (phaseVal === PlantPhase.MATURE) {
            result.harvestable.push(id);
            const plantId = toNum(plant.id);
            const plantNameFromConfig = getPlantName(plantId);
            const plantExp = getPlantExp(plantId);
            result.harvestableInfo.push({
                landId: id,
                plantId,
                name: plantNameFromConfig || plantName,
                exp: plantExp,
            });
            continue;
        }

        const dryNum = toNum(plant.dry_num);
        const dryTime = toTimeSec(currentPhase.dry_time);
        if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) {
            result.needWater.push(id);
        }

        const weedsTime = toTimeSec(currentPhase.weeds_time);
        let hasWeeds = weedsTime > 0 && weedsTime <= nowSec;
        if (!hasWeeds && plant.weed_owners && plant.weed_owners.length > 0) {
            // 如果指定了 ownGid，检查是否只有自己放的草
            if (ownGid) {
                const isOwnWeeds = plant.weed_owners.every((id: any) => toNum(id) === ownGid);
                hasWeeds = !isOwnWeeds; // 只有自己放的草 → 不需要除
            } else {
                hasWeeds = true;
            }
        }
        if (hasWeeds) {
            result.needWeed.push(id);
        }

        const insectTime = toTimeSec(currentPhase.insect_time);
        let hasBugs = insectTime > 0 && insectTime <= nowSec;
        if (!hasBugs && plant.insect_owners && plant.insect_owners.length > 0) {
            // 如果指定了 ownGid，检查是否只有自己放的虫
            if (ownGid) {
                const isOwnBugs = plant.insect_owners.every((id: any) => toNum(id) === ownGid);
                hasBugs = !isOwnBugs; // 只有自己放的虫 → 不需要除
            } else {
                hasBugs = true;
            }
        }
        if (hasBugs) {
            result.needBug.push(id);
        }

        result.growing.push(id);
    }

    return result;
}

function buildLandMap(lands: any[] | undefined | null): Map<number, any> {
    const map = new Map<number, any>();
    const list: any[] = Array.isArray(lands) ? lands : [];
    for (const land of list) {
        const id = toNum(land && land.id);
        if (id > 0) map.set(id, land);
    }
    return map;
}

interface PlantingLayout {
    anchorLandId: number;
    landIds: number[];
}

function buildPlantingLayouts(availableLandIds: number[], plantSize: number): PlantingLayout[] {
    const size = Math.max(1, toNum(plantSize) || 1);
    const orderedIds = [...new Set((Array.isArray(availableLandIds) ? availableLandIds : [])
        .map((id: any) => toNum(id))
        .filter(Boolean))];
    if (size === 1) {
        return orderedIds.map((id: number) => ({ anchorLandId: id, landIds: [id] }));
    }

    const { getLandConfigById, getLandConfigByCoordinate } = require('../../config/gameConfig');
    const available = new Set<number>(orderedIds);
    const layouts: PlantingLayout[] = [];
    const seen = new Set<string>();

    for (const anchorLandId of orderedIds) {
        const anchor = getLandConfigById(anchorLandId);
        if (!anchor) continue;
        const footprint: number[] = [];
        let complete = true;
        for (let yOffset = 0; yOffset < size && complete; yOffset++) {
            for (let xOffset = 0; xOffset < size; xOffset++) {
                const land = getLandConfigByCoordinate(
                    Number(anchor.grid_x) + xOffset,
                    Number(anchor.grid_y) + yOffset,
                );
                const landId = toNum(land && land.id);
                if (!landId || !available.has(landId)) {
                    complete = false;
                    break;
                }
                footprint.push(landId);
            }
        }
        if (!complete) continue;
        const key = [...footprint].sort((a, b) => a - b).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        layouts.push({ anchorLandId, landIds: footprint });
    }
    return layouts;
}

function selectNonOverlappingLayouts(layouts: PlantingLayout[], maxCount: number): PlantingLayout[] {
    const source = Array.isArray(layouts) ? layouts : [];
    const limit = Math.max(0, toNum(maxCount) || 0);
    if (limit === 0 || source.length === 0) return [];

    let best: PlantingLayout[] = [];
    function visit(index: number, selected: PlantingLayout[], occupied: Set<number>): void {
        if (selected.length > best.length) best = [...selected];
        if (selected.length >= limit || index >= source.length) return;
        if (selected.length + source.length - index <= best.length) return;

        const layout = source[index];
        if (layout.landIds.every(id => !occupied.has(id))) {
            const nextOccupied = new Set(occupied);
            layout.landIds.forEach(id => nextOccupied.add(id));
            selected.push(layout);
            visit(index + 1, selected, nextOccupied);
            selected.pop();
        }
        visit(index + 1, selected, occupied);
    }
    visit(0, [], new Set<number>());
    return best.slice(0, limit);
}

function resolveOccupiedLandIds(anchorLandId: number, lands: any[] | undefined | null): {
    masterLandId: number;
    occupiedLandIds: number[];
} {
    const anchorId = toNum(anchorLandId);
    const list: any[] = Array.isArray(lands) ? lands : [];
    const landsMap = buildLandMap(list);
    const slaveToMaster = buildSlaveToMasterMap(list);
    const anchor = landsMap.get(anchorId);
    const declaredMasterId = toNum(anchor && anchor.master_land_id);
    const masterLandId = declaredMasterId || slaveToMaster.get(anchorId) || anchorId;
    const master = landsMap.get(masterLandId) || anchor;
    const occupied = new Set<number>();
    if (masterLandId) occupied.add(masterLandId);
    getSlaveLandIds(master).forEach(id => occupied.add(id));
    for (const land of list) {
        const landId = toNum(land && land.id);
        if (landId && toNum(land && land.master_land_id) === masterLandId) occupied.add(landId);
        if (landId === masterLandId) getSlaveLandIds(land).forEach(id => occupied.add(id));
    }
    if (occupied.size === 0 && anchorId) occupied.add(anchorId);
    return { masterLandId: masterLandId || anchorId, occupiedLandIds: [...occupied] };
}

function getLandLifecycleState(land: any): string {
    if (!land) return 'unknown';
    const plant = land.plant;
    if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) {
        return 'empty';
    }

    const currentPhase = getCurrentPhase(plant.phases, false, '', toNum(plant.id));
    if (!currentPhase) return 'empty';

    const phaseVal = toNum(currentPhase.phase);
    if (phaseVal === PlantPhase.DEAD) return 'dead';
    if (phaseVal === PlantPhase.UNKNOWN) return 'empty';
    if (phaseVal >= PlantPhase.SEED && phaseVal <= PlantPhase.MATURE) return 'growing';
    return 'unknown';
}

function hasRemainingSeasons(plant: any): boolean {
    if (!plant) return false;
    const plantId = toNum(plant.id);
    const plantCfg = plantId > 0 ? getPlantById(plantId) : null;
    const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
    const rawSeason = toNum(plant.season);
    const currentSeason = rawSeason > 0 ? rawSeason : 1;
    return currentSeason > 1 || currentSeason < totalSeason;
}

function classifyHarvestedLandsByMap(landIds: number[], landsMap: Map<number, any>): {
    removable: number[];
    growing: number[];
    unknown: number[];
} {
    const removable: number[] = [];
    const growing: number[] = [];
    const unknown: number[] = [];
    const details: Array<Record<string, unknown>> = [];
    for (const id of landIds) {
        const land = landsMap.get(id);
        const plant = land && land.plant;
        const phases = plant && Array.isArray(plant.phases) ? plant.phases : [];
        const firstPhase = phases[0] || null;
        let state = 'unknown';
        if (!land) {
            unknown.push(id);
        } else {
            state = getLandLifecycleState(land);
            if (state === 'dead' || state === 'empty') {
                removable.push(id);
            } else if (state === 'growing' || hasRemainingSeasons(plant)) {
                state = 'growing';
                growing.push(id);
            } else {
                unknown.push(id);
            }
        }
        details.push({
            landId: id,
            hasLand: !!land,
            hasPlant: !!plant,
            phases: phases.length,
            phase: firstPhase ? toNum(firstPhase.phase) : 0,
            phaseId: firstPhase ? toNum(firstPhase.phase_id) : 0,
            season: plant ? toNum(plant.season) : 0,
            state,
        });
    }
    if (landIds.length > 0) {
        log('农场', `收后分类 ${landIds.length} 块: 铲${removable.length}/长${growing.length}/未知${unknown.length}`, {
            module: 'farm',
            event: '收获后状态分类',
            result: 'ok',
            removable: [...removable],
            growing: [...growing],
            unknown: [...unknown],
            details,
        });
    }
    return { removable, growing, unknown };
}

async function resolveRemovableHarvestedLands(harvestedLandIds: number[], harvestReply: any): Promise<{
    removable: number[];
    growing: number[];
    fallbackRemoved: number;
}> {
    const ids: number[] = Array.isArray(harvestedLandIds) ? harvestedLandIds.filter(Boolean) : [];
    if (ids.length === 0) {
        return { removable: [], growing: [], fallbackRemoved: 0 };
    }

    const replyMap = buildLandMap(harvestReply && harvestReply.land);
    const firstPass = classifyHarvestedLandsByMap(ids, replyMap);
    const removable: number[] = [...firstPass.removable];
    const growing: number[] = [...firstPass.growing];
    let unknown: number[] = [...firstPass.unknown];
    let fallbackRemoved: number = 0;

    if (unknown.length > 0) {
        try {
            // 注意：这里需要动态引入 getAllLands 以避免循环依赖
            const { getAllLands } = require('./api');
            const latestLandsReply = await getAllLands();
            const latestMap = buildLandMap(latestLandsReply && latestLandsReply.lands);
            const secondPass = classifyHarvestedLandsByMap(unknown, latestMap);
            removable.push(...secondPass.removable);
            growing.push(...secondPass.growing);
            unknown = secondPass.unknown;
        } catch (e: any) {
            logWarn('农场', `收后状态补拉失败: ${e.message}`, {
                module: 'farm',
                event: '收获后状态补拉',
                result: 'error',
            });
        }
    }

    if (unknown.length > 0) {
        // 收获响应可能省略 2x2 主地块，或全量土地响应暂时不完整；
        // 把未知状态当成枯死会误铲仍在生长/进入下一季的合种作物。
        logWarn('农场', `收后仍有 ${unknown.length} 块土地状态未知，已跳过铲除 (${unknown.join(',')})`, {
            module: 'farm',
            event: '收获后状态补拉',
            result: 'skip_unknown',
            landIds: unknown,
        });
        fallbackRemoved = unknown.length;
    }

    return {
        removable: [...new Set(removable)],
        growing: [...new Set(growing)],
        fallbackRemoved,
    };
}

module.exports = {
    getCurrentPhase,
    getPlantStatusFlags,
    getPlantMutantConfigIds,
    getExtendedStatusInteractionItemId,
    getPlantInteractionEffects,
    hasOwnerCleanableInteraction,
    getCleanableFarmSocialEventItemIds,
    buildFarmSocialEventDetails,
    buildLandDetail,
    getOrganicFertilizerTargetsFromLands,
    getNormalFertilizerTargetsFromLands,
    filterLandIdsForNormalFertilizer,
    canApplyNormalFertilizer,
    getFastMatureLands,
    getSlaveLandIds,
    hasPlantData,
    getLinkedMasterLand,
    getDisplayLandContext,
    isOccupiedSlaveLand,
    buildSlaveToMasterMap,
    isOccupiedSlaveLandWithMap,
    summarizeLandDetails,
    ALL_FERTILIZER_LAND_TYPES,
    getLandTypeByLevel,
    normalizeFertilizerLandTypes,
    filterLandIdsByTypes,
    formatFertilizerLandTypes,
    analyzeLands,
    buildLandMap,
    buildPlantingLayouts,
    selectNonOverlappingLayouts,
    resolveOccupiedLandIds,
    getLandLifecycleState,
    classifyHarvestedLandsByMap,
    resolveRemovableHarvestedLands,
};
