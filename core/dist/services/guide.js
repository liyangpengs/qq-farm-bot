"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 引导/新手任务服务 - 完成引导节点、领取奖励
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');
async function setWeakGuideNodeComplete(nodeId) {
    const body = types.SetWeakGuideNodeCompleteRequest.encode(types.SetWeakGuideNodeCompleteRequest.create({
        node_id: Number(nodeId) || 0,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.guidepb.GuideService', 'SetWeakGuideNodeComplete', body);
    return types.SetWeakGuideNodeCompleteReply.decode(replyBody);
}
async function claimWeakGuideReward(nodeId) {
    const body = types.ClaimWeakGuideRewardRequest.encode(types.ClaimWeakGuideRewardRequest.create({
        node_id: Number(nodeId) || 0,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.guidepb.GuideService', 'ClaimWeakGuideReward', body);
    return types.ClaimWeakGuideRewardReply.decode(replyBody);
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
async function claimGuideRewards() {
    try {
        // 尝试领取引导奖励 (nodeId=0 通常是通用奖励)
        const reply = await claimWeakGuideReward(0);
        const items = reply.items || [];
        if (items.length > 0) {
            const rewardStr = getRewardSummary(items);
            log('引导', rewardStr ? `领取引导奖励 → ${rewardStr}` : '领取引导奖励成功');
            return { claimed: 1, rewardItems: items.length };
        }
        return { claimed: 0, rewardItems: 0 };
    }
    catch (e) {
        log('引导', `领取引导奖励失败: ${e.message}`);
        return { claimed: 0, rewardItems: 0 };
    }
}
module.exports = {
    setWeakGuideNodeComplete,
    claimWeakGuideReward,
    claimGuideRewards,
};
//# sourceMappingURL=guide.js.map