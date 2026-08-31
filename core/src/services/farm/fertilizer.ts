export {};
/**
 * 施肥引擎 - 按配置批量施肥与单地块手动施肥
 */

const { getAutomation } = require('../../models/store');
const { toNum, getServerTimeSec, log, logWarn } = require('../../utils/utils');
const { recordOperation } = require('../stats');
const { getAllLands, fertilizeOne } = require('./api');
const {
    ALL_FERTILIZER_LAND_TYPES,
    buildLandDetail,
    buildLandMap,
    getOrganicFertilizerTargetsFromLands,
    getFastMatureLands,
    normalizeFertilizerLandTypes,
    formatFertilizerLandTypes,
    filterLandIdsByTypes,
    getLandTypeByLevel,
} = require('./land-analysis');

const NORMAL_FERTILIZER_ID: number = 1011;
const ORGANIC_FERTILIZER_ID: number = 1012;

async function runFertilizerByConfig(
    plantedLands: any[] = [],
    options: { skipNormal?: boolean; reason?: string; landsSnapshot?: any } = {},
): Promise<{ normal: number; organic: number }> {
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
    let hasFreshLandSnapshot = false;
    const landTypeById = new Map<number, string>();
    const applyLandSnapshot = (reply: any): void => {
        latestLands = Array.isArray(reply && reply.lands) ? reply.lands : [];
        landTypeById.clear();
        for (const land of latestLands) {
            if (!land) continue;
            const landId = toNum(land.id);
            if (!landId) continue;
            landTypeById.set(landId, getLandTypeByLevel(land.level));
        }
        hasFreshLandSnapshot = true;
    };
    if (Array.isArray(options.landsSnapshot?.lands) && options.landsSnapshot.lands.length > 0) {
        applyLandSnapshot(options.landsSnapshot);
    } else {
        try {
            applyLandSnapshot(await getAllLands());
        } catch (e: any) {
            logWarn('施肥', `${reasonLabel}：获取土地信息失败，按已知地块继续 ${e.message}`, {
                module: 'farm',
                event: eventName,
                result: 'error',
                reason,
            });
        }
    }

    if (!hasFreshLandSnapshot && fertilizerConfig === 'smart') {
        try {
            applyLandSnapshot(await getAllLands());
        } catch (e: any) {
            logWarn('施肥', `获取全农场地块失败 ${e.message}`);
        }
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
        if (hasFreshLandSnapshot && fertilizedNormal === 0) {
            organicTargets = getFastMatureLands(latestLands, smartSeconds);
        } else if (fertilizedNormal > 0) {
            try {
                const latest = await getAllLands();
                organicTargets = getFastMatureLands(latest && latest.lands, smartSeconds);
            } catch (e: any) {
                logWarn('施肥', `获取全农场地块失败 ${e.message}`);
            }
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
    runFertilizerByConfig,
    fertilizeOwnLand,
};
