import activityGameplayManifests from '../activity-data/activity-gameplays.json';

export {};

interface ActivityGameplayContext {
    season?: any;
    shop?: any;
    solarTerms?: any;
    constellation?: any;
    qixi?: any;
    qingMei?: any;
    weather?: any;
}

interface ActivityGameplayAdapter {
    gameplayKey: string;
    detailTarget: string;
    priority: number;
    activityIds: (context: ActivityGameplayContext) => unknown[];
}

interface ActivityGameplayBinding {
    gameplayKey: string;
    detailTarget: string;
    priority: number;
}

interface ActivityGameplayManifest {
    gameplayKey: string;
    bindings: Array<{
        detailTarget: string;
        priority: number;
        activityIds: string[];
    }>;
}

const dynamicActivityIds: Record<string, (context: ActivityGameplayContext) => unknown[]> = {
    'stellar:travel': context => [context.season?.pass?.activityId],
    'stellar:constellation': context => [context.constellation?.activityId],
    'stellar:shop': context => [context.shop?.activityId],
    'stellar:solar': context => [
        context.solarTerms?.currentConfig?.activityId,
        ...(Array.isArray(context.solarTerms?.configs)
            ? context.solarTerms.configs.map((config: any) => config?.activityId)
            : []),
    ],
    'qixi:qixi': context => [
        context.qixi?.groupId,
        context.qixi?.bridgeActivityId,
        context.qixi?.giftActivityId,
    ],
    'qingmei:qingmei': context => [
        context.qingMei?.dailyActivityId,
        context.qingMei?.activityId,
    ],
    'weather:weather': context => [
        context.weather?.groupId,
        context.weather?.shop?.activityId,
        context.weather?.mutation?.activityId,
        context.weather?.collector?.activityId,
        context.weather?.research?.activityId,
        context.weather?.catalogActivityId,
        context.weather?.taskActivityId,
        context.weather?.researchActivityId,
    ],
};

const GAMEPLAY_ADAPTERS: readonly ActivityGameplayAdapter[] = (
    activityGameplayManifests as ActivityGameplayManifest[]
).flatMap(manifest => manifest.bindings.map(binding => ({
    gameplayKey: manifest.gameplayKey,
    detailTarget: binding.detailTarget,
    priority: binding.priority,
    activityIds: (context: ActivityGameplayContext) => [
        ...binding.activityIds,
        ...(dynamicActivityIds[`${manifest.gameplayKey}:${binding.detailTarget}`]?.(context) || []),
    ],
})));

function normalizeActivityId(value: unknown): string {
    if (value == null) return '';
    const id = String(value).trim();
    return /^\d+$/.test(id) && id !== '0' ? id : '';
}

function buildActivityGameplayBindings(context: ActivityGameplayContext): ReadonlyMap<string, readonly ActivityGameplayBinding[]> {
    const result = new Map<string, ActivityGameplayBinding[]>();
    for (const adapter of GAMEPLAY_ADAPTERS) {
        for (const rawId of adapter.activityIds(context)) {
            const activityId = normalizeActivityId(rawId);
            if (!activityId) continue;
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

function resolveActivityGameplays(
    activityIds: unknown[],
    bindings: ReadonlyMap<string, readonly ActivityGameplayBinding[]>,
) {
    const matches = activityIds
        .flatMap((rawId) => bindings.get(normalizeActivityId(rawId)) || [])
        .filter((binding, index, entries) => entries.findIndex(entry => (
            entry.gameplayKey === binding.gameplayKey && entry.detailTarget === binding.detailTarget
        )) === index)
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
