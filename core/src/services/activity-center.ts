/** 活动中心公共 DTO、快照编排与分活动服务聚合。 */

import type Long from 'long';
import shareRewardInstances from '../activity-data/share-reward-instances.json';
import pendingContent from '../activity-data/pending-content.json';

const LongModule = require('long');
const { sendMsgAsync, GatewayError } = require('../utils/network');
const { types } = require('../utils/proto');
const { getItemById, getItemImageById, getEffectiveSellInfo, getMutantEffectsByIds } = require('../config/gameConfig');
const { getServerTimeSec, getSystemDateKey } = require('../utils/utils');
const { getBag, getBagItems } = require('./warehouse');
const { getActivityWindows, getSellConditionContext } = require('./activity-windows');
const { buildActivityGameplayBindings, resolveActivityGameplays } = require('./activity-gameplay-registry');
const { reportActivityShare } = require('./share');
const weatherActivityService = require('./weather-activity');
const { createStellarActivityService } = require('./activity-center/stellar');
const { createCharityActivityService } = require('./activity-center/charity');
const { createQixiActivityService } = require('./activity-center/qixi');
const { createQingMeiActivityService } = require('./activity-center/qingmei');
const { createPetDiaryService } = require('./activity-center/pet-diary');
const {
    createEmptyCharityRedFlowerState,
    loadCharityRedFlowerState,
    mergeCharityRedFlowerStates,
    mergeConstellationStates,
    persistCharityRedFlowerState,
    stateRecordKey,
    loadConstellationState,
    persistConstellationState,
    stateFromDynamicNodes,
    stateWithNoClaimableDay,
} = require('./activity-center-state');

const MAX_SIGNED_INT64 = 9223372036854775807n;

type Int64Like = Long | number | string | null | undefined;
type SettledEntry = PromiseSettledResult<any>;

class ActivityBusinessError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'ActivityBusinessError';
        this.code = code;
    }
}

function businessError(code: string, message: string): ActivityBusinessError {
    return new ActivityBusinessError(code, message);
}

function positiveDecimal(value: unknown, code: string, fieldName: string): string {
    let normalized = '';
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
        normalized = value;
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        normalized = String(value);
    }
    if (!normalized || normalized.length > 19 || BigInt(normalized) > MAX_SIGNED_INT64) {
        throw businessError(code, `${fieldName} 必须是 int64 范围内的正十进制整数`);
    }
    return normalized;
}

let mutationTail: Promise<void> = Promise.resolve();
let pendingSnapshotRequest: Promise<any> | null = null;

function int64String(value: Int64Like): string {
    if (value == null) return '0';
    if (LongModule.isLong(value)) return (value as Long).toString();
    if (typeof value === 'string') return /^-?\d+$/.test(value) ? value : '0';
    return Number.isSafeInteger(value) ? String(value) : '0';
}

function int64Number(value: Int64Like): number {
    const parsed = Number(int64String(value));
    return Number.isSafeInteger(parsed) ? parsed : 0;
}

function compareInt64(left: Int64Like, right: Int64Like): number {
    const leftValue = BigInt(int64String(left));
    const rightValue = BigInt(int64String(right));
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function bytesToText(value: Uint8Array | Buffer | string | null | undefined): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    const buffer = Buffer.from(value);
    const utf8 = buffer.toString('utf8');
    if (!utf8.includes('�')) return utf8;
    try {
        return new TextDecoder('gb18030').decode(buffer);
    } catch {
        return utf8;
    }
}

function plainText(value: unknown): string {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
}

function findStrings(value: unknown, output: string[]): void {
    if (typeof value === 'string') {
        const text = plainText(value);
        if (text) output.push(text);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(entry => findStrings(entry, output));
        return;
    }
    if (value && typeof value === 'object') {
        Object.values(value as Record<string, unknown>).forEach(entry => findStrings(entry, output));
    }
}

function textContent(value: Uint8Array | Buffer | string | null | undefined): { title: string; paragraphs: string[] } {
    const text = bytesToText(value).trim();
    if (!text) return { title: '', paragraphs: [] };
    try {
        const parsed = JSON.parse(text);
        const tips = parsed && typeof parsed === 'object' ? parsed.tips : null;
        const rawParagraphs = tips && Array.isArray(tips.txt) ? tips.txt : [];
        const paragraphs = rawParagraphs
            .filter((entry: unknown): entry is string => typeof entry === 'string')
            .map(plainText)
            .filter(Boolean);
        if (paragraphs.length) {
            return { title: typeof tips?.title === 'string' ? plainText(tips.title) : '', paragraphs };
        }
        const allText: string[] = [];
        findStrings(parsed, allText);
        return { title: '', paragraphs: Array.from(new Set(allText)) };
    } catch {
        return { title: '', paragraphs: [plainText(text)].filter(Boolean) };
    }
}

