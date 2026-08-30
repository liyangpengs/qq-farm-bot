export {};
/**
 * 活动中心组合读视图 - 目录聚合、整体快照与单活动读取。
 */

const { getServerTimeSec } = require('../../utils/utils');
const { getActivityWindows } = require('../activity-windows');
const { buildActivityGameplayBindings, resolveActivityGameplays } = require('../activity-gameplay-registry');
const weatherActivityService = require('../weather-activity');
const { int64Number, settledValue, settledError, settleRequest } = require('./shared');
const { querySeason, querySolarTerms, normalizeSeason, normalizeSolarTerms } = require('./season');
const { queryShopFromSeason } = require('./shop');
const { buildConstellationFromSeason } = require('./constellation');
const { getCurrentQingMeiActivity } = require('./qingmei');
const { getCurrentQixiActivity } = require('./qixi');

type SettledEntry = PromiseSettledResult<any>;

let pendingSnapshotRequest: Promise<any> | null = null;

function buildActions(season: any, solarTerms: any, constellation: any = null, shop: any = null) {
    const hasPass = !!season?.pass;
    const claimablePassCount = hasPass
        ? season.pass.nodes.filter((node: any) => node.claimable).length
        : 0;
    const hasConstellation = !!season?.constellationActivity;
    const serverTime = int64Number(season?.serverTime);
    const constellationStartTime = int64Number(season?.constellationActivity?.startTime);
    const constellationEndTime = int64Number(season?.constellationActivity?.endTime);
    const constellationActive = hasConstellation
        && (serverTime <= 0 || constellationStartTime <= 0 || serverTime >= constellationStartTime)
        && (serverTime <= 0 || constellationEndTime <= 0 || serverTime <= constellationEndTime);
    const groups = Array.isArray(constellation?.groups) ? constellation.groups : [];
    const lightableGroups = groups.filter((group: any) => group.visualState === 'lightable');
    const attemptableGroups = groups.filter((group: any) => (
        group.visualState === 'lightable' || group.visualState === 'claimableUnknown'
    ));
    const currentGroups = groups.filter((group: any) => group.order === constellation?.currentDay);
    const availabilityKnown = lightableGroups.length > 0
        || (currentGroups.length > 0 && currentGroups.every((group: any) => group.stateKnown));
    const hasClaimableSolar = !!solarTerms?.terms?.some((term: any) => term.canClaim);
    return {
        claimPass: {
            supported: true,
            enabled: hasPass,
            available: claimablePassCount > 0,
            count: claimablePassCount,
        },
        lightConstellation: {
            supported: true,
            enabled: constellationActive && attemptableGroups.length > 0,
            available: lightableGroups.length > 0,
            attemptable: attemptableGroups.length > 0,
            availabilityKnown: !!constellation
                && constellation.catalogStatus === 'supported'
                && availabilityKnown,
            count: lightableGroups.length,
            attemptableCount: attemptableGroups.length,
        },
        claimSolar: { supported: true, enabled: hasClaimableSolar },
        exchange: {
            supported: true,
            enabled: !!shop?.action?.enabled,
            available: !!shop?.action?.available,
            availabilityKnown: !!shop,
            count: Number(shop?.action?.count) || 0,
            ...(!shop ? { reason: '活动商店目录当前不可用' } : shop.action?.reason ? { reason: shop.action.reason } : {}),
        },
    };
}

