import type { AccountConfig, AutomationConfig, BagSeedFallbackStrategy, FertilizerLandType, IntervalConfig, PlantingStrategy, QuietHoursConfig } from '../../types/config';
export {};

const sharedState = require('./shared-state');
const { readKnownFriendGidsCache, writeKnownFriendGidsCache } = require('./gid-cache');

const {
    globalConfig,
    normalizeAccountConfig,
    cloneAccountConfig,
    normalizeFertilizerLandTypes,
    normalizeKnownFriendGids,
    normalizeKnownFriendGidSyncCooldownSec,
    normalizeFriendsListCacheTtlSec,
    normalizeBagSeedPriority,
    normalizeBagSeedLandTypes,
    normalizeBagSeedFallbackStrategy,
    normalizeIntervals,
    normalizeTimeString,
    normalizeAutoAcceptFriendMinLevel,
    normalizeAutoAcceptHarvestStealHarvest,
    normalizeAutoAcceptHarvestStealSteal,
    ALLOWED_PLANTING_STRATEGIES,
} = sharedState;

function cloneBagSeedLandTypes(input: Record<string, FertilizerLandType[]> | undefined): Record<string, FertilizerLandType[]> {
    const cloned: Record<string, FertilizerLandType[]> = {};
    for (const [seedId, types] of Object.entries(input || {})) {
        cloned[seedId] = [...(types || [])];
    }
    return cloned;
}

function getAccountConfigSnapshot(accountId?: unknown): AccountConfig {
    const id = sharedState.resolveAccountId(accountId);
    if (!id) return cloneAccountConfig(sharedState.accountFallbackConfig);
    return normalizeAccountConfig(globalConfig.accountConfigs[id], sharedState.accountFallbackConfig);
}

function setAccountConfigSnapshot(accountId: unknown, nextConfig: Partial<AccountConfig>, persist: boolean = true): AccountConfig {
    const id = sharedState.resolveAccountId(accountId);
    if (!id) {
        sharedState.accountFallbackConfig = normalizeAccountConfig(nextConfig, sharedState.accountFallbackConfig);
        globalConfig.defaultAccountConfig = cloneAccountConfig(sharedState.accountFallbackConfig);
        if (persist) { require('./global-config').saveGlobalConfig(); }
        return cloneAccountConfig(sharedState.accountFallbackConfig);
    }
    globalConfig.accountConfigs[id] = normalizeAccountConfig(nextConfig, sharedState.accountFallbackConfig);
    if (persist) { require('./global-config').saveGlobalConfig(); }
    return cloneAccountConfig(globalConfig.accountConfigs[id]);
}

function removeAccountConfig(accountId: unknown): void {
    const id = sharedState.resolveAccountId(accountId);
    if (!id) return;
    if (globalConfig.accountConfigs[id]) {
        delete globalConfig.accountConfigs[id];
        require('./global-config').saveGlobalConfig();
    }
}

function ensureAccountConfig(accountId: unknown, options: { persist?: boolean } = {}): AccountConfig | null {
    const id = sharedState.resolveAccountId(accountId);
    if (!id) return null;
    if (globalConfig.accountConfigs[id]) {
        return cloneAccountConfig(globalConfig.accountConfigs[id]);
    }
    globalConfig.accountConfigs[id] = cloneAccountConfig(sharedState.DEFAULT_ACCOUNT_CONFIG);
    if (options.persist !== false) require('./global-config').saveGlobalConfig();
    return cloneAccountConfig(globalConfig.accountConfigs[id]);
}

function getAutomation(accountId?: unknown): AutomationConfig {
    const automation = { ...getAccountConfigSnapshot(accountId).automation };
    automation.fertilizer_land_types = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
    return automation;
}

