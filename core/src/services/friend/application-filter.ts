export {};

export interface ApplicationFilterConfig {
    minLevel: number;
    requireOwnLevel: boolean;
    ownLevel: number;
    harvestStealEnabled: boolean;
    harvestPart: number;
    stealPart: number;
}

export interface FilterDecision {
    action: 'accept' | 'reject';
    reason?: string;
}

function isHarvestStealFilterEnabled(config: ApplicationFilterConfig): boolean {
    return !!config.harvestStealEnabled && Number(config.harvestPart) > 0;
}

function effectiveMinLevel(config: ApplicationFilterConfig): number {
    const manual = Math.max(0, Number(config.minLevel) || 0);
    const own = config.requireOwnLevel ? Math.max(0, Number(config.ownLevel) || 0) : 0;
    return Math.max(manual, own);
}

function evaluateLevelFilter(applicantLevel: number, config: ApplicationFilterConfig): FilterDecision {
    const minLevel = effectiveMinLevel(config);
    if (minLevel <= 0) return { action: 'accept' };

    const level = Math.max(0, Number(applicantLevel) || 0);
    if (level >= minLevel) return { action: 'accept' };

    const parts: string[] = [];
    const manual = Math.max(0, Number(config.minLevel) || 0);
    if (manual > 0) parts.push(`手动最低${manual}级`);
    if (config.requireOwnLevel) parts.push(`自己${Math.max(0, Number(config.ownLevel) || 0)}级`);
    return {
        action: 'reject',
        reason: `等级 ${level} < ${minLevel}（${parts.join('，')}）`,
    };
}

function evaluateHarvestStealFilter(
    harvestCount: number,
    stealCount: number,
    config: ApplicationFilterConfig,
): FilterDecision {
    if (!isHarvestStealFilterEnabled(config)) return { action: 'accept' };

    const harvest = Math.max(0, Number(harvestCount) || 0);
    const steal = Math.max(0, Number(stealCount) || 0);
    const harvestPart = Math.max(0, Number(config.harvestPart) || 0);
    const stealPart = Math.max(1, Number(config.stealPart) || 1);

    if (steal <= 0) return { action: 'accept' };
    if (harvest * stealPart >= steal * harvestPart) return { action: 'accept' };

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
