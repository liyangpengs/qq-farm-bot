export {};

/**
 * 牧歌初启的可领奖励自动领取（claim-only，不花钱、不答题）。
 *
 * 复用 muge-activity 的 Operate 链路（账号串行 mutation、回包核对）：
 * 每个操作内部会重新拉活动状态，status=2 才会真正提交（与面板按钮同一判据），
 * 没有可领档时面板语义是抛 MUGE_NOT_CLAIMABLE，这里按静默跳过处理。
 * 活动结束（MUGE_ENDED）后本轮起不再查询；回包无法确认的错误只延长复查间隔，不自动重发。
 */

const { getAutomation } = require('../../models/store');
const { log } = require('../../utils/utils');
const muge = require('../muge-activity');

const RETRY_MS = 30 * 60 * 1000;

const ACTIONS: Array<[string, string]> = [
    ['claimTask', '手账任务'],
    ['claimHandbook', '手账档位'],
    ['claimFriends', '好友邀请档'],
    ['claimCelebration', '全服庆典档'],
];

interface MugeRoutineState {
    done: boolean;          // 活动结束或数据不可用，本轮起不再查
    lastAt: number;
    nextCheckAt: number;
    claimed: number;
    lastError: string;
}

function emptyState(): MugeRoutineState {
    return { done: false, lastAt: 0, nextCheckAt: 0, claimed: 0, lastError: '' };
}

let state: MugeRoutineState = emptyState();

function getMugeRoutineState(): MugeRoutineState {
    return state;
}

function mugeDue(): boolean {
    return !state.done && Date.now() >= (state.nextCheckAt || 0);
}

function rewardText(rewards: any[]): string {
    return (rewards || []).map((item: any) => `${item.name} ×${item.count}`).join('、');
}

async function claimMuge(): Promise<void> {
    if (state.done || !getAutomation().ranch_muge) return;
    const now = Date.now();
    try {
        const mugeState: any = await muge.getMugeActivity();
        if (!mugeState.active) {
            state = { ...state, done: true, lastAt: now };
            return;
        }
    } catch (error: any) {
        state = { ...emptyState(), lastAt: now, nextCheckAt: now + RETRY_MS, lastError: String(error?.message || error) };
        log('牧场', `牧歌初启状态查询失败：${state.lastError}`, { module: 'ranch', event: 'ranch_muge', result: 'error' });
        return;
    }

    let claimed = 0;
    const claimedNames: string[] = [];
    let hardError = '';
    for (const [action, label] of ACTIONS) {
        if (hardError) break;
        try {
            const outcome: any = await muge.operateMugeActivity(action);
            const rewards = outcome?.rewards || [];
            if (rewards.length) {
                claimed++;
                claimedNames.push(`${label}：${rewardText(rewards)}`);
            }
        } catch (error: any) {
            const code = String(error?.code || '');
            if (code === 'MUGE_NOT_CLAIMABLE') continue;   // 该区块暂无可领，正常
            if (code === 'MUGE_ENDED') {
                state = { ...state, done: true, lastAt: now };
                return;
            }
            // 回包无法确认或网络错误：本轮停止，等下一轮复查，不自动重发
            hardError = `${label}：${String(error?.message || error)}`;
        }
    }

    if (hardError) {
        state = { ...state, lastAt: now, nextCheckAt: now + RETRY_MS, claimed: state.claimed, lastError: hardError };
        log('牧场', `牧歌初启自动领取中断：${hardError}`, { module: 'ranch', event: 'ranch_muge', result: 'error' });
        return;
    }

    state = { ...state, lastAt: now, nextCheckAt: now + RETRY_MS, claimed: state.claimed + claimed, lastError: '' };
    if (claimed > 0) {
        log('牧场', `牧歌初启自动领取 ${claimed} 项：${claimedNames.join('；')}`, { module: 'ranch', event: 'ranch_muge', result: 'ok' });
    }
}

module.exports = { getMugeRoutineState, mugeDue, claimMuge };