function getConfigSnapshot(accountId?: unknown): AccountConfig & { ui: typeof globalConfig.ui } {
    const cfg = getAccountConfigSnapshot(accountId);
    return {
        automation: { ...cfg.automation },
        plantingStrategy: cfg.plantingStrategy,
        preferredSeedId: cfg.preferredSeedId,
        intervals: { ...cfg.intervals },
        friendQuietHours: { ...cfg.friendQuietHours },
        knownFriendGids: [...(cfg.knownFriendGids || [])],
        knownFriendGidSyncCooldownSec: cfg.knownFriendGidSyncCooldownSec,
        friendsListCacheTtlSec: cfg.friendsListCacheTtlSec,
        friendBlacklist: [...(cfg.friendBlacklist || [])],
        plantBlacklist: [...(cfg.plantBlacklist || [])],
        stealDelaySeconds: Math.max(0, Math.min(300, Number(cfg.stealDelaySeconds) || 0)),
        plantOrderRandom: !!cfg.plantOrderRandom,
        plantDelaySeconds: Math.max(0, Math.min(60, Number(cfg.plantDelaySeconds) || 0)),
        fertilizerBuyOrganicCount: Math.max(0, Math.min(10000, Number(cfg.fertilizerBuyOrganicCount) || 0)),
        fertilizerBuyOrganicThresholdHours: Math.max(0, Math.min(990, Number(cfg.fertilizerBuyOrganicThresholdHours) || 0)),
        fertilizerBuyNormalCount: Math.max(0, Math.min(10000, Number(cfg.fertilizerBuyNormalCount) || 0)),
        fertilizerBuyNormalThresholdHours: Math.max(0, Math.min(990, Number(cfg.fertilizerBuyNormalThresholdHours) || 0)),
        fertilizerBuyCheckIntervalMinutes: Math.max(1, Math.min(1440, Number(cfg.fertilizerBuyCheckIntervalMinutes) || 30)),
        bagSeedPriority: [...(cfg.bagSeedPriority || [])],
        bagSeedLandTypes: cloneBagSeedLandTypes(cfg.bagSeedLandTypes),
        bagSeedFallbackStrategy: cfg.bagSeedFallbackStrategy,
        autoAcceptFriendMinLevel: cfg.autoAcceptFriendMinLevel,
        autoAcceptRequireOwnLevel: !!cfg.autoAcceptRequireOwnLevel,
        autoAcceptHarvestStealEnabled: !!cfg.autoAcceptHarvestStealEnabled,
        autoAcceptHarvestStealHarvest: cfg.autoAcceptHarvestStealHarvest,
        autoAcceptHarvestStealSteal: cfg.autoAcceptHarvestStealSteal,
        ui: { ...globalConfig.ui },
    } as any;
}

interface ApplyConfigSnapshotOptions {
    persist?: boolean;
    accountId?: unknown;
}

