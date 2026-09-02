export {};
/**
 * 种植引擎 - 种植策略、种子选择、自动种植、按配置施肥
 */

const protobuf = require('protobufjs');
const { getPlantNameBySeedId, formatGrowTime, getPlantGrowTime, getAllSeeds, getPlantBySeedId } = require('../../config/gameConfig');
const { getPreferredSeed, getAutomation, getPlantingStrategy, getBagSeedPriority, getBagSeedLandTypes, getBagSeedFallbackStrategy } = require('../../models/store');
const { getUserState, getWsErrorState, sendMsgAsync } = require('../../utils/network');
const { toNum, getServerTimeSec, log, logWarn, sleep } = require('../../utils/utils');
const { types } = require('../../utils/proto');
const { getPlantRankings } = require('../analytics');
const { recordOperation } = require('../stats');
const { getBagSeeds } = require('../warehouse');
const { getCareerInfoOrNull } = require('../career');
const { getAllLands, buyGoods, removePlant, fertilizeOne } = require('./api');
const {
    ALL_FERTILIZER_LAND_TYPES,
    buildLandDetail,
    buildFarmSocialEventDetails,
    analyzeLands,
    buildLandMap,
    summarizeLandDetails,
    getOrganicFertilizerTargetsFromLands,
    getFastMatureLands,
    normalizeFertilizerLandTypes,
    formatFertilizerLandTypes,
    filterLandIdsByTypes,
    getLandTypeByLevel,
    buildPlantingLayouts,
    selectNonOverlappingLayouts,
    resolveOccupiedLandIds,
} = require('./land-analysis');

interface PlantingLayout {
    anchorLandId: number;
    landIds: number[];
}

interface PlantSeedsResult {
    planted: number;
    plantedLandIds: number[];
    occupiedLandIds: number[];
    reservedLandIds: number[];
    uncertain: boolean;
}

const NORMAL_FERTILIZER_ID: number = 1011;
const ORGANIC_FERTILIZER_ID: number = 1012;

function confirmsPlantedFootprint(
    expectedLandIds: Set<number>,
    masterLandId: number,
    occupiedLandIds: number[],
    lands: any[],
): boolean {
    if (![...expectedLandIds].every(id => occupiedLandIds.includes(id))) return false;
    const landsMap = buildLandMap(lands);
    const master = landsMap.get(masterLandId);
    return !!(master && master.plant);
}

// ============ 种植 ============

function getPlantSizeBySeedId(seedId: number | string): number {
    const plantCfg = getPlantBySeedId(toNum(seedId));
    return Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
}

/**
 * 种植 - 游戏中拖动种植间隔很短，这里用50ms。
 * 多格作物必须传入预先选好的布局；回复占地不完整时会补拉全量土地确认。
 */
async function plantSeeds(seedId: number | string, landIds: number[], options: {
    maxPlantCount?: number;
    layouts?: PlantingLayout[];
} = {}): Promise<PlantSeedsResult> {
    const normalizedLandIds = (Array.isArray(landIds) ? landIds : []).map((id: any) => toNum(id)).filter(Boolean);
    const maxPlantCount: number = Math.max(0, toNum(options.maxPlantCount) || 0) || Number.POSITIVE_INFINITY;
    const suppliedLayouts: PlantingLayout[] = Array.isArray(options.layouts) ? options.layouts : [];
    const layouts: PlantingLayout[] = suppliedLayouts.length > 0
        ? suppliedLayouts
            .map((layout: any) => ({
                anchorLandId: toNum(layout && layout.anchorLandId),
                landIds: [...new Set<number>((Array.isArray(layout && layout.landIds) ? layout.landIds : [])
                    .map((id: any) => toNum(id)).filter((id: number) => id > 0))],
            }))
            .filter((layout: PlantingLayout) => layout.anchorLandId > 0 && layout.landIds.length > 0)
        : normalizedLandIds.map((id: number) => ({ anchorLandId: id, landIds: [id] }));
    const selectedLayouts = layouts.slice(0, maxPlantCount);
    const plantedLandIds: number[] = [];
    const occupiedLandIds = new Set<number>();
    const reservedLandIds = new Set<number>();
    let uncertain = false;

    for (let index = 0; index < selectedLayouts.length; index++) {
        const layout = selectedLayouts[index];
        const landId = layout.anchorLandId;
        let rpcSucceeded = false;
        let resolvedMasterId = 0;
        let resolvedOccupiedIds: number[] = [];
        try {
            const body = encodePlantRequest(seedId, layout.landIds);
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
            rpcSucceeded = true;
            const reply = types.PlantReply.decode(replyBody);
            const changedLands = Array.isArray(reply && reply.land) ? reply.land : [];
            let resolved = resolveOccupiedLandIds(landId, changedLands);
            resolvedMasterId = toNum(resolved.masterLandId) || landId;
            resolvedOccupiedIds = (Array.isArray(resolved.occupiedLandIds) ? resolved.occupiedLandIds : [])
                .map((id: any) => toNum(id)).filter(Boolean);

            const expectedIds = new Set(layout.landIds);
            let confirmed = confirmsPlantedFootprint(expectedIds, resolvedMasterId, resolvedOccupiedIds, changedLands);
            if (!confirmed) {
                try {
                    const latest = await getAllLands();
                    const latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
                    resolved = resolveOccupiedLandIds(landId, latestLands);
                    resolvedMasterId = toNum(resolved.masterLandId) || landId;
                    resolvedOccupiedIds = (Array.isArray(resolved.occupiedLandIds) ? resolved.occupiedLandIds : [])
                        .map((id: any) => toNum(id)).filter(Boolean);
                    confirmed = confirmsPlantedFootprint(expectedIds, resolvedMasterId, resolvedOccupiedIds, latestLands);
                } catch (e: any) {
                    uncertain = true;
                    logWarn('种植', `土地#${landId} 种植成功但补拉占地失败 ${e.message}`, {
                        module: 'farm', event: '种植种子', result: 'footprint_uncertain', seedId: toNum(seedId), landId
                    });
                }
            }

            if (!confirmed) {
                uncertain = true;
                // RPC 已成功但服务端状态无法确认：保留预期占地，避免继续请求重叠土地，
                // 但不能将其计为成功种植或交给施肥。
                for (const expectedId of layout.landIds) reservedLandIds.add(expectedId);
                logWarn('种植', `土地#${landId} 无法确认完整占地 (${resolvedOccupiedIds.join(',') || '无'})`, {
                    module: 'farm', event: '种植种子', result: 'footprint_uncertain', seedId: toNum(seedId), landId,
                    expectedLandIds: layout.landIds,
                });
                break;
            }

            plantedLandIds.push(resolvedMasterId);
            for (const occupiedId of resolvedOccupiedIds) occupiedLandIds.add(occupiedId);
            for (const expectedId of layout.landIds) reservedLandIds.add(expectedId);
        } catch (e: any) {
            uncertain = true;
            logWarn('种植', `土地#${landId} 失败: ${e.message}`, {
                module: 'farm', event: '种植种子', result: 'rpc_uncertain', seedId: toNum(seedId), landId
            });
            break;
        }
        if (!rpcSucceeded) break;
        if (selectedLayouts.length > 1 && index < selectedLayouts.length - 1) await sleep(50);
    }
    return {
        planted: plantedLandIds.length,
        plantedLandIds: [...new Set(plantedLandIds)],
        occupiedLandIds: [...occupiedLandIds],
        reservedLandIds: [...reservedLandIds],
        uncertain,
    };
}

