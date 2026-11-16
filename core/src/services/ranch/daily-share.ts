export {};

const network = require('../../utils/network');
const { rpc } = require('./transport');
const { itemDto, signature, error } = require('./model');

// 官方 Share 表：102 为牧场每日分享，奖励 80021:5，与农场的 1 独立。
const SHARE_ID = 102;
const DOC_ID = 2101;

function getState(): any {
    const info = network.getDailyShareInfo(SHARE_ID);
    return { ...info, canClaim: !info.claimed, shared: BigInt(info.shareCount) > 0n, rewards: [itemDto({ id: 80021, count: 5 })] };
}

async function prepare(): Promise<any> {
    const state = getState();
    if (!state.claimed && !state.shared && !(await rpc('checkShare')).can_share) throw error('RANCH_SHARE_UNAVAILABLE', '当前分享入口不可用');
    return state;
}

async function claim(): Promise<any> {
    if (!getState().shared) {
        const reply = await rpc('reportShare', { share_id: SHARE_ID, doc_id: DOC_ID }, true);
        network.applyShareInfos(reply.share_infos);
    }
    const state = getState();
    if (state.claimed) return { skipped: true, rewards: [] };
    if (!state.shared) throw error('RANCH_RESULT_UNKNOWN', '分享上报未能确认，请刷新核对，勿重复提交');
    const reply = await rpc('claimShare', { share_id: SHARE_ID }, true);
    network.applyShareInfos(reply.share_infos);
    if (!getState().claimed || signature(reply.rewards) !== signature(state.rewards)) throw error('RANCH_RESULT_UNKNOWN', '每日分享奖励回包未能确认，请刷新核对，勿重复提交');
    return { skipped: false, rewards: reply.rewards };
}

module.exports = { getState, prepare, claim };
