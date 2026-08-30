/**
 * 星座观星 - 目录合并、状态归一与点亮写操作。
 */

import type Long from 'long';
import constellationCatalog from '../../activity-data/constellation-2026072701.json';

const { sendMsgAsync, GatewayError } = require('../../utils/network');
const { types } = require('../../utils/proto');
const {
    int64String,
    int64Number,
    itemDto,
    activityDto,
    bytesToText,
    parseJsonText,
} = require('./shared');
const { CONSTELLATION_ACTIVITY_TYPE, querySeason, findSeasonActivity } = require('./season');
const {
    mergeConstellationStates,
    stateRecordKey,
    loadConstellationState,
    persistConstellationState,
    stateFromDynamicNodes,
    stateWithNoClaimableDay,
} = require('../activity-center-state');

type Int64Like = Long | number | string | null | undefined;

const LIGHT_CONSTELLATION_OPERATE_TYPE = 21;
const SECONDS_PER_DAY = 86400;
const BEIJING_UTC_OFFSET_SECONDS = 8 * 60 * 60;

const lastConstellationState = new Map<string, any>();
const lastConstellationDynamicState = new Map<string, any>();

interface ConstellationStateIdentity {
    seasonId: string;
    activityId: string;
    catalogVersion: number;
}

// snapshot 依赖本模块，写操作又要回传最新快照；延迟 require 打破循环依赖。
function getActivityCenterSnapshot(shopOverride: any = null) {
    return require('./snapshot').getActivityCenterSnapshot(shopOverride);
}

function constellationDayFromBeijingMidnight(startTimeSec: number, serverTimeSec: number): number | null {
    if (startTimeSec <= 0 || serverTimeSec < startTimeSec) return null;
    const startDateIndex = Math.floor((startTimeSec + BEIJING_UTC_OFFSET_SECONDS) / SECONDS_PER_DAY);
    const serverDateIndex = Math.floor((serverTimeSec + BEIJING_UTC_OFFSET_SECONDS) / SECONDS_PER_DAY);
    return serverDateIndex - startDateIndex + 1;
}

function rawConstellationNode(node: any) {
    return {
        id: int64String(node?.node_id),
        field2: !!node?.field_2,
        field3: !!node?.field_3,
        field4: !!node?.field_4,
        rewards: (Array.isArray(node?.rewards) ? node.rewards : []).map(itemDto),
    };
}

function rawConstellationGroup(group: any) {
    return {
        id: int64String(group?.group_id),
        field2: !!group?.field_2,
        name: bytesToText(group?.name),
        links: parseJsonText(group?.links),
        config: parseJsonText(group?.config_json),
    };
}

function constellationStateIdentity(seasonReply: any, activity: any): ConstellationStateIdentity {
    return {
        seasonId: int64String(seasonReply?.season_info?.season_id),
        activityId: int64String(activity?.activity_id ?? activity?.id),
        catalogVersion: Number(constellationCatalog.catalogVersion) || 0,
    };
}

function loadMergedConstellationState(seasonReply: any, activity: any): any {
    const identity = constellationStateIdentity(seasonReply, activity);
    const memoryState = lastConstellationState.get(stateRecordKey(identity));
    return mergeConstellationStates(identity, loadConstellationState(identity), memoryState);
}

