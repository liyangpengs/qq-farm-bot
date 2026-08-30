export {};
/**
 * 赛季、游记与节令 - 协议查询、DTO 归一及领取操作。
 */

const { sendMsgAsync } = require('../../utils/network');
const { types } = require('../../utils/proto');
const {
    int64String,
    int64Number,
    itemDto,
    activityDto,
    bytesToText,
    textContent,
    parseJsonText,
    compareInt64,
} = require('./shared');

const SHOP_ACTIVITY_TYPE = '3';
const CONSTELLATION_ACTIVITY_TYPE = '13';

// snapshot 依赖本模块，写操作又要回传最新快照；延迟 require 打破循环依赖。
function getActivityCenterSnapshot(shopOverride: any = null) {
    return require('./snapshot').getActivityCenterSnapshot(shopOverride);
}

async function querySeason(): Promise<any> {
    const body = Buffer.from(types.GetSeasonInfoRequest.encode(types.GetSeasonInfoRequest.create({})).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.seasonpb.SeasonService', 'GetSeasonInfo', body);
    return types.GetSeasonInfoReply.decode(replyBody);
}

async function querySolarTerms(): Promise<any> {
    const body = Buffer.from(types.GetSolarTermsRequest.encode(types.GetSolarTermsRequest.create({})).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.solartermspb.SolarTermsService', 'GetSolarTerms', body);
    return types.GetSolarTermsReply.decode(replyBody);
}

function findSeasonActivity(seasonReply: any, typeCode: string): any | null {
    const activities = Array.isArray(seasonReply?.season_info?.activities) ? seasonReply.season_info.activities : [];
    return activities.find((activity: any) => int64String(activity?.type) === typeCode) || null;
}

function passDto(pass: any) {
    if (!pass) return null;
    const currentLevel = int64String(pass.current_level ?? pass.field_2);
    const progress = int64String(pass.current_progress ?? pass.field_4);
    const progressMax = int64String(pass.progress_target ?? pass.field_5);
    const claimedThroughLevel = int64String(pass.claimed_through_level ?? pass.field_9);
    const nodes = (Array.isArray(pass.nodes) ? pass.nodes : []).map((node: any) => {
        const level = int64String(node.node_id);
        const claimed = level !== '0' && compareInt64(level, claimedThroughLevel) <= 0;
        const locked = level === '0' || compareInt64(level, currentLevel) > 0;
        return {
            id: level,
            level,
            keyLevel: !!(node.is_key_level ?? node.field_4),
            locked,
            claimed,
            claimable: !locked && !claimed,
            current: level !== '0' && compareInt64(level, currentLevel) === 0,
            rewards: (Array.isArray(node.rewards) ? node.rewards : []).map(itemDto),
        };
    });
    return {
        activityId: int64String(pass.activity_id),
        title: bytesToText(pass.title),
        level: currentLevel,
        progress,
        progressMax,
        claimedThroughLevel,
        nodeCount: int64String(pass.node_count),
        field11Code: int64String(pass.field_11),
        field13Code: int64String(pass.field_13),
        field18Code: int64String(pass.field_18),
        field14Items: (Array.isArray(pass.field_14) ? pass.field_14 : []).map(itemDto),
        rules: textContent(pass.rules_json),
        nodes,
    };
}

function solarTermDto(term: any) {
    if (!term) return null;
    const statusCode = int64String(term.status);
    return {
        id: int64String(term.term_id),
        name: bytesToText(term.name),
        statusCode,
        canClaim: statusCode === '2',
        startTime: int64String(term.begin_time),
        endTime: int64String(term.end_time),
        rewards: (Array.isArray(term.rewards) ? term.rewards : []).map(itemDto),
    };
}

function normalizeSeason(reply: any) {
    const season = reply?.season_info;
    if (!season) throw new Error('当前赛季数据为空');
    const rawActivities = Array.isArray(season.activities) ? season.activities : [];
    const constellationActivity = findSeasonActivity(reply, CONSTELLATION_ACTIVITY_TYPE);
    const shopActivity = findSeasonActivity(reply, SHOP_ACTIVITY_TYPE);
    return {
        id: int64String(season.season_id),
        title: bytesToText(season.name),
        statusCode: int64String(season.status),
        field4Code: int64String(season.field_4),
        startTime: int64String(season.begin_time),
        endTime: int64String(season.end_time),
        serverTime: int64String(season.server_time),
        activities: rawActivities.map(activityDto),
        constellationActivity: constellationActivity ? activityDto(constellationActivity) : null,
        shopActivity: shopActivity ? activityDto(shopActivity) : null,
        pass: passDto(season.pass),
    };
}

function normalizeSolarTerms(reply: any) {
    const serverTime = int64Number(reply?.server_time);
    const terms = (Array.isArray(reply?.terms) ? reply.terms : []).map(solarTermDto).filter(Boolean);
    const currentTerm = terms.find((term: any) => {
        const start = Number(term.startTime);
        const end = Number(term.endTime);
        return serverTime > 0 && start <= serverTime && serverTime <= end;
    }) || null;
    const configs = Array.isArray(reply?.configs) ? reply.configs : [];
    return {
        serverTime: int64String(reply?.server_time),
        currentTermId: currentTerm?.id || null,
        terms,
        currentConfig: reply?.current_config ? {
            id: int64String(reply.current_config.config_id),
            activityId: int64String(reply.current_config.activity_id),
            rules: textContent(reply.current_config.rules_json),
            field4: parseJsonText(reply.current_config.field_4),
        } : null,
        configs: configs.map((config: any) => ({
            id: int64String(config.config_id),
            activityId: int64String(config.activity_id),
            rules: textContent(config.rules_json),
            field4: parseJsonText(config.field_4),
        })),
    };
}

async function claimBattlePassRewards() {
    const seasonReply = await querySeason();
    const pass = passDto(seasonReply?.season_info?.pass);
    if (!pass) throw new Error('服务端未发现可用游记');
    if (!pass.nodes.some((node: any) => node.claimable)) {
        throw new Error('当前没有可领取的游记奖励');
    }

    const body = Buffer.from(types.ClaimBattlePassRewardsRequest.encode(
        types.ClaimBattlePassRewardsRequest.create({})
    ).finish());
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.seasonpb.SeasonService',
        'ClaimBattlePassRewards',
        body
    );
    const reply = types.ClaimBattlePassRewardsReply.decode(replyBody);
    return {
        rewards: (Array.isArray(reply.rewards) ? reply.rewards : []).map(itemDto),
        field2Codes: (Array.isArray(reply.field_2) ? reply.field_2 : []).map(int64String),
        pass: passDto(reply.pass),
        snapshot: await getActivityCenterSnapshot(),
    };
}

async function claimSolarTerm(termId: string) {
    if (!/^[1-9]\d*$/.test(termId)) throw new Error('termId 必须是正十进制整数');
    const solarReply = await querySolarTerms();
    const term = (Array.isArray(solarReply?.terms) ? solarReply.terms : [])
        .find((entry: any) => int64String(entry?.term_id) === termId);
    if (!term) throw new Error('服务端未发现指定节令');
    if (int64String(term.status) !== '2') throw new Error('指定节令当前不可领取');

    const body = Buffer.from(types.ClaimSolarTermsRequest.encode(
        types.ClaimSolarTermsRequest.create({ term_id: term.term_id })
    ).finish());
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.solartermspb.SolarTermsService',
        'ClaimSolarTerms',
        body
    );
    const reply = types.ClaimSolarTermsReply.decode(replyBody);
    return {
        rewards: (Array.isArray(reply.rewards) ? reply.rewards : []).map(itemDto),
        term: solarTermDto(reply.term),
        snapshot: await getActivityCenterSnapshot(),
    };
}

module.exports = {
    SHOP_ACTIVITY_TYPE,
    CONSTELLATION_ACTIVITY_TYPE,
    querySeason,
    querySolarTerms,
    findSeasonActivity,
    passDto,
    solarTermDto,
    normalizeSeason,
    normalizeSolarTerms,
    claimBattlePassRewards,
    claimSolarTerm,
};