function encodePlantRequest(seedId: number | string, landIds: number[]): Uint8Array {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}

const PLANTING_STRATEGY_LABELS: Record<string, string> = {
    preferred: '优先种植种子',
    level: '最高等级作物',
    max_exp: '最大经验时',
    max_fert_exp: '最大普通肥经验/时',
    max_profit: '最大净利润/时',
    max_fert_profit: '最大普通肥净利润/时',
    bag_priority: '背包种子优先',
};

function getPlantingStrategyLabel(strategy: string): string {
    return PLANTING_STRATEGY_LABELS[strategy] || strategy;
}

function sortBagSeedsForPlanting(bagSeeds: any[], priorityList: any[] | undefined | null): any[] {
    const indexMap = new Map<number, number>();
    const priority: any[] = Array.isArray(priorityList) ? priorityList : [];
    priority.forEach((seedId: any, index: number) => {
        const id = Number(seedId);
        if (id > 0) indexMap.set(id, index);
    });

    return [...(Array.isArray(bagSeeds) ? bagSeeds : [])].sort((a: any, b: any) => {
        const aIndex = indexMap.has(a.seedId) ? indexMap.get(a.seedId)! : Number.MAX_SAFE_INTEGER;
        const bIndex = indexMap.has(b.seedId) ? indexMap.get(b.seedId)! : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;

        const aLevel = Number(a.requiredLevel || 0);
        const bLevel = Number(b.requiredLevel || 0);
        if (aLevel !== bLevel) return bLevel - aLevel;

        return Number(a.seedId || 0) - Number(b.seedId || 0);
    });
}

/**
 * 该种子允许种植的土地类型；null 表示不限制。
 * 缺配置、空数组、勾满全部类型三者等价于不限制。
 */
function resolveSeedLandTypes(bagSeedLandTypes: any, seedId: any): string[] | null {
    const raw = bagSeedLandTypes && bagSeedLandTypes[String(toNum(seedId))];
    if (!Array.isArray(raw)) return null;
    const types: string[] = normalizeFertilizerLandTypes(raw);
    if (types.length === 0 || types.length === ALL_FERTILIZER_LAND_TYPES.length) return null;
    return types;
}