function constellationDto(activity: any, serverTimeValue: Int64Like, data?: any, confirmedState?: any) {
    const activityId = int64String(activity?.activity_id ?? activity?.id);
    const catalogSupported = activityId === String(constellationCatalog.activityId);
    const startTime = int64String(activity?.begin_time ?? activity?.startTime);
    const endTime = int64String(activity?.end_time ?? activity?.endTime);
    const serverTime = int64String(serverTimeValue);
    const activityMetadata = activityDto(activity);

    if (!catalogSupported) {
        return {
            activityId,
            typeCode: int64String(activity?.type ?? activity?.typeCode),
            displayName: activityMetadata.name,
            serverName: activityMetadata.name,
            startTime,
            endTime,
            serverTime,
            catalogVersion: null,
            catalogStatus: 'unsupported' as const,
            rules: null,
            currentDay: null,
            groups: [],
        };
    }

    const start = int64Number(startTime);
    const server = int64Number(serverTime);
    const calculatedDay = constellationDayFromBeijingMidnight(start, server);
    const currentDay = calculatedDay == null ? null : Math.max(1, Math.min(28, calculatedDay));
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const dynamicNodes = new Map<string, any>(nodes.map((node: any) => [int64String(node?.node_id), node]));
    const dynamicGroups = new Map<string, any>((Array.isArray(data?.groups) ? data.groups : [])
        .map((group: any) => [int64String(group?.group_id), group]));
    const confirmedOpenedNodeIds = new Set<string>(confirmedState?.confirmedOpenedNodeIds || []);
    const confirmedLitNodeIds = new Set<string>(confirmedState?.confirmedLitNodeIds || []);
    const noClaimableDays = confirmedState?.noClaimableDays || {};

    const groups = constellationCatalog.groups.map(group => {
        const id = String(group.id);
        const nodeId = String(group.nodeId);
        const dynamicNode = dynamicNodes.get(nodeId);
        const dynamicGroup = dynamicGroups.get(id);
        const confirmedOpened = confirmedOpenedNodeIds.has(nodeId);
        const confirmedLit = confirmedLitNodeIds.has(nodeId);
        const dynamicOpened = dynamicNode?.field_2 === true;
        const dynamicLit = dynamicNode?.field_3 === true;
        const dynamicLightable = dynamicOpened && dynamicNode?.field_3 === false;
        const noClaimable = currentDay === group.order && !!noClaimableDays[String(group.order)];
        let opened: boolean | null;
        let lit: boolean | null;
        let stateKnown: boolean;
        let visualState: 'lit' | 'lightable' | 'locked' | 'unknown' | 'claimableUnknown';
        let claimStatus: 'confirmed-no-claimable' | null = null;
        let statusSource: 'persisted' | 'authoritative' | 'server-rejection' | 'schedule';

        // field_2=已开放，field_3=已点亮；field_4 不参与状态判定。
        if (confirmedLit || dynamicLit || noClaimable) {
            opened = true;
            lit = true;
            stateKnown = true;
            visualState = 'lit';
            claimStatus = noClaimable ? 'confirmed-no-claimable' : null;
            statusSource = noClaimable ? 'server-rejection' : confirmedLit ? 'persisted' : 'authoritative';
        } else if (dynamicLightable) {
            opened = true;
            lit = false;
            stateKnown = true;
            visualState = 'lightable';
            statusSource = 'authoritative';
        } else if (currentDay != null && group.order > currentDay) {
            opened = false;
            lit = false;
            stateKnown = false;
            visualState = 'locked';
            statusSource = 'schedule';
        } else if (currentDay != null && group.order === currentDay) {
            opened = confirmedOpened || dynamicOpened ? true : null;
            lit = null;
            stateKnown = false;
            visualState = 'claimableUnknown';
            statusSource = confirmedOpened ? 'persisted' : dynamicOpened ? 'authoritative' : 'schedule';
        } else {
            opened = confirmedOpened || dynamicOpened ? true : null;
            lit = null;
            stateKnown = false;
            visualState = 'unknown';
            statusSource = confirmedOpened ? 'persisted' : dynamicOpened ? 'authoritative' : 'schedule';
        }

        return {
            id,
            nodeId,
            name: group.name,
            category: group.category,
            explain: group.explain,
            order: group.order,
            chartIndex: group.links.chartIndex,
            rewards: group.rewards.map(itemDto),
            linksRaw: group.linksRaw,
            nodeIds: group.links.nodeIds.map(String),
            visualState,
            opened,
            lit,
            stateKnown,
            claimStatus,
            statusSource,
            ...(dynamicNode || dynamicGroup ? {
                raw: {
                    node: dynamicNode ? rawConstellationNode(dynamicNode) : null,
                    group: dynamicGroup ? rawConstellationGroup(dynamicGroup) : null,
                },
            } : {}),
        };
    });

    return {
        activityId,
        typeCode: CONSTELLATION_ACTIVITY_TYPE,
        displayName: constellationCatalog.displayName,
        serverName: activityMetadata.name || constellationCatalog.serverName,
        startTime,
        endTime,
        serverTime,
        catalogVersion: constellationCatalog.catalogVersion,
        catalogStatus: 'supported' as const,
        rules: constellationCatalog.rules,
        currentDay,
        groups,
        ...(data ? {
            raw: {
                field1Code: int64String(data.field_1),
                field2Code: int64String(data.field_2),
                field3Code: int64String(data.field_3),
            },
        } : {}),
    };
}

