"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 随机掉落活动服务 - 获取活动信息和奖励
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');
async function getActivityInfo() {
    const body = types.RandomDropGetActivityInfoRequest.encode(types.RandomDropGetActivityInfoRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.randomdroppb.RandomDropService', 'GetActivityInfo', body);
    return types.RandomDropGetActivityInfoReply.decode(replyBody);
}
function getRewardSummary(items) {
    const list = Array.isArray(items) ? items : [];
    const summary = [];
    for (const it of list) {
        const id = toNum(it.id);
        const count = toNum(it.count);
        if (count <= 0)
            continue;
        if (id === 1 || id === 1001)
            summary.push(`金币${count}`);
        else if (id === 2 || id === 1101)
            summary.push(`经验${count}`);
        else if (id === 1002)
            summary.push(`点券${count}`);
        else
            summary.push(`物品#${id}x${count}`);
    }
    return summary.join('/');
}
module.exports = {
    getActivityInfo,
};
//# sourceMappingURL=randomdrop.js.map