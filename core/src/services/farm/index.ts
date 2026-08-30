export {};
/**
 * 农场模块 - barrel re-export
 */

const api = require('./api');
const landAnalysis = require('./land-analysis');
const planting = require('./planting');
const fertilizer = require('./fertilizer');
const scheduler = require('./scheduler');

module.exports = {
    // 从 api.js
    checkFarm: scheduler.checkFarm,
    startFarmCheckLoop: scheduler.startFarmCheckLoop,
    stopFarmCheckLoop: scheduler.stopFarmCheckLoop,
    refreshFarmCheckLoop: scheduler.refreshFarmCheckLoop,
    getCurrentPhase: landAnalysis.getCurrentPhase,
    buildLandDetail: landAnalysis.buildLandDetail,
    getPlantStatusFlags: landAnalysis.getPlantStatusFlags,
    getPlantMutantConfigIds: landAnalysis.getPlantMutantConfigIds,
    getPlantInteractionEffects: landAnalysis.getPlantInteractionEffects,
    setOperationLimitsCallback: api.setOperationLimitsCallback,
    getAllLands: api.getAllLands,
    getLandsDetail: planting.getLandsDetail,
    getAvailableSeeds: planting.getAvailableSeeds,
    runFarmOperation: scheduler.runFarmOperation,
    runFertilizerByConfig: fertilizer.runFertilizerByConfig,
    fertilizeOwnLand: fertilizer.fertilizeOwnLand,
    buildLandMap: landAnalysis.buildLandMap,
    buildSlaveToMasterMap: landAnalysis.buildSlaveToMasterMap,
    getDisplayLandContext: landAnalysis.getDisplayLandContext,
    isOccupiedSlaveLand: landAnalysis.isOccupiedSlaveLand,
};