async function plantFromBagSeeds(landsToPlant: any[], landTypeById?: Map<number, string>): Promise<{
    remainingLandIds: number[];
    fallbackAllowed: boolean;
    plantedLandIds: number[];
    totalPlanted: number;
    occupiedCount: number;
}> {
    const targetLandIds: number[] = [...new Set((Array.isArray(landsToPlant) ? landsToPlant : [])
        .map((id: any) => toNum(id)).filter(Boolean))];
    if (targetLandIds.length === 0) {
        return { remainingLandIds: [], fallbackAllowed: false, plantedLandIds: [], totalPlanted: 0, occupiedCount: 0 };
    }

    const bagSeeds = await getBagSeeds();
    const state = getUserState();
    const priorityList = getBagSeedPriority();
    const bagSeedLandTypes = getBagSeedLandTypes() || {};
    const landTypeAvailable = !!(landTypeById && landTypeById.size > 0);
    const allBagSeeds = (Array.isArray(bagSeeds) ? bagSeeds : []);
    
    const stateLevel = toNum(state && state.level);
    const filteredForLevelAndCount = allBagSeeds.map((seed: any) => ({
        seedId: seed.seedId,
        name: seed.name,
        count: toNum(seed && seed.count),
        requiredLevel: toNum(seed && seed.requiredLevel),
        plantSize: Math.max(1, toNum(seed && seed.plantSize) || getPlantSizeBySeedId(seed && seed.seedId)),
        // 拿不到土地类型时按不限制处理，避免整轮种不下去。
        landTypes: landTypeAvailable ? resolveSeedLandTypes(bagSeedLandTypes, seed && seed.seedId) : null,
        stateLevel,
    }));
    log('种植', `背包种子原始: ${filteredForLevelAndCount.map((s: any) => `${s.name}(${s.seedId})x${s.count},lv${s.requiredLevel},size${s.plantSize}`).join('; ')}`, {
        module: 'farm', event: '种植种子', result: 'bag_raw', priority: priorityList, stateLevel,
    });

    // 背包里已有的种子不再用玩家等级过滤：等级限制主要限制购买，拥有后应允许尝试种植。
    // 不可种的种子服务端会拒绝，这里记录后继续下一优先种子。
    const skippedSeeds: any[] = [];
    const levelLockedSeeds: any[] = [];
    const usableSeeds = sortBagSeedsForPlanting(
        filteredForLevelAndCount.filter((seed: any) => {
            if (seed.count <= 0) {
                skippedSeeds.push({ seedId: seed.seedId, name: seed.name, reason: 'count_zero', count: seed.count });
                return false;
            }
            if (seed.plantSize < 1) {
                skippedSeeds.push({ seedId: seed.seedId, name: seed.name, reason: 'invalid_size', plantSize: seed.plantSize });
                return false;
            }
            if (seed.requiredLevel > seed.stateLevel) {
                levelLockedSeeds.push({ seedId: seed.seedId, name: seed.name, requiredLevel: seed.requiredLevel, stateLevel: seed.stateLevel });
            }
            return true;
        }),
        priorityList,
    );

    const levelLockedSeedIds = new Set<number>(levelLockedSeeds.map((s: any) => toNum(s && s.seedId)));
    if (levelLockedSeeds.length > 0) {
        log('种植', `背包种子等级锁定但仍尝试: ${levelLockedSeeds.map((s: any) => `${s.name}(${s.seedId}) 需等级${s.requiredLevel}>当前${s.stateLevel}`).join('; ')}`, {
            module: 'farm', event: '种植种子', result: 'bag_seed_level_lock_try', strategy: 'bag_priority', levelLocked: levelLockedSeeds,
        });
    }
    if (skippedSeeds.length > 0) {
        log('种植', `背包种子不可种植: ${skippedSeeds.map((s: any) => `${s.name}(${s.seedId}) ${s.reason}`).join('; ')}`, {
            module: 'farm', event: '种植种子', result: 'bag_seed_skip', strategy: 'bag_priority', skipped: skippedSeeds,
        });
    }
    // 有土地限制的种子先种，否则不限制的种子会把受限种子唯一能用的地块占光。
    const plantingOrder: any[] = [
        ...usableSeeds.filter((seed: any) => !!seed.landTypes),
        ...usableSeeds.filter((seed: any) => !seed.landTypes),
    ];

    if (plantingOrder.length > 0) {
        const orderedSeeds = plantingOrder.map((seed: any, index: number) => {
            const scope = seed.landTypes ? `[仅${formatFertilizerLandTypes(seed.landTypes).join('/')}]` : '';
            return `${index + 1}.${seed.name}(${seed.seedId})x${toNum(seed && seed.count)}${scope}`;
        }).join(' -> ');
        log('种植', `背包种子执行顺序: ${orderedSeeds}`, {
            module: 'farm', event: '种植种子', result: 'bag_priority_order', strategy: 'bag_priority',
            priority: priorityList, seedIds: plantingOrder.map((seed: any) => seed.seedId),
        });
    }

    if (usableSeeds.length === 0) {
        log('种植', '背包种子已用完，准备按第二优先策略补种', {
            module: 'farm', event: '种植种子', result: 'fallback_ready', strategy: 'bag_priority'
        });
        return { remainingLandIds: targetLandIds, fallbackAllowed: true, plantedLandIds: [], totalPlanted: 0, occupiedCount: 0 };
    }

    let remainingLandIds: number[] = [...targetLandIds];
    let fallbackAllowed = true;
    let totalPlanted = 0;
    const occupiedIds = new Set<number>();
    const plantedLandIds: number[] = [];
    const usedSeedLogs: string[] = [];

    for (const seed of plantingOrder) {
        if (remainingLandIds.length === 0 || !fallbackAllowed) break;

        const plantSize = Math.max(1, toNum(seed && seed.plantSize) || getPlantSizeBySeedId(seed.seedId));
        // 受限种子只在命中类型的空地上装箱；未命中的空地留给后续种子或第二优先策略。
        const allowedLandIds: number[] = seed.landTypes
            ? filterLandIdsByTypes(remainingLandIds, landTypeById, seed.landTypes)
            : remainingLandIds;
        const allLayouts: PlantingLayout[] = buildPlantingLayouts(allowedLandIds, plantSize);
        const layouts: PlantingLayout[] = selectNonOverlappingLayouts(allLayouts, toNum(seed.count));
        const scopeLog = seed.landTypes ? ` 限${formatFertilizerLandTypes(seed.landTypes).join('/')}=${allowedLandIds.length}` : '';
        log('种植', `背包种子 ${seed.name}(${seed.seedId}) size=${plantSize} count=${seed.count} 剩余=${remainingLandIds.length}${scopeLog} allLayouts=${allLayouts.length} selected=${layouts.length}`, {
            module: 'farm', event: '种植种子', result: 'layout_check', strategy: 'bag_priority',
            seedId: seed.seedId, plantSize, count: seed.count, emptyCount: remainingLandIds.length,
            landTypes: seed.landTypes || null, allowedCount: allowedLandIds.length,
            allLayouts: allLayouts.length, selectedLayouts: layouts.length, remainingLandIds,
        });
        if (layouts.length === 0) {
            const reason = seed.landTypes && allowedLandIds.length === 0
                ? `无${formatFertilizerLandTypes(seed.landTypes).join('/')}空地`
                : `无合法${plantSize}x${plantSize} 布局`;
            log('种植', `背包种子 ${seed.name} ${reason}，已跳过`, {
                module: 'farm', event: '种植种子', result: 'skip_no_layout', strategy: 'bag_priority',
                seedId: seed.seedId, plantSize, emptyCount: remainingLandIds.length,
                landTypes: seed.landTypes || null, allowedCount: allowedLandIds.length,
            });
            continue;
        }

        const result = await plantSeeds(seed.seedId, layouts.map(layout => layout.anchorLandId), {
            maxPlantCount: layouts.length,
            layouts,
        });
        const consumed = new Set<number>([
            ...(Array.isArray(result.reservedLandIds) ? result.reservedLandIds : []),
            ...(Array.isArray(result.occupiedLandIds) ? result.occupiedLandIds : []),
        ].map((id: any) => toNum(id)).filter(Boolean));
        consumed.forEach(id => occupiedIds.add(id));
        remainingLandIds = remainingLandIds.filter(id => !consumed.has(id));

        if (result.planted > 0) {
            totalPlanted += result.planted;
            plantedLandIds.push(...result.plantedLandIds);
            usedSeedLogs.push(`${seed.name}x${result.planted}`);
        }
        
        if (result.uncertain) {
            // 等级锁定的种子尝试失败后，不应阻止第二优先策略补种其他空地。
            if (levelLockedSeedIds.has(seed.seedId)) {
                log('种植', `背包种子 ${seed.name} 为等级锁定种子，尝试失败但不阻止第二优先策略`, {
                    module: 'farm', event: '种植种子', result: 'bag_level_lock_fail_continue', seedId: seed.seedId,
                    requested: layouts.length, planted: result.planted,
                });
            } else {
                fallbackAllowed = false;
                logWarn('种植', `背包种子 ${seed.name} 的种植或占地状态不确定，为避免误购商店种子，本轮不执行第二优先策略`, {
                    module: 'farm', event: '种植种子', result: 'bag_plant_uncertain', seedId: seed.seedId,
                    requested: layouts.length, planted: result.planted
                });
            }
        }
    }

    if (usedSeedLogs.length > 0) {
        log('种植', `已按背包优先策略种植: ${usedSeedLogs.join('，')}`, {
            module: 'farm', event: '种植种子', result: 'ok', strategy: 'bag_priority', count: totalPlanted
        });
    }

    return {
        remainingLandIds,
        fallbackAllowed,
        plantedLandIds: [...new Set(plantedLandIds)],
        totalPlanted,
        occupiedCount: occupiedIds.size,
    };
}

