export {};
const { getFruitName, getPlantByFruitId, getPlantById, getPlantName } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { logWarn, toNum, toTimeSec } = require('../utils/utils');

const RPC_CANDIDATES: Array<[string, string]> = [
    ['gamepb.interactpb.InteractService', 'InteractRecords'],
    ['gamepb.interactpb.InteractService', 'GetInteractRecords'],
    ['gamepb.interactpb.VisitorService', 'InteractRecords'],
    ['gamepb.interactpb.VisitorService', 'GetInteractRecords'],
];
let preferredRpcCandidate: [string, string] | null = null;
const interactRecordRequests: Partial<Record<'low' | 'normal', Promise<any[]>>> = {};

const ACTION_LABELS: Record<number, string> = {
    1: '偷取作物',
    2: '帮忙',
    3: '捣乱',
};

function getActionLabel(actionType: number): string {
    return ACTION_LABELS[actionType] || '互动';
}

function buildActionDetail(record: any): string {
    const count: number = Number(record.cropCount) || 0;
    const times: number = Number(record.times) || 0;
    const landId: number = Number(record.landId) || 0;
    const parts: string[] = [];

    if (record.actionType === 1) {
        if (record.cropName && count > 0) parts.push(`偷取 ${record.cropName} × ${count}`);
        else if (record.cropName) parts.push(`偷取 ${record.cropName}`);
        else if (count > 0) parts.push(`偷取作物 × ${count}`);
        else parts.push('偷取作物');
    } else if (record.actionType === 2) {
        parts.push(times > 1 ? `帮忙 ${times} 次` : '帮忙');
    } else if (record.actionType === 3) {
        parts.push(times > 1 ? `捣乱 ${times} 次` : '捣乱');
    } else {
        parts.push(times > 1 ? `互动 ${times} 次` : '互动');
    }

    if (landId > 0) parts.push(`地块 ${landId}`);
    return parts.join(' · ');
}

async function fetchInteractReply(priority: 'low' | 'normal' = 'normal'): Promise<any> {
    if (!types.InteractRecordsRequest || !types.InteractRecordsReply) {
        throw new Error('访客记录 proto 未加载');
    }

    const body: Uint8Array = types.InteractRecordsRequest.encode(types.InteractRecordsRequest.create({})).finish();
    const errors: string[] = [];

    const candidates = preferredRpcCandidate
        ? [preferredRpcCandidate, ...RPC_CANDIDATES.filter(candidate => candidate !== preferredRpcCandidate)]
        : RPC_CANDIDATES;
    for (const candidate of candidates) {
        const [serviceName, methodName] = candidate;
        try {
            const { body: replyBody } = await sendMsgAsync(serviceName, methodName, body, { timeoutMs: 2500, priority });
            preferredRpcCandidate = candidate;
            return types.InteractRecordsReply.decode(replyBody);
        } catch (error: any) {
            const message: string = error && error.message ? error.message : String(error || 'unknown');
            errors.push(`${serviceName}.${methodName}: ${message}`);
            // 只有服务端明确拒绝当前 RPC 名称时才探测下一个候选；超时/断线不再连续制造请求。
            if (!error || error.name !== 'GatewayError') throw error;
        }
    }

    logWarn('好友', `访客记录接口调用失败: ${errors.join(' | ')}`, {
        module: 'friend',
        event: 'interact_records',
        result: 'error',
    });
    throw new Error('访客记录接口调用失败，请确认服务名和方法名是否与当前版本一致');
}

function resolveCropName(cropId: number): string {
    const id: number = Number(cropId) || 0;
    if (id <= 0) return '';
    if (getPlantById(id)) return getPlantName(id);
    if (getPlantByFruitId(id)) return getFruitName(id);
    return '';
}

function normalizeInteractRecord(record: any, index: number): any {
    const actionType: number = toNum(record && record.action_type);
    const visitorGid: number = toNum(record && record.visitor_gid);
    const cropId: number = toNum(record && record.crop_id);
    const cropCount: number = toNum(record && record.crop_count);
    const times: number = toNum(record && record.times);
    const level: number = toNum(record && record.level);
    const fromType: number = toNum(record && record.from_type);
    const serverTimeSec: number = toTimeSec(record && record.server_time);
    const extra: any = (record && record.extra) || {};
    const landId: number = toNum(extra.land_id);
    const flag1: number = toNum(extra.flag1);
    const flag2: number = toNum(extra.flag2);
    const cropName: string = resolveCropName(cropId);
    const nick: string = String((record && record.nick) || '').trim() || `GID:${visitorGid}`;
    const avatarUrl: string = String((record && record.avatar_url) || '').trim();

    const normalized: any = {
        key: `${serverTimeSec || 0}-${visitorGid || 0}-${actionType || 0}-${index}`,
        serverTimeSec,
        serverTimeMs: serverTimeSec > 0 ? serverTimeSec * 1000 : 0,
        actionType,
        actionLabel: getActionLabel(actionType),
        visitorGid,
        nick,
        avatarUrl,
        cropId,
        cropName,
        cropCount,
        times,
        fromType,
        level,
        landId,
        flag1,
        flag2,
    };

    normalized.actionDetail = buildActionDetail(normalized);
    return normalized;
}

async function fetchInteractRecords(priority: 'low' | 'normal'): Promise<any[]> {
    const reply: any = await fetchInteractReply(priority);
    const records: any[] = Array.isArray(reply && reply.records) ? reply.records : [];
    return records
        .map((record: any, index: number) => normalizeInteractRecord(record, index))
        .sort((a: any, b: any) => (b.serverTimeSec - a.serverTimeSec) || (b.visitorGid - a.visitorGid) || (b.actionType - a.actionType));
}

async function getInteractRecords(priority: 'low' | 'normal' = 'normal'): Promise<any[]> {
    if (priority === 'low' && interactRecordRequests.normal) return interactRecordRequests.normal;
    const current = interactRecordRequests[priority];
    if (current) return current;

    const request = fetchInteractRecords(priority);
    interactRecordRequests[priority] = request;
    try {
        return await request;
    } finally {
        if (interactRecordRequests[priority] === request) delete interactRecordRequests[priority];
    }
}

async function getInteractInfo(): Promise<any> {
    const body: Uint8Array = types.GetInteractInfoRequest.encode(types.GetInteractInfoRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.interactpb.InteractService', 'GetInteractInfo', body);
    return types.GetInteractInfoReply.decode(replyBody);
}

async function getInteractSummary(): Promise<any> {
    const body: Uint8Array = types.GetInteractSummaryRequest.encode(types.GetInteractSummaryRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.interactpb.InteractService', 'GetInteractSummary', body);
    return types.GetInteractSummaryReply.decode(replyBody);
}

module.exports = {
    getInteractRecords,
    getInteractInfo,
    getInteractSummary,
};