function applyConfigSnapshot(snapshot: Record<string, any> | undefined, options: ApplyConfigSnapshotOptions = {}): ReturnType<typeof getConfigSnapshot> {
    const cfg: Record<string, any> = snapshot || {};
    const persist = options.persist !== false;
    const accountId = options.accountId;

    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, sharedState.accountFallbackConfig);

    if (cfg.automation && typeof cfg.automation === 'object') {
        for (const [k, v] of Object.entries(cfg.automation)) {
            if ((next.automation as any)[k] === undefined) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'smart', 'none'];
                (next.automation as any)[k] = allowed.includes(v as string) ? v : (next.automation as any)[k];
            } else if (k === 'fertilizer_land_types') {
                (next.automation as any)[k] = normalizeFertilizerLandTypes(v, next.automation.fertilizer_land_types);
            } else if (k === 'fertilizer_smart_seconds') {
                (next.automation as any)[k] = Math.max(30, Math.min(3600, Number(v) || 300));
            } else {
                (next.automation as any)[k] = !!v;
            }
        }
    }

    if (cfg.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(cfg.plantingStrategy)) {
        next.plantingStrategy = cfg.plantingStrategy;
    }

    if (cfg.preferredSeedId !== undefined && cfg.preferredSeedId !== null) {
        next.preferredSeedId = Math.max(0, Number.parseInt(cfg.preferredSeedId, 10) || 0);
    }

    if (cfg.intervals && typeof cfg.intervals === 'object') {
        for (const [type, sec] of Object.entries(cfg.intervals)) {
            if ((next.intervals as any)[type] === undefined) continue;
            (next.intervals as any)[type] = Math.max(1, Number.parseInt(sec as string, 10) || (next.intervals as any)[type] || 1);
        }
        next.intervals = normalizeIntervals(next.intervals);
    }

    if (cfg.friendQuietHours && typeof cfg.friendQuietHours === 'object') {
        const old = next.friendQuietHours || {};
        next.friendQuietHours = {
            enabled: cfg.friendQuietHours.enabled !== undefined ? !!cfg.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(cfg.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(cfg.friendQuietHours.end, old.end || '07:00'),
            continueFarm: cfg.friendQuietHours.continueFarm !== undefined
                ? !!cfg.friendQuietHours.continueFarm
                : (old.continueFarm !== undefined ? !!old.continueFarm : true),
        };
    }

    if (Array.isArray(cfg.friendBlacklist)) {
        next.friendBlacklist = cfg.friendBlacklist.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
    }

    if (cfg.knownFriendGids !== undefined) {
        next.knownFriendGids = normalizeKnownFriendGids(cfg.knownFriendGids, next.knownFriendGids);
        if (accountId) {
            writeKnownFriendGidsCache(accountId, next.knownFriendGids);
        }
    }

    if (cfg.knownFriendGidSyncCooldownSec !== undefined) {
        next.knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(
            cfg.knownFriendGidSyncCooldownSec,
            next.knownFriendGidSyncCooldownSec,
        );
    }

    if (cfg.friendsListCacheTtlSec !== undefined) {
        next.friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(
            cfg.friendsListCacheTtlSec,
            next.friendsListCacheTtlSec,
        );
    }

    if (Array.isArray(cfg.plantBlacklist)) {
        next.plantBlacklist = cfg.plantBlacklist.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
    }

    if (cfg.stealDelaySeconds !== undefined && cfg.stealDelaySeconds !== null) {
        next.stealDelaySeconds = Math.max(0, Math.min(300, Number(cfg.stealDelaySeconds) || 0));
    }

    if (cfg.plantOrderRandom !== undefined && cfg.plantOrderRandom !== null) {
        next.plantOrderRandom = !!cfg.plantOrderRandom;
    }

    if (cfg.plantDelaySeconds !== undefined && cfg.plantDelaySeconds !== null) {
        next.plantDelaySeconds = Math.max(0, Math.min(60, Number(cfg.plantDelaySeconds) || 0));
    }

    if (cfg.fertilizerBuyOrganicCount !== undefined && cfg.fertilizerBuyOrganicCount !== null) {
        next.fertilizerBuyOrganicCount = Math.max(0, Math.min(10000, Number(cfg.fertilizerBuyOrganicCount) || 0));
    }

    if (cfg.fertilizerBuyOrganicThresholdHours !== undefined && cfg.fertilizerBuyOrganicThresholdHours !== null) {
        next.fertilizerBuyOrganicThresholdHours = Math.max(0, Math.min(990, Number(cfg.fertilizerBuyOrganicThresholdHours) || 0));
    }

    if (cfg.fertilizerBuyNormalCount !== undefined && cfg.fertilizerBuyNormalCount !== null) {
        next.fertilizerBuyNormalCount = Math.max(0, Math.min(10000, Number(cfg.fertilizerBuyNormalCount) || 0));
    }

    if (cfg.fertilizerBuyNormalThresholdHours !== undefined && cfg.fertilizerBuyNormalThresholdHours !== null) {
        next.fertilizerBuyNormalThresholdHours = Math.max(0, Math.min(990, Number(cfg.fertilizerBuyNormalThresholdHours) || 0));
    }

    if (cfg.fertilizerBuyCheckIntervalMinutes !== undefined && cfg.fertilizerBuyCheckIntervalMinutes !== null) {
        next.fertilizerBuyCheckIntervalMinutes = Math.max(1, Math.min(1440, Number(cfg.fertilizerBuyCheckIntervalMinutes) || 30));
    }

    if (cfg.bagSeedPriority !== undefined && cfg.bagSeedPriority !== null) {
        next.bagSeedPriority = normalizeBagSeedPriority(cfg.bagSeedPriority);
    }

    if (cfg.bagSeedLandTypes !== undefined && cfg.bagSeedLandTypes !== null) {
        next.bagSeedLandTypes = normalizeBagSeedLandTypes(cfg.bagSeedLandTypes);
    }

    if (cfg.bagSeedFallbackStrategy !== undefined && cfg.bagSeedFallbackStrategy !== null) {
        next.bagSeedFallbackStrategy = normalizeBagSeedFallbackStrategy(cfg.bagSeedFallbackStrategy, next.bagSeedFallbackStrategy);
    }

    if (cfg.autoAcceptFriendMinLevel !== undefined && cfg.autoAcceptFriendMinLevel !== null) {
        next.autoAcceptFriendMinLevel = normalizeAutoAcceptFriendMinLevel(cfg.autoAcceptFriendMinLevel, next.autoAcceptFriendMinLevel);
    }

    if (cfg.autoAcceptRequireOwnLevel !== undefined && cfg.autoAcceptRequireOwnLevel !== null) {
        next.autoAcceptRequireOwnLevel = !!cfg.autoAcceptRequireOwnLevel;
    }

    if (cfg.autoAcceptHarvestStealEnabled !== undefined && cfg.autoAcceptHarvestStealEnabled !== null) {
        next.autoAcceptHarvestStealEnabled = !!cfg.autoAcceptHarvestStealEnabled;
    }

    if (cfg.autoAcceptHarvestStealHarvest !== undefined && cfg.autoAcceptHarvestStealHarvest !== null) {
        next.autoAcceptHarvestStealHarvest = normalizeAutoAcceptHarvestStealHarvest(
            cfg.autoAcceptHarvestStealHarvest,
            next.autoAcceptHarvestStealHarvest,
        );
    }

    if (cfg.autoAcceptHarvestStealSteal !== undefined && cfg.autoAcceptHarvestStealSteal !== null) {
        next.autoAcceptHarvestStealSteal = normalizeAutoAcceptHarvestStealSteal(
            cfg.autoAcceptHarvestStealSteal,
            next.autoAcceptHarvestStealSteal,
        );
    }

    if (cfg.ui && typeof cfg.ui === 'object') {
        const theme = String(cfg.ui.theme || '').toLowerCase();
        if (theme === 'dark' || theme === 'light') {
            globalConfig.ui.theme = theme;
        }
    }

    setAccountConfigSnapshot(accountId, next, false);
    if (persist) require('./global-config').saveGlobalConfig();
    return getConfigSnapshot(accountId);
}

