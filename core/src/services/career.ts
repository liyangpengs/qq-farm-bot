export {};

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, logWarn } = require('../utils/utils');

export interface RanchCareerInfo {
    harvest: number;
    mature: number;
    steal: number;
    products: { id: number; count: number }[];
}

export interface CareerInfo {
    gid: number;
    harvest: number;
    steal: number;
    level: number;
    name: string;
    ranch: RanchCareerInfo | null;
}

async function getCareerInfo(gid: number): Promise<CareerInfo> {
    const numericGid: number = toNum(gid);
    if (!numericGid) throw new Error('缺少有效的角色 GID');

    const body: Uint8Array = types.CareerInfoGetRequest.encode(types.CareerInfoGetRequest.create({
        gid: toLong(numericGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.careerpb.CareerService', 'CareerInfoGet', body);
    const reply: any = types.CareerInfoGetReply.toObject(
        types.CareerInfoGetReply.decode(replyBody),
        { longs: Number, defaults: true },
    );

    const ranch = reply.ranch;
    return {
        gid: toNum(reply.gid) || numericGid,
        harvest: toNum(reply.total_harvest_count ?? reply.totalHarvestCount),
        steal: toNum(reply.total_steal_count ?? reply.totalStealCount),
        level: toNum(reply.level),
        name: String(reply.name || ''),
        ranch: ranch ? {
            harvest: toNum(ranch.total_harvest_count),
            mature: toNum(ranch.total_mature_count),
            steal: toNum(ranch.total_steal_count),
            products: ranch.harvest_items.map((item: any) => ({ id: toNum(item.item_id), count: toNum(item.harvest_count) })),
        } : null,
    };
}

async function getCareerInfoOrNull(gid: number, propagateErrors: boolean = false): Promise<CareerInfo | null> {
    try {
        return await getCareerInfo(gid);
    } catch (error: any) {
        if (propagateErrors) throw error;
        logWarn('生涯', `查询失败: ${error && error.message ? error.message : error}`);
        return null;
    }
}

module.exports = { getCareerInfo, getCareerInfoOrNull };
