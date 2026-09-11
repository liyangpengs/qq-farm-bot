import type { AccountConfig, AutomationConfig, BagSeedFallbackStrategy, FertilizerLandType, GlobalConfig, IntervalConfig, LoginSettings, OfflineReminder, PlantingStrategy, QuietHoursConfig } from '../../types/config';
export {};

const { DEFAULT_TIME_ZONE, normalizeTimeZone, resolveClientVersion } = require('../../config/config');
const { getDataFile, ensureDataDir } = require('../../config/runtime-paths');
const { readJsonFile } = require('../../services/json-db');

const STORE_FILE: string = getDataFile('store.json');
const ACCOUNTS_FILE: string = getDataFile('accounts.json');
const KNOWN_FRIEND_GIDS_DIR: string = getDataFile('known_friend_gids');

const ALLOWED_PLANTING_STRATEGIES: PlantingStrategy[] = ['preferred', 'level', 'max_exp', 'max_fert_exp', 'max_profit', 'max_fert_profit', 'bag_priority'];
const ALLOWED_BAG_SEED_FALLBACK_STRATEGIES: BagSeedFallbackStrategy[] = ALLOWED_PLANTING_STRATEGIES.filter((s): s is BagSeedFallbackStrategy => s !== 'bag_priority');
const PUSHOO_CHANNELS: Set<string> = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher', 'meow',
]);

const DEFAULT_FERTILIZER_LAND_TYPES: FertilizerLandType[] = ['purple-gold', 'gold', 'black', 'red', 'normal'];
const FERTILIZER_LAND_TYPE_SET: Set<string> = new Set(DEFAULT_FERTILIZER_LAND_TYPES);
const INTERVAL_MAX_SEC: number = 86400;
const DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC: number = 300;
const DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC: number = 60;
let systemConfigMigrated: boolean = false;
let accountFallbackConfig: AccountConfig;

const DEFAULT_OFFLINE_REMINDER: OfflineReminder = {
    channel: 'webhook',
    endpoint: '',
    token: '',
    secret: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
};

const DEFAULT_LOGIN_SETTINGS: LoginSettings = {
    wechatQrLogin: true,
    qqQrLogin: false,
    napCatEndpoint: '',
    napCatSignature: '',
};

const DEFAULT_ACCOUNT_CONFIG: AccountConfig = {
    automation: {
        farm: true,
        farm_push: true,
        land_upgrade: true,
        friend: true,
        friend_auto_accept: true,
        friend_help_exp_limit: true,
        friend_steal: true,
        friend_help: true,
        friend_bad: true,
        friend_help_protect_dog_ignore_exp_limit: true,
        task: true,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        mystery_shop_auto_buy: false,
        mystery_shop_allow_gold: true,
        mystery_shop_allow_coupon: false,
        mystery_shop_allow_gold_bean: false,
        mystery_shop_allow_diamond: false,
        mystery_shop_arrival_notify: false,
        mystery_shop_purchase_notify: false,
        sell: true,
        fertilizer: 'smart',
        fertilizer_multi_season: true,
        fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES],
        fertilizer_smart_seconds: 300,
        skip_own_weed_bug: true,
        show_manual_fertilizer: true,
    },
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    intervals: {
        farm: 2,
        farmMin: 20,
        farmMax: 25,
        friendMin: 20,
        friendMax: 25,
        helpMin: 20,
        helpMax: 25,
        stealMin: 20,
        stealMax: 25,
    },
    friendQuietHours: {
        enabled: false,
        start: '01:00',
        end: '07:30',
        continueFarm: true,
    },
    knownFriendGids: [],
    knownFriendGidSyncCooldownSec: DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    friendsListCacheTtlSec: DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
    friendBlacklist: [],
    plantBlacklist: [
        20002,
        20003,
        20059,
        20065,
        20064,
        20060,
        20061,
    ],
    stealDelaySeconds: 1,
    plantOrderRandom: true,
    plantDelaySeconds: 2,
    fertilizerBuyOrganicCount: 1,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 1,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 60,
    bagSeedPriority: [],
    bagSeedMultiLandReservationEnabled: false,
    bagSeedLandTypes: {},
    bagSeedFallbackStrategy: 'level',
    autoAcceptFriendMinLevel: 0,
    autoAcceptRequireOwnLevel: false,
    autoAcceptHarvestStealEnabled: true,
    autoAcceptHarvestStealHarvest: 8,
    autoAcceptHarvestStealSteal: 1,
};