function setAutomation(key: string, value: unknown, accountId?: unknown): ReturnType<typeof applyConfigSnapshot> {
    return applyConfigSnapshot({ automation: { [key]: value } }, { accountId });
}

function isAutomationOn(key: string, accountId?: unknown): boolean {
    return !!(getAccountConfigSnapshot(accountId).automation as any)[key];
}

function getPreferredSeed(accountId?: unknown): number {
    return getAccountConfigSnapshot(accountId).preferredSeedId;
}

function getPlantingStrategy(accountId?: unknown): PlantingStrategy {
    return getAccountConfigSnapshot(accountId).plantingStrategy;
}

function getBagSeedPriority(accountId?: unknown): number[] {
    return [...(getAccountConfigSnapshot(accountId).bagSeedPriority || [])];
}

function getBagSeedLandTypes(accountId?: unknown): Record<string, FertilizerLandType[]> {
    return cloneBagSeedLandTypes(getAccountConfigSnapshot(accountId).bagSeedLandTypes);
}

function getBagSeedFallbackStrategy(accountId?: unknown): BagSeedFallbackStrategy {
    return normalizeBagSeedFallbackStrategy(getAccountConfigSnapshot(accountId).bagSeedFallbackStrategy);
}

function getIntervals(accountId?: unknown): IntervalConfig {
    return { ...getAccountConfigSnapshot(accountId).intervals };
}

