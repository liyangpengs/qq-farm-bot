"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function isHarvestStealFilterEnabled(config) {
    return !!config.harvestStealEnabled && Number(config.harvestPart) > 0;
}
function effectiveMinLevel(config) {
    const manual = Math.max(0, Number(config.minLevel) || 0);
    const own = config.requireOwnLevel ? Math.max(0, Number(config.ownLevel) || 0) : 0;
    return Math.max(manual, own);
}
function evaluateLevelFilter(applicantLevel, config) {
    const minLevel = effectiveMinLevel(config);
    if (minLevel <= 0)
        return { action: 'accept' };
    const level = Math.max(0, Number(applicantLevel) || 0);
    if (level >= minLevel)
        return { action: 'accept' };
    const parts = [];
    const manual = Math.max(0, Number(config.minLevel) || 0);
    if (manual > 0)
        parts.push(`手动最低${manual}级`);
    if (config.requireOwnLevel)
        parts.push(`自己${Math.max(0, Number(config.ownLevel) || 0)}级`);
    return {
        action: 'reject',
        reason: `等级 ${level} < ${minLevel}（${parts.join('，')}）`,
    };
}
function evaluateHarvestStealFilter(harvestCount, stealCount, config) {
    if (!isHarvestStealFilterEnabled(config))
        return { action: 'accept' };
    const harvest = Math.max(0, Number(harvestCount) || 0);
    const steal = Math.max(0, Number(stealCount) || 0);
    const harvestPart = Math.max(0, Number(config.harvestPart) || 0);
    const stealPart = Math.max(1, Number(config.stealPart) || 1);
    if (steal <= 0)
        return { action: 'accept' };
    if (harvest * stealPart >= steal * harvestPart)
        return { action: 'accept' };
    return {
        action: 'reject',
        reason: `收偷比 ${harvest}:${steal} 低于 ${harvestPart}:${stealPart}`,
    };
}
module.exports = {
    isHarvestStealFilterEnabled,
    effectiveMinLevel,
    evaluateLevelFilter,
    evaluateHarvestStealFilter,
};
//# sourceMappingURL=application-filter.js.map