const ALLOWED_AUTOMATION_KEYS: Set<string> = new Set(Object.keys(DEFAULT_ACCOUNT_CONFIG.automation));

// ============ Normalization Helpers ============

function normalizeKnownFriendGids(input: unknown, fallback: number[] = []): number[] {
    const source: unknown[] = Array.isArray(input) ? input : fallback;
    const normalized: number[] = [];
    for (const item of source) {
        const value = Number.parseInt(item as string, 10);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

function normalizeKnownFriendGidSyncCooldownSec(input: unknown, fallback: number = DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(30, Math.min(INTERVAL_MAX_SEC, base));
}

function normalizeFriendsListCacheTtlSec(input: unknown, fallback: number = DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(10, Math.min(INTERVAL_MAX_SEC, base));
}

function normalizeAutoAcceptFriendMinLevel(input: unknown, fallback: number = 0): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(200, base));
}

function normalizeAutoAcceptHarvestStealHarvest(input: unknown, fallback: number = 8): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(9999, base));
}

function normalizeAutoAcceptHarvestStealSteal(input: unknown, fallback: number = 1): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(1, Math.min(9999, base));
}

function normalizeBagSeedPriority(input: unknown): number[] {
    if (!Array.isArray(input)) return [];
    const normalized: number[] = [];
    for (const item of input) {
        const value = Number.parseInt(item as string, 10);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

/**
 * seedId -> 允许的土地类型。缺 key、空数组、全类型三者等价于不限制，统一省略该 key。
 */
function normalizeBagSeedLandTypes(input: unknown): Record<string, FertilizerLandType[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const normalized: Record<string, FertilizerLandType[]> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        const seedId = Number.parseInt(key, 10);
        if (!Number.isFinite(seedId) || seedId <= 0) continue;
        if (!Array.isArray(value)) continue;
        const types: FertilizerLandType[] = [];
        for (const item of value) {
            const type = String(item || '').trim().toLowerCase();
            if (!FERTILIZER_LAND_TYPE_SET.has(type)) continue;
            if (types.includes(type as FertilizerLandType)) continue;
            types.push(type as FertilizerLandType);
        }
        if (types.length === 0 || types.length === DEFAULT_FERTILIZER_LAND_TYPES.length) continue;
        normalized[String(seedId)] = types;
    }
    return normalized;
}

function normalizeBagSeedFallbackStrategy(input: unknown, fallback: BagSeedFallbackStrategy = 'level'): BagSeedFallbackStrategy {
    const strategy = String(input || '').trim();
    if (ALLOWED_BAG_SEED_FALLBACK_STRATEGIES.includes(strategy as BagSeedFallbackStrategy)) return strategy as BagSeedFallbackStrategy;
    return fallback;
}

function normalizeFertilizerLandTypes(input: unknown, fallback: FertilizerLandType[] = DEFAULT_FERTILIZER_LAND_TYPES): FertilizerLandType[] {
    const source: unknown[] = Array.isArray(input) ? input : fallback;
    const normalized: FertilizerLandType[] = [];
    for (const item of source) {
        const value = String(item || '').trim().toLowerCase();
        if (!FERTILIZER_LAND_TYPE_SET.has(value)) continue;
        if (normalized.includes(value as FertilizerLandType)) continue;
        normalized.push(value as FertilizerLandType);
    }
    return normalized;
}

function normalizeTimeString(v: unknown, fallback: string): string {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return fallback;
    const hh = Math.max(0, Math.min(23, Number.parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, Number.parseInt(m[2], 10)));
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function normalizeIntervals(intervals: Partial<IntervalConfig> | undefined): IntervalConfig {
    const src = (intervals && typeof intervals === 'object') ? intervals : {} as Partial<IntervalConfig>;
    const toSec = (v: unknown, d: number): number => Math.max(1, Number.parseInt(v as string, 10) || d);
    const farm = toSec(src.farm, 2);

    let farmMin = toSec(src.farmMin, farm);
    let farmMax = toSec(src.farmMax, farm);
    if (farmMin > farmMax) [farmMin, farmMax] = [farmMax, farmMin];

    let helpMin = toSec(src.helpMin, 10);
    let helpMax = toSec(src.helpMax, 10);
    if (helpMin > helpMax) [helpMin, helpMax] = [helpMax, helpMin];

    let stealMin = toSec(src.stealMin, 10);
    let stealMax = toSec(src.stealMax, 10);
    if (stealMin > stealMax) [stealMin, stealMax] = [stealMax, stealMin];

    // 新配置使用统一好友任务间隔；旧账号自动取帮助/偷菜两组间隔中较快的一组。
    let friendMin = toSec(src.friendMin, Math.min(helpMin, stealMin));
    let friendMax = toSec(src.friendMax, Math.min(helpMax, stealMax));
    if (friendMin > friendMax) [friendMin, friendMax] = [friendMax, friendMin];

    return {
        ...src,
        farm,
        farmMin,
        farmMax,
        friendMin,
        friendMax,
        helpMin,
        helpMax,
        stealMin,
        stealMax,
    } as IntervalConfig;
}

function cloneAccountConfig(base: Partial<AccountConfig> = DEFAULT_ACCOUNT_CONFIG): AccountConfig {
    const srcAutomation = (base && base.automation && typeof base.automation === 'object')
        ? base.automation
        : {} as Partial<AutomationConfig>;
    const automation: AutomationConfig = { ...DEFAULT_ACCOUNT_CONFIG.automation };
    for (const key of Object.keys(automation) as Array<keyof AutomationConfig>) {
        if (key === 'fertilizer_land_types') {
            automation[key] = normalizeFertilizerLandTypes(srcAutomation[key], DEFAULT_FERTILIZER_LAND_TYPES);
            continue;
        }
        if (srcAutomation[key] !== undefined) (automation as any)[key] = (srcAutomation as any)[key];
    }

    const rawBlacklist: number[] = Array.isArray(base.friendBlacklist) ? base.friendBlacklist : [];

    const knownFriendGids = normalizeKnownFriendGids(base.knownFriendGids);
    const knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(base.knownFriendGidSyncCooldownSec);
    const friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(base.friendsListCacheTtlSec);

    const rawPlantBlacklist: number[] = Array.isArray(base.plantBlacklist) ? base.plantBlacklist : [];

    return {
        ...DEFAULT_ACCOUNT_CONFIG,
        ...base,
        automation,
        intervals: { ...(base.intervals || DEFAULT_ACCOUNT_CONFIG.intervals) },
        friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours, ...(base.friendQuietHours || {}) },
        knownFriendGids,
        knownFriendGidSyncCooldownSec,
        friendsListCacheTtlSec,
        friendBlacklist: rawBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        plantingStrategy: ALLOWED_PLANTING_STRATEGIES.includes(String(base.plantingStrategy || '') as PlantingStrategy)
            ? String(base.plantingStrategy) as PlantingStrategy
            : DEFAULT_ACCOUNT_CONFIG.plantingStrategy,
        preferredSeedId: Math.max(0, Number.parseInt(String(base.preferredSeedId), 10) || 0),
        plantBlacklist: rawPlantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        stealDelaySeconds: Math.max(0, Math.min(300, Number(base.stealDelaySeconds) || 0)),
        plantOrderRandom: !!(base.plantOrderRandom),
        plantDelaySeconds: Math.max(0, Math.min(60, Number(base.plantDelaySeconds) || 0)),
        fertilizerBuyOrganicCount: Math.max(0, Math.min(10000, Number(base.fertilizerBuyOrganicCount) || 0)),
        fertilizerBuyOrganicThresholdHours: Math.max(0, Math.min(990, Number(base.fertilizerBuyOrganicThresholdHours) || 0)),
        fertilizerBuyNormalCount: Math.max(0, Math.min(10000, Number(base.fertilizerBuyNormalCount) || 0)),
        fertilizerBuyNormalThresholdHours: Math.max(0, Math.min(990, Number(base.fertilizerBuyNormalThresholdHours) || 0)),
        fertilizerBuyCheckIntervalMinutes: Math.max(1, Math.min(1440, Number(base.fertilizerBuyCheckIntervalMinutes) || 30)),
        bagSeedPriority: normalizeBagSeedPriority(base.bagSeedPriority),
        bagSeedMultiLandReservationEnabled: base.bagSeedMultiLandReservationEnabled !== undefined
            ? !!base.bagSeedMultiLandReservationEnabled
            : DEFAULT_ACCOUNT_CONFIG.bagSeedMultiLandReservationEnabled,
        bagSeedLandTypes: normalizeBagSeedLandTypes(base.bagSeedLandTypes),
        bagSeedFallbackStrategy: normalizeBagSeedFallbackStrategy(base.bagSeedFallbackStrategy),
        autoAcceptFriendMinLevel: normalizeAutoAcceptFriendMinLevel(base.autoAcceptFriendMinLevel, DEFAULT_ACCOUNT_CONFIG.autoAcceptFriendMinLevel),
        autoAcceptRequireOwnLevel: !!base.autoAcceptRequireOwnLevel,
        autoAcceptHarvestStealEnabled: base.autoAcceptHarvestStealEnabled !== undefined
            ? !!base.autoAcceptHarvestStealEnabled
            : DEFAULT_ACCOUNT_CONFIG.autoAcceptHarvestStealEnabled,
        autoAcceptHarvestStealHarvest: normalizeAutoAcceptHarvestStealHarvest(base.autoAcceptHarvestStealHarvest, DEFAULT_ACCOUNT_CONFIG.autoAcceptHarvestStealHarvest),
        autoAcceptHarvestStealSteal: normalizeAutoAcceptHarvestStealSteal(base.autoAcceptHarvestStealSteal, DEFAULT_ACCOUNT_CONFIG.autoAcceptHarvestStealSteal),
    };
}

function normalizeAccountConfig(input: unknown, fallback: AccountConfig = accountFallbackConfig): AccountConfig {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const cfg = cloneAccountConfig(fallback || DEFAULT_ACCOUNT_CONFIG);

    if (src.automation && typeof src.automation === 'object') {
        for (const [k, v] of Object.entries(src.automation)) {
            if (!ALLOWED_AUTOMATION_KEYS.has(k)) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'smart', 'none'];
                (cfg.automation as any)[k] = allowed.includes(v as string) ? v : cfg.automation[k as keyof AutomationConfig];
            } else if (k === 'fertilizer_land_types') {
                cfg.automation.fertilizer_land_types = normalizeFertilizerLandTypes(v, cfg.automation.fertilizer_land_types);
            } else if (k === 'fertilizer_smart_seconds') {
                cfg.automation.fertilizer_smart_seconds = Math.max(30, Math.min(3600, Number(v) || 300));
            } else {
                (cfg.automation as any)[k] = !!v;
            }
        }
    }

    if (src.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(src.plantingStrategy)) {
        cfg.plantingStrategy = src.plantingStrategy;
    }

    if (src.preferredSeedId !== undefined && src.preferredSeedId !== null) {
        cfg.preferredSeedId = Math.max(0, Number.parseInt(src.preferredSeedId, 10) || 0);
    }

    if (src.intervals && typeof src.intervals === 'object') {
        for (const [type, sec] of Object.entries(src.intervals)) {
            if (cfg.intervals[type] === undefined) continue;
            cfg.intervals[type] = Math.max(1, Number.parseInt(sec as string, 10) || cfg.intervals[type] || 1);
        }
        cfg.intervals = normalizeIntervals(cfg.intervals);
    } else {
        cfg.intervals = normalizeIntervals(cfg.intervals);
    }

    if (src.friendQuietHours && typeof src.friendQuietHours === 'object') {
        const old: Partial<QuietHoursConfig> = cfg.friendQuietHours || {};
        cfg.friendQuietHours = {
            enabled: src.friendQuietHours.enabled !== undefined ? !!src.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(src.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(src.friendQuietHours.end, old.end || '07:00'),
            continueFarm: src.friendQuietHours.continueFarm !== undefined
                ? !!src.friendQuietHours.continueFarm
                : (old.continueFarm !== undefined ? !!old.continueFarm : true),
        };
    }

    if (Array.isArray(src.friendBlacklist)) {
        cfg.friendBlacklist = src.friendBlacklist.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
    }

    if (src.knownFriendGids !== undefined) {
        cfg.knownFriendGids = normalizeKnownFriendGids(src.knownFriendGids, cfg.knownFriendGids);
    }

    if (src.knownFriendGidSyncCooldownSec !== undefined) {
        cfg.knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(
            src.knownFriendGidSyncCooldownSec,
            cfg.knownFriendGidSyncCooldownSec,
        );
    }

    if (src.friendsListCacheTtlSec !== undefined) {
        cfg.friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(
            src.friendsListCacheTtlSec,
            cfg.friendsListCacheTtlSec,
        );
    }

    if (Array.isArray(src.plantBlacklist)) {
        cfg.plantBlacklist = src.plantBlacklist.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
    }

    if (src.stealDelaySeconds !== undefined && src.stealDelaySeconds !== null) {
        cfg.stealDelaySeconds = Math.max(0, Math.min(300, Number.parseInt(src.stealDelaySeconds, 10) || 0));
    }

    if (src.plantOrderRandom !== undefined && src.plantOrderRandom !== null) {
        cfg.plantOrderRandom = !!src.plantOrderRandom;
    }

    if (src.plantDelaySeconds !== undefined && src.plantDelaySeconds !== null) {
        cfg.plantDelaySeconds = Math.max(0, Math.min(60, Number(src.plantDelaySeconds) || 0));
    }

    if (src.fertilizerBuyOrganicCount !== undefined && src.fertilizerBuyOrganicCount !== null) {
        cfg.fertilizerBuyOrganicCount = Math.max(0, Math.min(10000, Number(src.fertilizerBuyOrganicCount) || 0));
    }

    if (src.fertilizerBuyOrganicThresholdHours !== undefined && src.fertilizerBuyOrganicThresholdHours !== null) {
        cfg.fertilizerBuyOrganicThresholdHours = Math.max(0, Math.min(990, Number(src.fertilizerBuyOrganicThresholdHours) || 0));
    }

    if (src.fertilizerBuyNormalCount !== undefined && src.fertilizerBuyNormalCount !== null) {
        cfg.fertilizerBuyNormalCount = Math.max(0, Math.min(10000, Number(src.fertilizerBuyNormalCount) || 0));
    }

    if (src.fertilizerBuyNormalThresholdHours !== undefined && src.fertilizerBuyNormalThresholdHours !== null) {
        cfg.fertilizerBuyNormalThresholdHours = Math.max(0, Math.min(990, Number(src.fertilizerBuyNormalThresholdHours) || 0));
    }

    if (src.fertilizerBuyCheckIntervalMinutes !== undefined && src.fertilizerBuyCheckIntervalMinutes !== null) {
        cfg.fertilizerBuyCheckIntervalMinutes = Math.max(1, Math.min(1440, Number(src.fertilizerBuyCheckIntervalMinutes) || 30));
    }

    if (src.bagSeedPriority !== undefined && src.bagSeedPriority !== null) {
        cfg.bagSeedPriority = normalizeBagSeedPriority(src.bagSeedPriority);
    }

    if (src.bagSeedMultiLandReservationEnabled !== undefined && src.bagSeedMultiLandReservationEnabled !== null) {
        cfg.bagSeedMultiLandReservationEnabled = !!src.bagSeedMultiLandReservationEnabled;
    }

    if (src.bagSeedLandTypes !== undefined && src.bagSeedLandTypes !== null) {
        cfg.bagSeedLandTypes = normalizeBagSeedLandTypes(src.bagSeedLandTypes);
    }

    if (src.bagSeedFallbackStrategy !== undefined && src.bagSeedFallbackStrategy !== null) {
        cfg.bagSeedFallbackStrategy = normalizeBagSeedFallbackStrategy(src.bagSeedFallbackStrategy, cfg.bagSeedFallbackStrategy);
    }

    if (src.autoAcceptFriendMinLevel !== undefined && src.autoAcceptFriendMinLevel !== null) {
        cfg.autoAcceptFriendMinLevel = normalizeAutoAcceptFriendMinLevel(src.autoAcceptFriendMinLevel, cfg.autoAcceptFriendMinLevel);
    }

    if (src.autoAcceptRequireOwnLevel !== undefined && src.autoAcceptRequireOwnLevel !== null) {
        cfg.autoAcceptRequireOwnLevel = !!src.autoAcceptRequireOwnLevel;
    }

    if (src.autoAcceptHarvestStealEnabled !== undefined && src.autoAcceptHarvestStealEnabled !== null) {
        cfg.autoAcceptHarvestStealEnabled = !!src.autoAcceptHarvestStealEnabled;
    }

    if (src.autoAcceptHarvestStealHarvest !== undefined && src.autoAcceptHarvestStealHarvest !== null) {
        cfg.autoAcceptHarvestStealHarvest = normalizeAutoAcceptHarvestStealHarvest(src.autoAcceptHarvestStealHarvest, cfg.autoAcceptHarvestStealHarvest);
    }

    if (src.autoAcceptHarvestStealSteal !== undefined && src.autoAcceptHarvestStealSteal !== null) {
        cfg.autoAcceptHarvestStealSteal = normalizeAutoAcceptHarvestStealSteal(src.autoAcceptHarvestStealSteal, cfg.autoAcceptHarvestStealSteal);
    }

    return cfg;
}

