"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const GAMEPLAY_ADAPTERS = [
    {
        gameplayKey: 'stellar',
        detailTarget: 'travel',
        priority: 10,
        activityIds: context => [context.season?.pass?.activityId],
    },
    {
        gameplayKey: 'stellar',
        detailTarget: 'constellation',
        priority: 20,
        activityIds: context => [context.constellation?.activityId],
    },
    {
        gameplayKey: 'stellar',
        detailTarget: 'shop',
        priority: 30,
        activityIds: context => [context.shop?.activityId],
    },
    {
        gameplayKey: 'stellar',
        detailTarget: 'solar',
        priority: 40,
        activityIds: context => [
            context.solarTerms?.currentConfig?.activityId,
            ...(Array.isArray(context.solarTerms?.configs)
                ? context.solarTerms.configs.map((config) => config?.activityId)
                : []),
        ],
    },
    {
        gameplayKey: 'qixi',
        detailTarget: 'qixi',
        priority: 50,
        activityIds: context => [
            context.qixi?.groupId,
            context.qixi?.bridgeActivityId,
            context.qixi?.giftActivityId,
        ],
    },
];
function normalizeActivityId(value) {
    if (value == null)
        return '';
    const id = String(value).trim();
    return /^\d+$/.test(id) && id !== '0' ? id : '';
}
function buildActivityGameplayBindings(context) {
    const result = new Map();
    for (const adapter of GAMEPLAY_ADAPTERS) {
        for (const rawId of adapter.activityIds(context)) {
            const activityId = normalizeActivityId(rawId);
            if (!activityId)
                continue;
            const bindings = result.get(activityId) || [];
            if (!bindings.some(binding => binding.gameplayKey === adapter.gameplayKey && binding.detailTarget === adapter.detailTarget)) {
                bindings.push({
                    gameplayKey: adapter.gameplayKey,
                    detailTarget: adapter.detailTarget,
                    priority: adapter.priority,
                });
                bindings.sort((left, right) => left.priority - right.priority);
            }
            result.set(activityId, bindings);
        }
    }
    return result;
}
function resolveActivityGameplays(activityIds, bindings) {
    const matches = activityIds
        .flatMap((rawId) => bindings.get(normalizeActivityId(rawId)) || [])
        .filter((binding, index, entries) => entries.findIndex(entry => (entry.gameplayKey === binding.gameplayKey && entry.detailTarget === binding.detailTarget)) === index)
        .sort((left, right) => left.priority - right.priority);
    const gameplayKeys = Array.from(new Set(matches.map(binding => binding.gameplayKey)));
    return {
        gameplayKey: gameplayKeys[0] || null,
        gameplayKeys,
        detailTarget: matches[0]?.detailTarget || null,
        gameplayTargets: matches.map(binding => binding.detailTarget),
    };
}
module.exports = {
    buildActivityGameplayBindings,
    resolveActivityGameplays,
};
//# sourceMappingURL=activity-gameplay-registry.js.map