async function findBestSeed(overrideStrategy?: string): Promise<any[]> {
    const SEED_SHOP_ID: number = 2;
    const { getShopInfo } = require('./api');
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
        logWarn('商店', '种子商店无商品');
        return [];
    }

    const state = getUserState();
    const available: any[] = [];
    for (const goods of shopReply.goods_list) {
        if (!goods.unlocked) continue;

        let meetsConditions: boolean = true;
        let requiredLevel: number = 0;
        const conds: any[] = goods.conds || [];
        for (const cond of conds) {
            if (toNum(cond.type) === 1) {
                requiredLevel = toNum(cond.param);
                if (state.level < requiredLevel) {
                    meetsConditions = false;
                    break;
                }
            }
        }
        if (!meetsConditions) continue;

        const limitCount = toNum(goods.limit_count);
        const boughtNum = toNum(goods.bought_num);
        if (limitCount > 0 && boughtNum >= limitCount) continue;

        const price = toNum(goods.price);
        if (!price || price <= 0) continue;

        available.push({
            goods,
            goodsId: toNum(goods.id),
            seedId: toNum(goods.item_id),
            price: toNum(goods.price),
            requiredLevel,
            unitItemCount: Math.max(1, toNum(goods.item_count) || 1),
            maxPurchaseCount: limitCount > 0 ? Math.max(0, limitCount - boughtNum) : Number.POSITIVE_INFINITY,
        });
    }

    if (available.length === 0) {
        logWarn('商店', '没有可购买的种子');
        return [];
    }

    // 返回完整候选序列，让调用方能按剩余土地布局逐个尝试。
    const strategy: string = overrideStrategy || getPlantingStrategy();
    const byLevelAndId = (a: any, b: any): number =>
        (b.requiredLevel - a.requiredLevel) || (a.seedId - b.seedId);
    const analyticsSortByMap: Record<string, string> = {
        max_exp: 'exp',
        max_fert_exp: 'fert',
        max_profit: 'profit',
        max_fert_profit: 'fert_profit',
    };
    const analyticsSortBy = analyticsSortByMap[strategy];
    if (analyticsSortBy) {
        try {
            const rankings = getPlantRankings(analyticsSortBy);
            const rankingBySeedId = new Map<number, number>();
            rankings.forEach((row: any, index: number) => {
                const seedId = toNum(row && row.seedId);
                const level = Number(row && row.level);
                if (seedId > 0 && (!Number.isFinite(level) || level <= state.level) && !rankingBySeedId.has(seedId)) {
                    rankingBySeedId.set(seedId, index);
                }
            });
            return available.sort((a: any, b: any) => {
                const aRank = rankingBySeedId.get(a.seedId) ?? Number.MAX_SAFE_INTEGER;
                const bRank = rankingBySeedId.get(b.seedId) ?? Number.MAX_SAFE_INTEGER;
                return (aRank - bRank) || byLevelAndId(a, b);
            });
        } catch (e: any) {
            logWarn('商店', `策略 ${strategy} 计算失败: ${e.message}，回退最高等级`);
        }
    }

    available.sort(byLevelAndId);
    if (strategy === 'preferred') {
        const preferred = getPreferredSeed();
        if (preferred > 0) {
            const index = available.findIndex((candidate: any) => candidate.seedId === preferred);
            if (index >= 0) available.unshift(...available.splice(index, 1));
            else logWarn('商店', `优先种子 ${preferred} 当前不可购买，回退自动选择`);
        }
    }
    return available;
}