function getFriendQuietHours(accountId?: unknown): QuietHoursConfig {
    return { ...getAccountConfigSnapshot(accountId).friendQuietHours };
}

function getKnownFriendGids(accountId?: unknown): number[] {
    const config = getAccountConfigSnapshot(accountId);
    const configGids = config.knownFriendGids || [];

    if (configGids.length > 0) {
        return [...configGids];
    }

    const cachedGids = readKnownFriendGidsCache(accountId);
    if (cachedGids && cachedGids.length > 0) {
        return [...cachedGids];
    }

    return [];
}

function setKnownFriendGids(accountId: unknown, list: unknown[]): number[] {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, sharedState.accountFallbackConfig);
    const normalizedGids = normalizeKnownFriendGids(list, next.knownFriendGids);
    next.knownFriendGids = normalizedGids;
    setAccountConfigSnapshot(accountId, next);

    writeKnownFriendGidsCache(accountId, normalizedGids);

    return [...normalizedGids];
}

function getKnownFriendGidSyncCooldownSec(accountId?: unknown): number {
    return normalizeKnownFriendGidSyncCooldownSec(getAccountConfigSnapshot(accountId).knownFriendGidSyncCooldownSec);
}

function setKnownFriendGidSyncCooldownSec(accountId: unknown, sec: unknown): number {
    const current = getAccountConfigSnapshot(accountId);
    const normalized = normalizeKnownFriendGidSyncCooldownSec(sec, current.knownFriendGidSyncCooldownSec);
    const next = normalizeAccountConfig({
        ...current,
        knownFriendGidSyncCooldownSec: normalized,
    }, sharedState.accountFallbackConfig);
    setAccountConfigSnapshot(accountId, next, true);
    return next.knownFriendGidSyncCooldownSec;
}

function getFriendsListCacheTtlSec(accountId?: unknown): number {
    return normalizeFriendsListCacheTtlSec(getAccountConfigSnapshot(accountId).friendsListCacheTtlSec);
}

function setFriendsListCacheTtlSec(accountId: unknown, sec: unknown): number {
    const current = getAccountConfigSnapshot(accountId);
    const normalized = normalizeFriendsListCacheTtlSec(sec, current.friendsListCacheTtlSec);
    const next = normalizeAccountConfig({
        ...current,
        friendsListCacheTtlSec: normalized,
    }, sharedState.accountFallbackConfig);
    setAccountConfigSnapshot(accountId, next, true);
    return next.friendsListCacheTtlSec;
}

function getFriendBlacklist(accountId?: unknown): number[] {
    return [...(getAccountConfigSnapshot(accountId).friendBlacklist || [])];
}

function setFriendBlacklist(accountId: unknown, list: unknown[]): number[] {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, sharedState.accountFallbackConfig);
    next.friendBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.friendBlacklist];
}

function addFriendToBlacklist(accountId: unknown, gid: unknown): boolean {
    const gidNum = Number(gid);
    if (!gidNum || gidNum <= 0) return false;
    const current = getFriendBlacklist(accountId);
    if (current.includes(gidNum)) return false;
    const newList = [...current, gidNum];
    setFriendBlacklist(accountId, newList);
    return true;
}

function getStealDelaySeconds(accountId?: unknown): number {
    return Math.max(0, Math.min(300, Number(getAccountConfigSnapshot(accountId).stealDelaySeconds) || 0));
}

function getPlantOrderRandom(accountId?: unknown): boolean {
    return !!getAccountConfigSnapshot(accountId).plantOrderRandom;
}

function getPlantDelaySeconds(accountId?: unknown): number {
    return Math.max(0, Math.min(60, Number(getAccountConfigSnapshot(accountId).plantDelaySeconds) || 0));
}

function getFertilizerBuyOrganicCount(accountId?: unknown): number {
    return Math.max(0, Math.min(10000, Number(getAccountConfigSnapshot(accountId).fertilizerBuyOrganicCount) || 0));
}