function buildActivityDirectory(windows: any[], season: any, shop: any, solarTerms: any, constellation: any, qixi: any = null, weather: any = null, qingMei: any = null) {
    const gameplayBindings = buildActivityGameplayBindings({ season, shop, solarTerms, constellation, qixi, weather, qingMei });
    const groups: any[] = [];
    for (const window of windows) {
        const id = String(window?.id || '').trim();
        if (!id) continue;
        const name = String(window?.name || '').trim() || `活动 ${id}`;
        const startTime = Number(window?.beginTime) || 0;
        const endTime = Number(window?.endTime) || 0;
        const group = groups.find((entry: any) => (
            entry.name === name
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
    const weatherResult = await settleRequest(weatherActivityService.getCurrentWeatherActivity);
    const rawSeason = settledValue(seasonResult);
    const season = rawSeason ? normalizeSeason(rawSeason) : null;
    const solarTerms = solarResult.status === 'fulfilled' ? normalizeSolarTerms(solarResult.value) : null;
    const qixi = settledValue(qixiResult);
    const qingMei = settledValue(qingMeiResult);
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
    const constellation = buildConstellationFromSeason(rawSeason);
    const actions = {
        ...buildActions(season, solarTerms, constellation, shop),
        qixiBridge: qixi?.actions?.bridge || { enabled: false, available: false, availabilityKnown: false },
        qixiGift: qixi?.actions?.gift || { enabled: false, available: false, availabilityKnown: false },
        qixiDew: qixi?.actions?.dew || { enabled: false, available: false, availabilityKnown: false },
        weatherResearch: weather?.actions?.advanceResearch || weather?.actions?.research || { enabled: false, available: false, availabilityKnown: false },
    };
    const activityWindows = settledValue(activityListResult) || [];
    return {
        serverTime: getServerTimeSec(),
        activities: buildActivityDirectory(activityWindows, season, shop, solarTerms, constellation, qixi, weather, qingMei),
        season,
        constellation,
        shop,
        solarTerms,
        qixi,
        qingMei,
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
            weatherResearch: !!weather,
        },
        actions,
        errors: {
            season: settledError(seasonResult),
            shop: settledError(shopResult),
            solarTerms: settledError(solarResult),
            qixi: settledError(qixiResult),
            qingMei: settledError(qingMeiResult),
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

async function getActivityDirectorySnapshot() {
    const activityWindows = await getActivityWindows();
    return {
        serverTime: getServerTimeSec(),
        activities: buildActivityDirectory(activityWindows, null, null, null, null, null, null, null),
    };
}

async function getCurrentSeasonEvent() {
    const seasonReply = await querySeason();
    const season = normalizeSeason(seasonReply);
    const constellation = buildConstellationFromSeason(seasonReply);
    const actions = buildActions(season, null, constellation);
    return { ...season, capabilities: { claimPass: true, lightConstellation: true }, actions };
}

async function getCurrentStarSandShop() {
    return queryShopFromSeason(await querySeason());
}

async function getCurrentSolarTerms() {
    const solarTerms = normalizeSolarTerms(await querySolarTerms());
    const actions = buildActions(null, solarTerms);
    return { ...solarTerms, capabilities: { claimSolar: true }, actions };
}

async function getCurrentStellarActivity() {
    const seasonReply = await querySeason();
    const season = normalizeSeason(seasonReply);
    const solarResult = await settleRequest(querySolarTerms);
    const shopResult = await settleRequest(() => queryShopFromSeason(seasonReply));
    const solarTerms = solarResult.status === 'fulfilled' ? normalizeSolarTerms(solarResult.value) : null;
    const shop = settledValue(shopResult);
    const constellation = buildConstellationFromSeason(seasonReply);
    const actions = buildActions(season, solarTerms, constellation, shop);
    return {
        serverTime: getServerTimeSec(),
        season,
        constellation,
        shop,
        solarTerms,
        capabilities: {
            claimPass: actions.claimPass.supported,
            lightConstellation: actions.lightConstellation.supported,
            claimSolar: actions.claimSolar.supported,
            exchange: actions.exchange.supported,
        },
        actions,
        errors: {
            solarTerms: settledError(solarResult),
            shop: settledError(shopResult),
        },
    };
}

module.exports = {
    buildActivityDirectory,
    buildActivityCenterSnapshot,
    getActivityCenterSnapshot,
    getActivityDirectorySnapshot,
    getCurrentSeasonEvent,
    getCurrentStarSandShop,
    getCurrentSolarTerms,
    getCurrentStellarActivity,
};