function parseJsonText(value: Uint8Array | Buffer | string | null | undefined): unknown {
    const text = bytesToText(value).trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function parseNestedJsonValue(value: unknown, depth = 0): unknown {
    if (depth >= 6) return value;
    if (Array.isArray(value)) return value.map(entry => parseNestedJsonValue(entry, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .map(([key, entry]) => [key, parseNestedJsonValue(entry, depth + 1)]));
    }
    if (typeof value !== 'string') return value;

    const text = value.trim();
    if (!text) return value;
    try {
        return parseNestedJsonValue(JSON.parse(text), depth + 1);
    } catch {
        // 抓包中的 activity.extra 会在 JSON 属性内再次嵌套 Base64 JSON。
    }

    let encoded = text;
    for (let nesting = 0; nesting < 3; nesting += 1) {
        if (encoded.length < 4 || encoded.length % 4 === 1 || !/^[A-Z0-9+/]+={0,2}$/i.test(encoded)) break;
        const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
        const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
        if (!decoded || decoded.includes('�')) break;
        try {
            return parseNestedJsonValue(JSON.parse(decoded), depth + 1);
        } catch {
            encoded = decoded;
        }
    }
    return value;
}

function parseActivityExtra(value: Uint8Array | Buffer | string | null | undefined): unknown {
    const parsed = parseJsonText(value);
    return parseNestedJsonValue(parsed);
}

function itemDto(item: any) {
    const rawId = item?.item_id ?? item?.itemId ?? item?.id;
    const id = int64String(rawId);
    const numericId = int64Number(rawId);
    const metadata = numericId > 0 ? getItemById(numericId) : undefined;
    return {
        id,
        count: int64String(item?.count),
        name: metadata?.name || bytesToText(item?.name),
        image: numericId > 0 ? getItemImageById(numericId) : '',
        rarity: Number(metadata?.rarity) || 0,
    };
}

function activityDto(activity: any) {
    return {
        id: int64String(activity?.activity_id),
        typeCode: int64String(activity?.type),
        name: bytesToText(activity?.name),
        startTime: int64String(activity?.begin_time),
        endTime: int64String(activity?.end_time),
        extra: parseActivityExtra(activity?.extra),
    };
}

function activityWindowIsActive(activity: any, serverTime = getServerTimeSec()): boolean {
    const beginTime = int64Number(activity?.begin_time ?? activity?.beginTime);
    const endTime = int64Number(activity?.end_time ?? activity?.endTime);
    return (beginTime <= 0 || serverTime >= beginTime) && (endTime <= 0 || serverTime <= endTime);
}

const {
    querySeason,
    querySolarTerms,
    normalizeSeason,
    normalizeSolarTerms,
    queryShopFromSeason,
    buildActions,
    constellationFromSeasonReply,
    getCurrentSeasonEvent,
    getCurrentStarSandShop,
    getCurrentSolarTerms,
    getCurrentStellarActivity,
    claimBattlePassRewards,
    exchangeStarSandGoods,
    lightConstellation,
    claimSolarTerm,
} = createStellarActivityService({
    types,
    sendMsgAsync,
    GatewayError,
    getBag,
    getServerTimeSec,
    mergeConstellationStates,
    stateRecordKey,
    loadConstellationState,
    persistConstellationState,
    stateFromDynamicNodes,
    stateWithNoClaimableDay,
    int64String,
    int64Number,
    compareInt64,
    bytesToText,
    textContent,
    parseJsonText,
    activityDto,
    itemDto,
    businessError,
    positiveDecimal,
    readBagBalances,
    settleRequest,
    settledValue,
    settledError,
    serializeMutation,
    getActivityCenterSnapshot,
});

const {
    getCurrentCharityRedFlowerActivity,
    claimCharityRedFlowerSeeds,
    donateCharityRedFlowerLove,
    claimCharityRedFlowerDailyGift,
    claimCharityRedFlowerProgressReward,
    charityRedFlowerDto,
    reconcileCharityProgressState,
} = createCharityActivityService({
    types,
    sendMsgAsync,
    GatewayError,
    getServerTimeSec,
    getSystemDateKey,
    createEmptyCharityRedFlowerState,
    loadCharityRedFlowerState,
    mergeCharityRedFlowerStates,
    persistCharityRedFlowerState,
    int64String,
    int64Number,
    compareInt64,
    bytesToText,
    itemDto,
    textContent,
    businessError,
    positiveDecimal,
    activityWindowIsActive,
    serializeMutation,
});

const {
    getCurrentQixiActivity,
    claimQixiBridgeRewards,
    giftQixiSachet,
} = createQixiActivityService({
    types,
    sendMsgAsync,
    getBag,
    getSellConditionContext,
    getItemById,
    getEffectiveSellInfo,
    getServerTimeSec,
    int64String,
    int64Number,
    bytesToText,
    itemDto,
    textContent,
    businessError,
    positiveDecimal,
    activityWindowIsActive,
    readBagBalances,
    serializeMutation,
    getActivityCenterSnapshot,
});

const {
    getCurrentQingMeiActivity,
    claimQingMeiDailySeed,
    startQingMeiBrew,
    continueQingMeiBrew,
    settleQingMeiBrew,
} = createQingMeiActivityService({
    types,
    sendMsgAsync,
    GatewayError,
    getBag,
    getBagItems,
    getMutantEffectsByIds,
    getActivityWindows,
    getSystemDateKey,
    reportActivityShare,
    int64String,
    int64Number,
    bytesToText,
    itemDto,
    textContent,
    businessError,
    positiveDecimal,
    activityWindowIsActive,
    serializeMutation,
    getActivityCenterSnapshot,
});

function readBagBalances(bagReply: any, currencyIds: string[]): Map<string, string> {
    const requestedIds = new Set(currencyIds);
    const balances = new Map<string, bigint>(currencyIds.map(id => [id, 0n]));
    for (const item of getBagItems(bagReply)) {
        const id = int64String(item?.id ?? item?.item_id);
        if (!requestedIds.has(id)) continue;
        const count = BigInt(int64String(item?.count));
        balances.set(id, (balances.get(id) || 0n) + (count > 0n ? count : 0n));
    }
    return new Map(Array.from(balances, ([id, count]) => [id, count.toString()]));
}

function settledValue(entry: SettledEntry): any | null {
    return entry.status === 'fulfilled' ? entry.value : null;
}

function settledError(entry: SettledEntry): string | null {
    if (entry.status === 'fulfilled') return null;
    return String(entry.reason?.message || entry.reason || '未知错误');
}

async function settleRequest(operation: () => Promise<any>): Promise<SettledEntry> {
    try {
        return { status: 'fulfilled', value: await operation() };
    } catch (reason) {
        return { status: 'rejected', reason };
    }
}

function buildActivityDirectory(windows: any[], season: any, shop: any, solarTerms: any, constellation: any, qixi: any = null, weather: any = null, qingMei: any = null, charity: any = null) {
    const gameplayBindings = buildActivityGameplayBindings({ season, shop, solarTerms, constellation, qixi, weather, qingMei, charity });
    const groups: any[] = [];
    for (const window of windows) {
        const id = String(window?.id || '').trim();
        if (!id) continue;
        const shareInstance = shareRewardInstances.find(entry => entry.activityId === id);
        const placeholder = pendingContent.activities.find(entry => entry.activityIds.includes(id));
        const name = shareInstance?.title || String(window?.name || '').trim() || placeholder?.name || `活动 ${id}`;
        const startTime = Number(window?.beginTime) || 0;
        const endTime = Number(window?.endTime) || 0;
        const group = groups.find((entry: any) => (
            (!shareInstance || entry.id === id)
            && (!shareRewardInstances.some(instance => entry.activityIds.includes(instance.activityId)) || entry.id === id)
            && entry.name === name
            && (entry.endTime <= 0 || startTime <= 0 || entry.endTime >= startTime)
            && (endTime <= 0 || entry.startTime <= 0 || endTime >= entry.startTime)
        ));
        if (group) {
            group.activityIds.push(id);
            group.startTime = group.startTime > 0 && startTime > 0 ? Math.min(group.startTime, startTime) : Math.max(group.startTime, startTime);
            group.endTime = Math.max(group.endTime, endTime);
            if (!group.id.endsWith('00') && id.endsWith('00')) group.id = id;
            continue;
        }
        groups.push({
            id,
            name,
            startTime,
            endTime,
            activityIds: [id],
        });
    }
    return groups.map(group => ({
        ...group,
        instanceId: shareRewardInstances.find(entry => group.activityIds.includes(entry.activityId))?.activityId || null,
        name: group.activityIds.some((id: string) => ['2026090100', '2026090101', '2026090102', '2026090103'].includes(id)) ? '萌宠成长日记' : group.name,
        ...resolveActivityGameplays(group.activityIds, gameplayBindings),
    }));
}

async function buildActivityCenterSnapshot(shopOverride: any = null) {
    // 星座 type=21 是写操作，读取快照只能使用赛季发现信息和最近一次写操作回包。
    // Gateway calls are intentionally serial. The game connection can stop
    // responding when activity metadata and bag reads are sent as one burst.
    const seasonResult = await settleRequest(querySeason);
    const solarResult = await settleRequest(querySolarTerms);
    const activityListResult = await settleRequest(getActivityWindows);
    const qixiResult = await settleRequest(getCurrentQixiActivity);
    const qingMeiResult = await settleRequest(getCurrentQingMeiActivity);
    const charityResult = await settleRequest(getCurrentCharityRedFlowerActivity);
    const weatherResult = await settleRequest(weatherActivityService.getCurrentWeatherActivity);
    const rawSeason = settledValue(seasonResult);
    const season = rawSeason ? normalizeSeason(rawSeason) : null;
    const solarTerms = solarResult.status === 'fulfilled' ? normalizeSolarTerms(solarResult.value) : null;
    const qixi = settledValue(qixiResult);
    const qingMei = settledValue(qingMeiResult);
    const charity = settledValue(charityResult);
    const weather = settledValue(weatherResult);

    let shopResult: SettledEntry;
    if (shopOverride) {
        shopResult = { status: 'fulfilled', value: shopOverride };
    } else if (rawSeason) {
        shopResult = await settleRequest(() => queryShopFromSeason(rawSeason));
    } else {
        shopResult = { status: 'rejected', reason: new Error('赛季查询失败，无法发现活动商店 ID') };
    }
    const shop = settledValue(shopResult);
    const constellation = rawSeason ? constellationFromSeasonReply(rawSeason) : null;
    const actions = {
        ...buildActions(season, solarTerms, constellation, shop),
        qixiBridge: qixi?.actions?.bridge || { enabled: false, available: false, availabilityKnown: false },
        qixiGift: qixi?.actions?.gift || { enabled: false, available: false, availabilityKnown: false },
        qixiDew: qixi?.actions?.dew || { enabled: false, available: false, availabilityKnown: false },
        charityClaimSeeds: charity?.actions?.claimSeeds || { enabled: false, available: false, availabilityKnown: false },
        charityDonateLove: charity?.actions?.donateLove || { enabled: false, available: false, availabilityKnown: false },
        charityClaimDailyGift: charity?.actions?.claimDailyGift || { enabled: false, available: false, availabilityKnown: false },
        weatherResearch: weather?.actions?.advanceResearch || weather?.actions?.research || { enabled: false, available: false, availabilityKnown: false },
    };
    const activityWindows = settledValue(activityListResult) || [];
    return {
        serverTime: getServerTimeSec(),
        activities: buildActivityDirectory(activityWindows, season, shop, solarTerms, constellation, qixi, weather, qingMei, charity),
        season,
        constellation,
        shop,
        solarTerms,
        qixi,
        qingMei,
        charity,
        weather,
        capabilities: {
            claimPass: actions.claimPass.supported,
            lightConstellation: actions.lightConstellation.supported,
            claimSolar: actions.claimSolar.supported,
            exchange: actions.exchange.supported,
            qixiBridge: !!qixi,
            qixiGift: !!qixi,
            qixiDew: !!qixi,
            qingMei: !!qingMei,
            charity: !!charity,
            charityClaimSeeds: !!charity,
            charityDonateLove: !!charity,
            charityClaimDailyGift: !!charity,
            weatherResearch: !!weather,
        },
        actions,
        errors: {
            season: settledError(seasonResult),
            shop: settledError(shopResult),
            solarTerms: settledError(solarResult),
            qixi: settledError(qixiResult),
            qingMei: settledError(qingMeiResult),
            charity: settledError(charityResult),
            weather: settledError(weatherResult),
            activities: settledError(activityListResult),
        },
    };
}

function getActivityCenterSnapshot(shopOverride: any = null) {
    if (shopOverride) return buildActivityCenterSnapshot(shopOverride);
    if (pendingSnapshotRequest) return pendingSnapshotRequest;

    const request = buildActivityCenterSnapshot();
    pendingSnapshotRequest = request;
    request.then(() => {
        if (pendingSnapshotRequest === request) pendingSnapshotRequest = null;
    }, () => {
        if (pendingSnapshotRequest === request) pendingSnapshotRequest = null;
    });
    return request;
}

async function getRanchActivityDirectorySnapshot() {
    const body = types.ActivityListRequest.encode({ game_scene_id: 2 }).finish();
    const response = await sendMsgAsync('gamepb.activitypb.ActivityService', 'List', body);
    const reply = types.ActivityListReply.decode(response.body);
    // all_activities 是两边共用的时间目录；牧场只展示场景 2 实际下发的活动组。
    const windows = reply.activities.flatMap((group: any) => [group, ...group.children]).map((entry: any) => ({
        id: String(entry.activity.activity_id), name: entry.activity.name,
        beginTime: int64Number(entry.activity.begin_time), endTime: int64Number(entry.activity.end_time),
    }));
    return { serverTime: getServerTimeSec(), activities: buildActivityDirectory(windows, null, null, null, null) };
}

async function getActivityDirectorySnapshot() {
    const activityWindows = await getActivityWindows();
    return {
        serverTime: getServerTimeSec(),
        activities: buildActivityDirectory(activityWindows, null, null, null, null, null, null, null),
    };
}

const petDiaryService = createPetDiaryService({
    types, sendMsgAsync, getBag, getBagItems, getServerTimeSec, itemDto,
    int64String, int64Number, textContent, businessError, positiveDecimal,
    serializeMutation, getCurrentSolarTerms,
});

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
}

