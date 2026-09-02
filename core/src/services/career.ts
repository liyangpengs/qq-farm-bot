export {};

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, logWarn } = require('../utils/utils');

export interface CareerInfo {
    gid: number;
    harvest: number;
    steal: number;
    level: number;
    name: string;
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

    return {
        gid: toNum(reply.gid) || numericGid,
        harvest: toNum(reply.total_harvest_count ?? reply.totalHarvestCount),
        steal: toNum(reply.total_steal_count ?? reply.totalStealCount),
        level: toNum(reply.level),
        name: String(reply.name || ''),
    };
}

async function getCareerInfoOrNull(gid: number): Promise<CareerInfo | null> {
    try {
        return await getCareerInfo(gid);
    } catch (error: any) {
        logWarn('生涯', `查询失败: ${error && error.message ? error.message : error}`);
        return null;
    }
}

module.exports = { getCareerInfo, getCareerInfoOrNull };