async function getAvailableSeeds(): Promise<any[]> {
    const SEED_SHOP_ID: number = 2;
    const { getShopInfo } = require('./api');
    const state = getUserState();
    let list: any[] = [];

    try {
        const shopReply = await getShopInfo(SEED_SHOP_ID);
        if (shopReply.goods_list) {
            for (const goods of shopReply.goods_list) {
                // 不再过滤不可用的种子，而是返回给前端展示状态
                let requiredLevel: number = 0;
                for (const cond of goods.conds || []) {
                    if (toNum(cond.type) === 1) requiredLevel = toNum(cond.param);
                }

                const limitCount = toNum(goods.limit_count);
                const boughtNum = toNum(goods.bought_num);
                const isSoldOut: boolean = limitCount > 0 && boughtNum >= limitCount;

                list.push({
                    seedId: toNum(goods.item_id),
                    goodsId: toNum(goods.id),
                    name: getPlantNameBySeedId(toNum(goods.item_id)),
                    price: toNum(goods.price),
                    requiredLevel,
                    locked: !goods.unlocked || state.level < requiredLevel,
                    soldOut: isSoldOut,
                });
            }
        }
    } catch (e: any) {
        const wsErr = getWsErrorState();
        if (!wsErr || Number(wsErr.code) !== 400) {
            logWarn('商店', `获取商店失败: ${e.message}，使用本地备选列表`);
        }
    }

    // 如果商店请求失败或为空，使用本地配置
    if (list.length === 0) {
        const allSeeds = getAllSeeds();
        list = allSeeds.map((s: any) => ({
            ...s,
            goodsId: 0,
            price: null, // 未知价格
            requiredLevel: null, // 未知等级
            unknownMeta: true,
            locked: false,
            soldOut: false,
        }));
    }
    return list.sort((a: any, b: any) => {
        const av = a.requiredLevel ?? 9999;
        const bv = b.requiredLevel ?? 9999;
        return av - bv;
    });
}

async function getLandsDetail(): Promise<{ lands: any[]; summary: any; socialEvents: any[]; career: any }> {
    let lands: any[] = [];
    let summary: any = {};
    let socialEvents: any[] = [];
    try {
        const landsReply = await getAllLands();
        socialEvents = buildFarmSocialEventDetails(landsReply);
        if (landsReply.lands) {
            const nowSec: number = getServerTimeSec();
            const landsMap = buildLandMap(landsReply.lands);
            lands = landsReply.lands.map((land: any) => buildLandDetail(land, {
                friendMode: false,
                landsMap,
                nowSec,
            }));
            summary = summarizeLandDetails(lands);
        }
    } catch {
        lands = [];
        summary = {};
        socialEvents = [];
    }

    return {
        lands,
        summary,
        socialEvents,
        career: await getCareerInfoOrNull(getUserState().gid),
    };
}

/**
 * 解析 landId -> 土地类型。仅在配置了土地限制时才解析，未配置的账号不额外请求土地。
 * 解析不出来时返回 undefined，调用方按不限制处理。
 */
async function resolveLandTypeMapForBagSeeds(knownLands: any[]): Promise<Map<number, string> | undefined> {
    if (Object.keys(getBagSeedLandTypes() || {}).length === 0) return undefined;

    let lands: any[] = Array.isArray(knownLands) ? knownLands : [];
    if (lands.length === 0) {
        try {
            const latest = await getAllLands();
            lands = Array.isArray(latest && latest.lands) ? latest.lands : [];
        } catch (e: any) {
            logWarn('种植', `获取土地类型失败，本轮忽略背包种子的土地限制: ${e.message}`, {
                module: 'farm', event: '种植种子', result: 'land_type_error', strategy: 'bag_priority',
            });
            return undefined;
        }
    }

    const landTypeById = new Map<number, string>();
    for (const land of lands) {
        const landId = toNum(land && land.id);
        if (!landId) continue;
        landTypeById.set(landId, getLandTypeByLevel(land.level));
    }
    if (landTypeById.size === 0) {
        logWarn('种植', '无法确认土地类型，本轮忽略背包种子的土地限制', {
            module: 'farm', event: '种植种子', result: 'land_type_empty', strategy: 'bag_priority',
        });
    }
    return landTypeById;
}