module.exports = {
    getPetDiary: petDiaryService.getPetDiary,
    operatePetDiary: petDiaryService.operatePetDiary,
    getPetDiaryRecords: petDiaryService.getPetDiaryRecords,
    getPetDiaryFriend: petDiaryService.getPetDiaryFriend,
    charityRedFlowerDto,
    reconcileCharityProgressState,
    buildActivityDirectory,
    getActivityDirectorySnapshot,
    getRanchActivityDirectorySnapshot,
    getActivityCenterSnapshot,
    getCurrentSeasonEvent,
    getCurrentStellarActivity,
    getCurrentStarSandShop,
    getCurrentSolarTerms,
    getCurrentQixiActivity,
    getCurrentCharityRedFlowerActivity,
    getCurrentWeatherActivity: weatherActivityService.getCurrentWeatherActivity,
    getWeatherFriends: weatherActivityService.getWeatherFriends,
    buyWeatherBottle: weatherActivityService.exchangeWeatherCollectorBottle,
    collectWeatherBottle: weatherActivityService.useWeatherCollectorBottle,
    lightWeatherResearch: weatherActivityService.advanceWeatherResearch,
    summonWeatherRain: weatherActivityService.useWeatherSummonBottle,
    exchangeWeatherCollectorBottle: weatherActivityService.exchangeWeatherCollectorBottle,
    scanWeatherFriends: weatherActivityService.scanWeatherFriends,
    useWeatherCollectorBottle: weatherActivityService.useWeatherCollectorBottle,
    useWeatherSummonBottle: weatherActivityService.useWeatherSummonBottle,
    useWeatherFrogBottle: weatherActivityService.useWeatherFrogBottle,
    useWeatherCloudBottle: weatherActivityService.useWeatherCloudBottle,
    advanceWeatherResearch: weatherActivityService.advanceWeatherResearch,
    claimBattlePassRewards,
    exchangeStarSandGoods,
    lightConstellation,
    claimSolarTerm,
    getCurrentQingMeiActivity,
    claimQingMeiDailySeed,
    startQingMeiBrew,
    continueQingMeiBrew,
    settleQingMeiBrew,
    claimQixiBridgeRewards,
    giftQixiSachet,
    claimCharityRedFlowerSeeds,
    donateCharityRedFlowerLove,
    claimCharityRedFlowerDailyGift,
    claimCharityRedFlowerProgressReward,
};
