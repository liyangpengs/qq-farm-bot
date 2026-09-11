export {};

const { toNum } = require('../../utils/utils');
const { buildPlantingLayouts } = require('./land-analysis');

interface PlantingLayout {
    anchorLandId: number;
    landIds: number[];
}

interface FutureLayoutReservation {
    layout: PlantingLayout;
    reservedLandIds: number[];
}

/**
 * 为暂时凑不齐的多格作物选择一组未来布局，并只预留其中当前已经空出的土地。
 * 始终选择锚点最小且已经部分空出的布局，使后续轮次只会向更早布局收敛，避免来回切换。
 */
function selectFutureLayoutReservation(
    currentEmptyLandIds: any[],
    allEligibleLandIds: any[],
    plantSize: number,
): FutureLayoutReservation | null {
    const size = Math.max(1, toNum(plantSize) || 1);
    if (size <= 1) return null;

    const emptyIds = new Set<number>((Array.isArray(currentEmptyLandIds) ? currentEmptyLandIds : [])
        .map((id: any) => toNum(id))
        .filter((id: number) => id > 0));
    if (emptyIds.size === 0) return null;
    if (buildPlantingLayouts([...emptyIds], size).length > 0) return null;

    const candidates = buildPlantingLayouts(allEligibleLandIds, size)
        .map((layout: PlantingLayout) => ({
            layout,
            reservedLandIds: layout.landIds.filter((id: number) => emptyIds.has(id)),
        }))
        .filter((candidate: FutureLayoutReservation) => (
            candidate.reservedLandIds.length > 0
            && candidate.reservedLandIds.length < candidate.layout.landIds.length
        ))
        .sort((a: FutureLayoutReservation, b: FutureLayoutReservation) => (
            a.layout.anchorLandId - b.layout.anchorLandId
        ));

    return candidates[0] || null;
}

module.exports = {
    selectFutureLayoutReservation,
};
