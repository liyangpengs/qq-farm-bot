import type { AutomationConfig, FertilizerMode } from '../../types/config';

const { getAllLands, fertilizeBatch, fertilizeOrganicLoop } = require('./api');
const {
    filterLandIdsByTypes,
    getFastMatureLands,
    getLandTypeByLevel,
    getNormalFertilizerTargetsFromLands,
    normalizeFertilizerLandTypes,
} = require('./land-analysis');
const { log, toNum } = require('../../utils/utils');
const { recordOperation } = require('../stats');

export function isRipeningOnlyMode(mode: FertilizerMode): boolean {
    return mode === 'normal_ripen' || mode === 'organic_ripen';
}

export async function runRipeningFertilizer(
    automation: Pick<AutomationConfig, 'fertilizer' | 'fertilizer_land_types' | 'fertilizer_smart_seconds'>,
    lands?: any[],
    propagateErrors = false,
): Promise<number> {
    const mode = automation.fertilizer;
    if (mode !== 'smart' && !isRipeningOnlyMode(mode)) return 0;
    const selectedTypes = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
    if (selectedTypes.length === 0) return 0;
    const snapshot = lands ?? (await getAllLands())?.lands;
    if (!Array.isArray(snapshot)) return 0;
    const roots = snapshot.filter(land => {
        const masterId = toNum(land?.master_land_id);
        return land && (!masterId || masterId === toNum(land.id));
    });
    const typesById = new Map<number, string>(roots.map(land => [toNum(land.id), getLandTypeByLevel(land.level)]));
    let targets = [...new Set<number>(filterLandIdsByTypes(
        getFastMatureLands(roots, automation.fertilizer_smart_seconds), typesById, selectedTypes,
    ))];
    const normal = mode === 'normal_ripen';
    if (normal) {
        const eligible = new Set<number>(getNormalFertilizerTargetsFromLands(roots));
        targets = targets.filter(landId => eligible.has(landId));
    }
    if (targets.length === 0) return 0;

    let count: number;
    if (mode === 'smart') {
        count = await fertilizeOrganicLoop(targets, propagateErrors);
    } else {
        const reply = await fertilizeBatch(targets, normal ? 1011 : 1012);
        const updated = new Set<number>((Array.isArray(reply?.land) ? reply.land : []).map(land => toNum(land?.id)));
        count = targets.filter(landId => updated.has(landId)).length;
    }
    if (count > 0) {
        recordOperation('fertilize', count);
        log('施肥', `临熟催熟：${normal ? '普通化肥' : '有机化肥'}已施 ${count} 次`, {
            module: 'farm', event: '临熟催熟', result: 'ok', type: normal ? 'normal' : 'organic', count,
        });
    }
    return count;
}