/** 三处组合读视图共用同一段状态合并逻辑，集中在此避免重复。 */
function buildConstellationFromSeason(seasonReply: any): any | null {
    const activity = findSeasonActivity(seasonReply, CONSTELLATION_ACTIVITY_TYPE);
    if (!activity) return null;
    const identity = constellationStateIdentity(seasonReply, activity);
    return constellationDto(
        activity,
        seasonReply?.season_info?.server_time,
        lastConstellationDynamicState.get(stateRecordKey(identity)),
        loadMergedConstellationState(seasonReply, activity),
    );
}

async function lightConstellation() {
    const seasonReply = await querySeason();
    const activity = findSeasonActivity(seasonReply, CONSTELLATION_ACTIVITY_TYPE);
    if (!activity) throw new Error('服务端未发现星座活动');

    const identity = constellationStateIdentity(seasonReply, activity);
    const stateKey = stateRecordKey(identity);
    const serverTime = int64String(seasonReply?.season_info?.server_time);
    const startTime = int64Number(activity.begin_time);
    const serverTimeNumber = int64Number(serverTime);
    const currentDay = constellationDayFromBeijingMidnight(startTime, serverTimeNumber) ?? 0;
    const activityEndTime = int64Number(activity.end_time);
    const activityActive = serverTimeNumber > 0
        && startTime > 0
        && serverTimeNumber >= startTime
        && (activityEndTime <= 0 || serverTimeNumber <= activityEndTime);
    const request = types.OperateConstellationRequest.create({
        activity_id: activity.activity_id,
        operate_type: LIGHT_CONSTELLATION_OPERATE_TYPE,
        field_119: {},
    });
    const body = Buffer.from(types.OperateConstellationRequest.encode(request).finish());
    let replyBody: Buffer;
    try {
        ({ body: replyBody } = await sendMsgAsync(
            'gamepb.activitypb.ActivityService',
            'Operate',
            body,
            { expectedErrorCodes: [1034038] }
        ));
    } catch (error: any) {
        if (!(error instanceof GatewayError)
            || error.code !== 1034038
            || !activityActive
            || currentDay < 1
            || currentDay > 28) {
            throw error;
        }

        const rejectionState = stateWithNoClaimableDay(identity, currentDay, serverTime);
        const mergedState = mergeConstellationStates(
            identity,
            loadMergedConstellationState(seasonReply, activity),
            rejectionState
        );
        lastConstellationState.set(stateKey, mergedState);
        let persistenceWarning: string | undefined;
        try {
            lastConstellationState.set(stateKey, persistConstellationState(mergedState, identity));
        } catch (persistenceError: any) {
            persistenceWarning = String(persistenceError?.message || persistenceError || '观星状态持久化失败');
        }
        const snapshot = await getActivityCenterSnapshot();
        return {
            outcome: 'nothingToClaim' as const,
            noClaimable: true,
            message: '今日星宿奖励已经领取，无需重复操作',
            snapshot,
            ...(persistenceWarning ? { persistenceWarning } : {}),
        };
    }

    const reply = types.ActivityOperateReply.decode(replyBody!);
    if (int64String(reply.activity_id) !== identity.activityId) {
        throw new Error('星座操作返回了不匹配的活动 ID');
    }
    if (int64String(reply.operate_type) !== String(LIGHT_CONSTELLATION_OPERATE_TYPE)) {
        throw new Error(`星座操作返回了未知操作类型: ${int64String(reply.operate_type)}`);
    }
    const constellationState = reply.data?.constellation;
    if (!constellationState) throw new Error('星座操作成功但回包缺少动态状态');

    // 回包 field_2/field_3 的 true 单调并入内存与持久状态；false 不覆盖既有确认。
    lastConstellationDynamicState.set(stateKey, constellationState);
    const mergedState = mergeConstellationStates(
        identity,
        loadMergedConstellationState(seasonReply, activity),
        stateFromDynamicNodes(identity, constellationState.nodes)
    );
    lastConstellationState.set(stateKey, mergedState);
    let persistenceWarning: string | undefined;
    try {
        lastConstellationState.set(stateKey, persistConstellationState(mergedState, identity));
    } catch (persistenceError: any) {
        persistenceWarning = String(persistenceError?.message || persistenceError || '观星状态持久化失败');
    }
    const snapshot = await getActivityCenterSnapshot();
    return {
        outcome: 'lighted' as const,
        rewards: [],
        activity: reply.data?.activity ? activityDto(reply.data.activity) : activityDto(activity),
        constellation: snapshot.constellation,
        snapshot,
        ...(persistenceWarning ? { persistenceWarning } : {}),
    };
}

module.exports = {
    constellationDto,
    buildConstellationFromSeason,
    lightConstellation,
};