// ============ Global Config (mutable shared state) ============

accountFallbackConfig = {
    ...DEFAULT_ACCOUNT_CONFIG,
    automation: { ...DEFAULT_ACCOUNT_CONFIG.automation, fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES] },
    intervals: { ...DEFAULT_ACCOUNT_CONFIG.intervals },
    friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours },
    knownFriendGids: [],
    knownFriendGidSyncCooldownSec: DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    friendsListCacheTtlSec: DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
};

const globalConfig: GlobalConfig = {
    accountConfigs: {},
    defaultAccountConfig: cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG),
    ui: {
        theme: 'light',
    },
    loginSettings: { ...DEFAULT_LOGIN_SETTINGS },
    offlineReminder: { ...DEFAULT_OFFLINE_REMINDER },
    systemConfig: null,
};

function resolveAccountId(accountId: unknown): string {
    const direct = (accountId !== undefined && accountId !== null) ? String(accountId).trim() : '';
    if (direct) return direct;
    const envId = String((process as any).env.FARM_ACCOUNT_ID || '').trim();
    return envId;
}

function loadGlobalConfig(): void {
    ensureDataDir();
    try {
        const data: any = readJsonFile(STORE_FILE, () => ({}));
        if (data && typeof data === 'object') {
            accountFallbackConfig = cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
            globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

            const cfgMap = (data.accountConfigs && typeof data.accountConfigs === 'object')
                ? data.accountConfigs
                : {};
            globalConfig.accountConfigs = {};
            for (const [id, cfg] of Object.entries(cfgMap)) {
                const sid = String(id || '').trim();
                if (!sid) continue;
                globalConfig.accountConfigs[sid] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
            }
            for (const [id, cfg] of Object.entries(globalConfig.accountConfigs)) {
                globalConfig.accountConfigs[id] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
            }
            globalConfig.ui = { ...globalConfig.ui, ...(data.ui || {}) };
            const theme = String(globalConfig.ui.theme || '').toLowerCase();
            globalConfig.ui.theme = theme === 'light' ? 'light' : 'dark';

            // offlineReminder normalization done in global-config
            if (data.offlineReminder && typeof data.offlineReminder === 'object') {
                globalConfig.offlineReminder = data.offlineReminder;
            }

            if (data.loginSettings && typeof data.loginSettings === 'object') {
                globalConfig.loginSettings = {
                    wechatQrLogin: typeof data.loginSettings.wechatQrLogin === 'boolean'
                        ? data.loginSettings.wechatQrLogin
                        : DEFAULT_LOGIN_SETTINGS.wechatQrLogin,
                    qqQrLogin: typeof data.loginSettings.qqQrLogin === 'boolean'
                        ? data.loginSettings.qqQrLogin
                        : DEFAULT_LOGIN_SETTINGS.qqQrLogin,
                    napCatEndpoint: typeof data.loginSettings.napCatEndpoint === 'string'
                        ? data.loginSettings.napCatEndpoint.trim()
                        : DEFAULT_LOGIN_SETTINGS.napCatEndpoint,
                    napCatSignature: typeof data.loginSettings.napCatSignature === 'string'
                        ? data.loginSettings.napCatSignature.trim()
                        : DEFAULT_LOGIN_SETTINGS.napCatSignature,
                };
            }

            if (data.systemConfig && typeof data.systemConfig === 'object') {
                const srcDevice = (data.systemConfig.deviceInfo && typeof data.systemConfig.deviceInfo === 'object')
                    ? data.systemConfig.deviceInfo : {};
                const deviceOs = String(srcDevice.os || data.systemConfig.os || 'Windows').trim();
                const savedTopVersion = String(data.systemConfig.clientVersion || '').trim();
                const savedDeviceVersion = String(srcDevice.clientVersion || '').trim();
                const savedVersion = savedDeviceVersion || savedTopVersion;
                const savedVersionUpdatedAt = Number(data.systemConfig.clientVersionUpdatedAt);
                const {
                    clientVersion: deviceClientVersion,
                    clientVersionUpdatedAt: deviceClientVersionUpdatedAt,
                } = resolveClientVersion(savedVersion, savedVersionUpdatedAt);
                const normalizedSystemConfig = {
                    serverUrl: String(data.systemConfig.serverUrl || '').trim(),
                    clientVersion: deviceClientVersion,
                    clientVersionUpdatedAt: deviceClientVersionUpdatedAt,
                    platform: String(data.systemConfig.platform || 'qq').trim(),
                    os: deviceOs,
                    timeZone: normalizeTimeZone(data.systemConfig.timeZone || DEFAULT_TIME_ZONE),
                    deviceInfo: {
                        os: deviceOs,
                        clientVersion: deviceClientVersion,
                        sysSoftware: String(srcDevice.sysSoftware || 'Windows').trim(),
                        network: String(srcDevice.network || 'wifi').trim(),
                        memory: String(srcDevice.memory || '16384').trim(),
                        deviceId: String(srcDevice.deviceId || 'DESKTOP-PC<WPC>').trim(),
                        userAgent: String(srcDevice.userAgent || '').trim(),
                    },
                };
                systemConfigMigrated = savedTopVersion !== deviceClientVersion
                    || savedDeviceVersion !== deviceClientVersion
                    || Number(data.systemConfig.clientVersionUpdatedAt) !== deviceClientVersionUpdatedAt
                    || data.systemConfig.timeZone !== normalizedSystemConfig.timeZone;
                globalConfig.systemConfig = normalizedSystemConfig;
            }
        }
    } catch (e: any) {
        console.error('加载配置失败:', e.message);
    }
}