async function autoPlantEmptyLands(deadLandIds: number[], emptyLandIds: number[]): Promise<any> {
    let landsToPlant: number[] = [...new Set<number>((Array.isArray(emptyLandIds) ? emptyLandIds : [])
        .map((id: any) => toNum(id)).filter((id: number) => id > 0))];
    let latestLands: any[] = [];
    const state = getUserState();

    // 1. 铲除枯死/收获残留植物（一键操作），随后以服务端最新状态确认可用土地。
    if (Array.isArray(deadLandIds) && deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除${deadLandIds.length} 块(${deadLandIds.join(',')})`, {
                module: 'farm', event: '铲除植物', result: 'ok', count: deadLandIds.length
            });
            try {
                const latest = await getAllLands();
                latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
                landsToPlant = analyzeLands(latestLands).empty;
            } catch (e: any) {
                logWarn('铲除', `铲除后确认土地失败，保留原有空地且不使用枯死地块: ${e.message}`, {
                    module: 'farm', event: '铲除植物', result: 'confirm_error'
                });
            }
        } catch (e: any) {
            logWarn('铲除', `批量铲除失败: ${e.message}`, {
                module: 'farm', event: '铲除植物', result: 'error'
            });
        }
    }

    if (landsToPlant.length === 0) return { plantedLands: [] };

    const accountStrategy = String(getPlantingStrategy() || '').trim();

    // 背包种子优先策略
    if (accountStrategy === 'bag_priority') {
        let bagResult: any;
        try {
            const landTypeById = await resolveLandTypeMapForBagSeeds(latestLands);
            bagResult = await plantFromBagSeeds(landsToPlant, landTypeById);
        } catch (e: any) {
            logWarn('种植', `读取背包种子失败，本轮跳过第二优先策略以避免误购: ${e.message}`, {
                module: 'farm',
                event: '种植种子',
                result: 'bag_load_error',
            });
            return { plantedLands: [] };
        }

        const plantedLands: number[] = bagResult.plantedLandIds || [];

        // 如果允许回退且有剩余空地，使用第二优先策略补种
        if (bagResult.fallbackAllowed && bagResult.remainingLandIds.length > 0) {
            const fallbackStrategy = getBagSeedFallbackStrategy() || 'level';
            log('种植', `开始按第二优先策略"${getPlantingStrategyLabel(fallbackStrategy)}"补种剩余空地`, {
                module: 'farm',
                event: '种植种子',
                result: 'fallback_start',
                strategy: fallbackStrategy,
                remainingCount: bagResult.remainingLandIds.length,
            });
            const shopResult = await plantFromShop(bagResult.remainingLandIds, state, fallbackStrategy);
            plantedLands.push(...(shopResult.plantedLands || []));
        }

        // 施肥
        if (plantedLands.length > 0) {
            await runFertilizerByConfig(plantedLands);
        }
        return { plantedLands: [...new Set(plantedLands)] };
    }

    // 其他策略：从商店购买种植
    const shopResult = await plantFromShop(landsToPlant, state);
    if (shopResult.plantedLands && shopResult.plantedLands.length > 0) {
        await runFertilizerByConfig(shopResult.plantedLands);
    }
    return shopResult;
}

async function plantFromShop(landsToPlant: number[], state: any, overrideStrategy?: string): Promise<any> {
    let candidates: any[] = [];
    try {
        candidates = await findBestSeed(overrideStrategy);
    } catch (e: any) {
        logWarn('商店', `查询失败: ${e.message}`);
        return { plantedLands: [], remainingLandIds: [...landsToPlant], uncertain: true };
    }
    if (candidates.length === 0) return { plantedLands: [], remainingLandIds: [...landsToPlant], uncertain: false };

    let remainingLandIds: number[] = [...new Set<number>((Array.isArray(landsToPlant) ? landsToPlant : [])
        .map((id: any) => toNum(id)).filter((id: number) => id > 0))];
    const plantedLands: number[] = [];
    let uncertain = false;

    for (const candidate of candidates) {
        if (remainingLandIds.length === 0 || uncertain) break;
        const seedName = getPlantNameBySeedId(candidate.seedId);
        const plantCfg = getPlantBySeedId(candidate.seedId);
        const plantSize = getPlantSizeBySeedId(candidate.seedId);
        const growTime = plantCfg ? getPlantGrowTime(plantCfg.id) : 0;
        const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
        const allLayouts: PlantingLayout[] = buildPlantingLayouts(remainingLandIds, plantSize);
        let layouts: PlantingLayout[] = selectNonOverlappingLayouts(allLayouts, allLayouts.length);
        if (layouts.length === 0) {
            log('种植', `${seedName} 无合法${plantSize}x${plantSize} 布局，继续下一候选`, {
                module: 'farm', event: '种植种子', result: 'skip_no_layout', seedId: candidate.seedId,
                plantSize, emptyCount: remainingLandIds.length
            });
            continue;
        }

        const unitItemCount = Math.max(1, toNum(candidate.unitItemCount) || 1);
        const requiredSeedCount = layouts.length;
        const requiredPurchaseUnits = Math.ceil(requiredSeedCount / unitItemCount);
        const maxPurchaseUnits = Number(candidate.maxPurchaseCount);
        const affordablePurchaseUnits = Math.floor(Math.max(0, toNum(state && state.gold)) / candidate.price);
        const purchaseUnits = Math.min(
            requiredPurchaseUnits,
            Number.isFinite(maxPurchaseUnits) ? maxPurchaseUnits : requiredPurchaseUnits,
            affordablePurchaseUnits,
        );
        if (purchaseUnits <= 0) {
            logWarn('商店', `金币或限购额度不足，无法购买 ${seedName} 种子，继续下一候选`, {
                module: 'farm', event: '购买种子跳过', result: 'insufficient_gold_or_limit',
                seedId: candidate.seedId, price: candidate.price, current: toNum(state && state.gold)
            });
            continue;
        }
        let needCount = Math.min(requiredSeedCount, purchaseUnits * unitItemCount);
        layouts = layouts.slice(0, needCount);
        if (needCount < requiredSeedCount) {
            log('商店', plantSize > 1
                ? `金币或限购额度有限，只尝试种植${needCount} 组${plantSize}x${plantSize} 作物`
                : `金币或限购额度有限，只种 ${needCount} 块地`);
        }

        log('商店', `选择种子: ${seedName} (${candidate.seedId}) 价格=${candidate.price}金币${growTimeStr}`, {
            module: 'warehouse', event: '选择种子', seedId: candidate.seedId, price: candidate.price,
            count: needCount, purchaseUnits, unitItemCount
        });

        let actualSeedId = candidate.seedId;
        try {
            const buyReply = await buyGoods(candidate.goodsId, purchaseUnits, candidate.price);
            if (buyReply.get_items && buyReply.get_items.length > 0) {
                const gotItem = buyReply.get_items[0];
                const gotId = toNum(gotItem && gotItem.id);
                const gotCount = toNum(gotItem && gotItem.count);
                if (gotId > 0) actualSeedId = gotId;
                if (gotCount > 0 && gotCount < needCount) {
                    needCount = gotCount;
                    layouts = layouts.slice(0, needCount);
                }
            }
            if (buyReply.cost_items) {
                for (const item of buyReply.cost_items) state.gold -= toNum(item.count);
            }
            log('购买', `已购买${getPlantNameBySeedId(actualSeedId)}种子 x${purchaseUnits * unitItemCount}, 花费 ${candidate.price * purchaseUnits} 金币`, {
                module: 'warehouse', event: '购买种子', result: 'ok', seedId: actualSeedId,
                count: purchaseUnits * unitItemCount, purchaseUnits, cost: candidate.price * purchaseUnits
            });
        } catch (e: any) {
            logWarn('购买', `${seedName} 购买结果不确定，停止后续购买: ${e.message}`, {
                module: 'warehouse', event: '购买种子', result: 'purchase_uncertain', seedId: candidate.seedId
            });
            uncertain = true;
            break;
        }

        const result = await plantSeeds(actualSeedId, layouts.map(layout => layout.anchorLandId), {
            maxPlantCount: needCount,
            layouts,
        });
        plantedLands.push(...result.plantedLandIds);
        const consumed = new Set<number>([
            ...result.reservedLandIds,
            ...result.occupiedLandIds,
        ].map((id: any) => toNum(id)).filter((id: number) => id > 0));
        remainingLandIds = remainingLandIds.filter(id => !consumed.has(id));
        log('种植', plantSize > 1
            ? `已种植${result.planted} 组${plantSize}x${plantSize} 作物，占用${result.occupiedLandIds.length} 块地 (${result.occupiedLandIds.join(',')})`
            : `已在 ${result.planted} 块地种植 (${result.plantedLandIds.join(',')})`, {
            module: 'farm', event: '种植种子', result: result.uncertain ? 'uncertain' : 'ok',
            seedId: actualSeedId, count: result.planted, occupiedCount: result.occupiedLandIds.length
        });
        if (result.uncertain) {
            uncertain = true;
            logWarn('种植', `${seedName} 种植或占地状态不确定，停止后续购买`, {
                module: 'farm', event: '种植种子', result: 'plant_uncertain', seedId: actualSeedId
            });
        }
    }

    return { plantedLands: [...new Set(plantedLands)], remainingLandIds, uncertain };
}

async function runFertilizerByConfig(plantedLands: any[] = [], options: { skipNormal?: boolean; reason?: string } = {}): Promise<{ normal: number; organic: number }> {
    const { fertilize, fertilizeOrganicLoop } = require('./api');
    const automation = getAutomation() || {};
    const fertilizerConfig = automation.fertilizer || 'none';
    const reason = String(options.reason || '').trim().toLowerCase() === 'multi_season' ? 'multi_season' : 'normal';
    const reasonLabel = reason === 'multi_season' ? '多季补肥' : '常规施肥';
    const eventName = reason === 'multi_season' ? '多季节施肥' : '常规施肥';
    const selectedLandTypes = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
    const selectedLandTypeNames = formatFertilizerLandTypes(selectedLandTypes);
    const planted: number[] = [...new Set((Array.isArray(plantedLands) ? plantedLands : []).map((v: any) => toNum(v)).filter(Boolean))];

    if (selectedLandTypes.length === 0) {
        log('施肥', `${reasonLabel}：未勾选施肥范围，跳过本轮施肥`, {
            module: 'farm',
            event: eventName,
            result: 'skip',
            reason,
            scope: 'none',
        });
        return { normal: 0, organic: 0 };
    }

    const { skipNormal = false } = options;

    if (planted.length === 0 && fertilizerConfig !== 'organic' && fertilizerConfig !== 'both' && fertilizerConfig !== 'smart') {
        return { normal: 0, organic: 0 };
    }
    let latestLands: any[] = [];
    const landTypeById = new Map<number, string>();
    try {
        const latest = await getAllLands();
        latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
        for (const land of latestLands) {
            if (!land) continue;
            const landId = toNum(land.id);
            if (!landId) continue;
            landTypeById.set(landId, getLandTypeByLevel(land.level));
        }
    } catch (e: any) {
        logWarn('施肥', `${reasonLabel}：获取土地信息失败，按已知地块继续 ${e.message}`, {
            module: 'farm',
            event: eventName,
            result: 'error',
            reason,
        });
    }

    const isAllLandTypesSelected: boolean = selectedLandTypes.length === ALL_FERTILIZER_LAND_TYPES.length;
    if (landTypeById.size === 0 && !isAllLandTypesSelected) {
        logWarn('施肥', `${reasonLabel}：无法确认土地类型，已跳过本轮施肥`, {
            module: 'farm',
            event: eventName,
            result: 'skip',
            reason,
            landTypes: selectedLandTypes,
        });
        return { normal: 0, organic: 0 };
    }

    let normalTargets: number[] = planted;
    if (landTypeById.size > 0) {
        normalTargets = filterLandIdsByTypes(planted, landTypeById, selectedLandTypes);
    }

    let fertilizedNormal: number = 0;
    let fertilizedOrganic: number = 0;

    if (!skipNormal && (fertilizerConfig === 'normal' || fertilizerConfig === 'both' || fertilizerConfig === 'smart') && normalTargets.length > 0) {
        fertilizedNormal = await fertilize(normalTargets, NORMAL_FERTILIZER_ID);
        if (fertilizedNormal > 0) {
            log('施肥', `${reasonLabel}：已为${fertilizedNormal}/${normalTargets.length} 块地施普通化肥（范围: ${selectedLandTypeNames.join('、')}）`, {
            module: 'farm',
            event: eventName,
            result: 'ok',
            reason,
            type: 'normal',
            count: fertilizedNormal,
            landTypes: selectedLandTypes,
        });
            recordOperation('fertilize', fertilizedNormal);
        }
    }

    if (fertilizerConfig === 'organic' || fertilizerConfig === 'both') {
        let organicTargets: number[] = planted;

        if (latestLands.length > 0) {
            organicTargets = getOrganicFertilizerTargetsFromLands(latestLands);
        }
        if (landTypeById.size > 0) {
            organicTargets = filterLandIdsByTypes(organicTargets, landTypeById, selectedLandTypes);
            }

        fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
        if (fertilizedOrganic > 0) {
            log('施肥', `${reasonLabel}：有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次（范围: ${selectedLandTypeNames.join('、')}）`, {
                module: 'farm',
                event: eventName,
                result: 'ok',
                reason,
                type: 'organic',
                count: fertilizedOrganic,
                landTypes: selectedLandTypes,
            });
            recordOperation('fertilize', fertilizedOrganic);
        }
    }
    else if (fertilizerConfig === 'smart') {
        let organicTargets: number[] = [];
        const smartSeconds = toNum(automation.fertilizer_smart_seconds) || 300;
        try {
            const latest = await getAllLands();
            organicTargets = getFastMatureLands(latest && latest.lands, smartSeconds);
        } catch (e: any) {
            logWarn('施肥', `获取全农场地块失败 ${e.message}`);
        }

        if (organicTargets.length > 0) {
            fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
            if (fertilizedOrganic > 0) {
                log('施肥', `有机化肥循环施肥完成，共施${fertilizedOrganic} 次`, {
                    module: 'farm',
                    event: '施肥',
                    result: 'ok',
                    type: 'organic',
                    count: fertilizedOrganic,
                });
                recordOperation('fertilize', fertilizedOrganic);
            }
        }
    }

    return { normal: fertilizedNormal, organic: fertilizedOrganic };
}

async function fertilizeOwnLand(landIdInput: unknown, fertilizerTypeInput: unknown): Promise<any> {
    const landId = toNum(landIdInput);
    if (!landId || landId <= 0) {
        throw new Error('地块编号无效');
    }

    const fertilizerType = String(fertilizerTypeInput || '').trim().toLowerCase();
    if (fertilizerType !== 'normal' && fertilizerType !== 'organic') {
        throw new Error('化肥类型必须是 normal 或 organic');
    }

    const fertilizerId = fertilizerType === 'organic' ? ORGANIC_FERTILIZER_ID : NORMAL_FERTILIZER_ID;
    const typeName = fertilizerType === 'organic' ? '有机化肥' : '普通化肥';
    let reply: any;
    try {
        reply = await fertilizeOne(landId, fertilizerId);
    }
    catch (error: any) {
        const message = String(error?.errorMessage || '').trim()
            || String(error?.message || '').replace(/^[\s\S]*错误:\s*code=\d+\s+/, '').trim()
            || `${typeName}使用失败`;
        throw new Error(message);
    }
    const replyLands = Array.isArray(reply && reply.land) ? reply.land : [];
    const updatedRaw = replyLands.find((land: any) => toNum(land?.id) === landId) || replyLands[0] || null;
    const nowSec = getServerTimeSec();
    const landsMap = updatedRaw ? buildLandMap([updatedRaw]) : new Map();
    const updatedLand = updatedRaw
        ? buildLandDetail(updatedRaw, { friendMode: false, landsMap, nowSec })
        : null;
    const fertilizerRemainingSec = toNum(reply?.fertilizer?.count);

    recordOperation('fertilize', 1);
    log('施肥', `手动施肥：第 ${landId} 块地已施${typeName}`, {
        module: 'farm',
        event: '手动施肥',
        result: 'ok',
        type: fertilizerType,
        landId,
        remainingSec: fertilizerRemainingSec,
    });

    return {
        landId,
        fertilizerType,
        fertilizerRemainingSec,
        updatedLand,
    };
}

module.exports = {
    getPlantSizeBySeedId,
    plantSeeds,
    getPlantingStrategyLabel,
    sortBagSeedsForPlanting,
    resolveSeedLandTypes,
    plantFromBagSeeds,
    findBestSeed,
    getAvailableSeeds,
    getLandsDetail,
    autoPlantEmptyLands,
    plantFromShop,
    runFertilizerByConfig,
    fertilizeOwnLand,
};