function getFertilizerBuyOrganicThresholdHours(accountId?: unknown): number {
    return Math.max(0, Math.min(990, Number(getAccountConfigSnapshot(accountId).fertilizerBuyOrganicThresholdHours) || 0));
}

function getFertilizerBuyNormalCount(accountId?: unknown): number {
    return Math.max(0, Math.min(10000, Number(getAccountConfigSnapshot(accountId).fertilizerBuyNormalCount) || 0));
}

function getFertilizerBuyNormalThresholdHours(accountId?: unknown): number {
    return Math.max(0, Math.min(990, Number(getAccountConfigSnapshot(accountId).fertilizerBuyNormalThresholdHours) || 0));
}

function getFertilizerBuyCheckIntervalMinutes(accountId?: unknown): number {
    return Math.max(1, Math.min(1440, Number(getAccountConfigSnapshot(accountId).fertilizerBuyCheckIntervalMinutes) || 30));
}

function getAutoAcceptFriendMinLevel(accountId?: unknown): number {
    return normalizeAutoAcceptFriendMinLevel(getAccountConfigSnapshot(accountId).autoAcceptFriendMinLevel);
}

function getAutoAcceptRequireOwnLevel(accountId?: unknown): boolean {
    return !!getAccountConfigSnapshot(accountId).autoAcceptRequireOwnLevel;
}

function getAutoAcceptHarvestStealEnabled(accountId?: unknown): boolean {
    return !!getAccountConfigSnapshot(accountId).autoAcceptHarvestStealEnabled;
}

function getAutoAcceptHarvestStealHarvest(accountId?: unknown): number {
    return normalizeAutoAcceptHarvestStealHarvest(getAccountConfigSnapshot(accountId).autoAcceptHarvestStealHarvest);
}

function getAutoAcceptHarvestStealSteal(accountId?: unknown): number {
    return normalizeAutoAcceptHarvestStealSteal(getAccountConfigSnapshot(accountId).autoAcceptHarvestStealSteal);
}

function getPlantBlacklist(accountId?: unknown): number[] {
    return [...(getAccountConfigSnapshot(accountId).plantBlacklist || [])];
}

function setPlantBlacklist(accountId: unknown, list: unknown[]): number[] {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, sharedState.accountFallbackConfig);
    next.plantBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.plantBlacklist];
}

function getDefaultAccountConfig(): AccountConfig {
    return cloneAccountConfig(sharedState.DEFAULT_ACCOUNT_CONFIG);
}

module.exports = {
    getAccountConfigSnapshot,
    setAccountConfigSnapshot,
    removeAccountConfig,
    ensureAccountConfig,
    getConfigSnapshot,
    applyConfigSnapshot,
    getAutomation,
    setAutomation,
    isAutomationOn,
    getPreferredSeed,
    getPlantingStrategy,
    getBagSeedPriority,
    getBagSeedLandTypes,
    getBagSeedFallbackStrategy,
    getIntervals,
    getFriendQuietHours,
    getKnownFriendGids,
    setKnownFriendGids,
    getKnownFriendGidSyncCooldownSec,
    setKnownFriendGidSyncCooldownSec,
    getFriendsListCacheTtlSec,
    setFriendsListCacheTtlSec,
    getFriendBlacklist,
    setFriendBlacklist,
    addFriendToBlacklist,
    getStealDelaySeconds,
    getPlantOrderRandom,
    getPlantDelaySeconds,
    getFertilizerBuyOrganicCount,
    getFertilizerBuyOrganicThresholdHours,
    getFertilizerBuyNormalCount,
    getFertilizerBuyNormalThresholdHours,
    getFertilizerBuyCheckIntervalMinutes,
    getAutoAcceptFriendMinLevel,
    getAutoAcceptRequireOwnLevel,
    getAutoAcceptHarvestStealEnabled,
    getAutoAcceptHarvestStealHarvest,
    getAutoAcceptHarvestStealSteal,
    getPlantBlacklist,
    setPlantBlacklist,
    getDefaultAccountConfig,
};