module.exports = {
    // File paths
    STORE_FILE,
    ACCOUNTS_FILE,
    KNOWN_FRIEND_GIDS_DIR,
    // Constants
    ALLOWED_PLANTING_STRATEGIES,
    ALLOWED_BAG_SEED_FALLBACK_STRATEGIES,
    PUSHOO_CHANNELS,
    DEFAULT_FERTILIZER_LAND_TYPES,
    FERTILIZER_LAND_TYPE_SET,
    INTERVAL_MAX_SEC,
    DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
    DEFAULT_OFFLINE_REMINDER,
    DEFAULT_LOGIN_SETTINGS,
    DEFAULT_ACCOUNT_CONFIG,
    ALLOWED_AUTOMATION_KEYS,
    // Mutable shared state (by reference)
    globalConfig,
    get accountFallbackConfig() { return accountFallbackConfig; },
    set accountFallbackConfig(v: AccountConfig) { accountFallbackConfig = v; },
    get systemConfigMigrated() { return systemConfigMigrated; },
    set systemConfigMigrated(v: boolean) { systemConfigMigrated = !!v; },
    // Helpers
    normalizeKnownFriendGids,
    normalizeKnownFriendGidSyncCooldownSec,
    normalizeFriendsListCacheTtlSec,
    normalizeBagSeedPriority,
    normalizeBagSeedLandTypes,
    normalizeBagSeedFallbackStrategy,
    normalizeFertilizerLandTypes,
    normalizeTimeString,
    normalizeIntervals,
    normalizeAutoAcceptFriendMinLevel,
    normalizeAutoAcceptHarvestStealHarvest,
    normalizeAutoAcceptHarvestStealSteal,
    normalizeAccountConfig,
    cloneAccountConfig,
    resolveAccountId,
    loadGlobalConfig,
};
