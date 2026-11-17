import config from '../activity-data/muge-20261117.json';

export {};

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, toNum } = require('../utils/utils');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { util } = require('protobufjs');

const GROUP_ID = '2026111700';
const IDS = { celebration: '2026111702', friends: '2026111703', handbook: '2026111704', personality: '2026111705' };
const OPERATIONS = {
    claimCelebration: { id: IDS.celebration, cmd: 85, field: 'global_count_claim_tier' },
    claimFriends: { id: IDS.friends, cmd: 84, field: 'invite_friend_tier_claim' },
    claimTask: { id: IDS.handbook, cmd: 82, field: 'task_claim' },
    claimHandbook: { id: IDS.handbook, cmd: 83, field: 'task_tier_claim' },
    saveAnswers: { id: IDS.personality, cmd: 86, field: 'survey_save_progress' },
    settle: { id: IDS.personality, cmd: 87, field: 'survey_settle' },
    claimShare: { id: IDS.personality, cmd: 89, field: 'survey_claim_share_reward' },
} as const;
let mutationTail: Promise<any> = Promise.resolve();

function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}

function itemDto(item: any): any {
    const id = toNum(item.id);
    return { id, count: toNum(item.count), name: getItemById(id)?.name || `物品 #${id}`, image: getItemImageById(id) };
}

function tierDto(tier: any): any {
    return { id: String(tier.tier_id), threshold: toNum(tier.threshold), status: tier.status, rewards: tier.reward.map(itemDto) };
}

function answersDto(answers: Record<string, any>): Record<string, number> {
    return Object.fromEntries(Object.entries(answers).map(([key, value]) => [
        /^\d+$/.test(key) ? key : util.longFromHash(key).toString(), toNum(value),
    ]));
}

async function getMugeActivity() {
    const body = types.ActivityListRequest.encode({ game_scene_id: 1 }).finish();
    const response = await sendMsgAsync('gamepb.activitypb.ActivityService', 'List', body);
    const group = types.MugeListReply.decode(response.body).groups.find((group: any) => String(group.head?.id) === GROUP_ID);
    if (String(group?.head?.id) !== GROUP_ID) fail('MUGE_UNAVAILABLE', '牧歌初启活动数据暂不可用');
    const find = (id: string) => group.children.find((entry: any) => String(entry.head?.id) === id);
    const celebration = find(IDS.celebration)?.global_count;
    const friends = find(IDS.friends)?.invite_friend;
    const handbook = find(IDS.handbook)?.task;
    const personality = find(IDS.personality)?.survey;
    const now = getServerTimeSec() * 1000;
    const startTime = toNum(group.head.start_time) * 1000;
    const endTime = toNum(group.head.end_time) * 1000;
    const active = group.head.status === 1 && now >= startTime && now < endTime;
    const personalityId = toNum(personality?.personality_id);
    return {
        activityId: GROUP_ID, title: '牧歌初启', serverTime: now, startTime, endTime, active,
        rules: String(group.head.desc || '').split(/\r?\n/).filter(Boolean),
        celebration: celebration ? { total: toNum(celebration.total), tiers: celebration.tiers.map(tierDto) } : null,
        friends: friends ? { count: friends.counted_friends.length, tiers: friends.tiers.map(tierDto) } : null,
        handbook: handbook ? {
            points: toNum(handbook.tier_points), tiers: handbook.tiers.map(tierDto),
            tasks: handbook.tasks.map((task: any) => ({ id: String(task.task_id), description: task.desc, progress: toNum(task.progress), target: toNum(task.target), status: task.status, unlockDay: toNum(task.unlock_day), points: config.tasks.find(v => v.id === toNum(task.task_id))?.points || 0, rewards: task.reward.map(itemDto) })),
        } : null,
        personality: personality ? {
            answers: answersDto(personality.answers), personalityId, settleCount: toNum(personality.settle_count),
            image: config.results.find(v => v.id === personalityId)?.image || '',
            shareRewardClaimed: personality.share_reward_claimed,
        } : null,
        questions: config.questions,
    };
}

async function perform(action: string, input: any) {
    const operation = Object.hasOwn(OPERATIONS, action) ? OPERATIONS[action as keyof typeof OPERATIONS] : null;
    if (!operation) fail('INVALID_MUGE_ACTION', '未知的牧歌初启操作');
    const state = await getMugeActivity();
    if (!state.active) fail('MUGE_ENDED', '牧歌初启尚未开始或已经结束');
    let params: any = {};
    if (action === 'claimCelebration' || action === 'claimFriends' || action === 'claimHandbook') {
        const section = action === 'claimCelebration' ? state.celebration : action === 'claimFriends' ? state.friends : state.handbook;
        if (!section?.tiers.some((tier: any) => tier.status === 2)) fail('MUGE_NOT_CLAIMABLE', '当前没有可领取的档位奖励');
        params = { tier_id: 0 };
    } else if (action === 'claimTask') {
        if (!state.handbook?.tasks.some((task: any) => task.status === 2)) fail('MUGE_NOT_CLAIMABLE', '任务未完成或奖励已领取');
        params = { task_id: 0 };
    } else {
        if (!state.personality) fail('MUGE_UNAVAILABLE', '牧场人格数据暂不可用');
        if (action === 'saveAnswers') {
            if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) fail('INVALID_MUGE_ANSWERS', '请选择题目答案');
            if (input.clear !== undefined && typeof input.clear !== 'boolean') fail('INVALID_MUGE_ANSWERS', '重答标记无效');
            if (input.clear === true && Object.keys(input.answers).length) fail('INVALID_MUGE_ANSWERS', '清空进度和保存答案需要分开提交，请刷新页面重新测试');
            if (input.clear !== true && !Object.keys(input.answers).length) fail('INVALID_MUGE_ANSWERS', '请选择题目答案');
            for (const [questionId, value] of Object.entries(input.answers)) {
                const question = config.questions.find(v => String(v.id) === questionId);
                if (!question?.options.some(option => option.value === value)) fail('INVALID_MUGE_ANSWERS', '题目或答案无效');
            }
            params = { answers: input.answers, clear: input.clear === true };
        } else if (action === 'settle') {
            if (!config.questions.every(q => q.options.some(o => o.value === state.personality.answers[String(q.id)]))) fail('MUGE_ANSWERS_INCOMPLETE', '请先完成全部题目');
        } else if (!state.personality.personalityId || state.personality.shareRewardClaimed) {
            fail('MUGE_NOT_CLAIMABLE', '请先完成人格测试，首次分享奖励仅可领取一次');
        }
    }
    const body = types.MugeOperateRequest.encode({ id: operation.id, cmd: operation.cmd, [operation.field]: params }).finish();
    const response = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    const reply = types.MugeOperateReply.decode(response.body);
    if (String(reply.id) !== operation.id || toNum(reply.cmd) !== operation.cmd || !reply[operation.field] || String(reply.activity?.head?.id) !== operation.id) {
        fail('MUGE_RESULT_UNKNOWN', '操作回包未能确认，请刷新核对，勿重复提交');
    }
    const result = reply[operation.field];
    if ((['claimTask', 'claimHandbook', 'claimCelebration', 'claimFriends'].includes(action) && !result.claimed_ids.length)
        || (action === 'claimShare' && !reply.activity.survey?.share_reward_claimed)
        || (action === 'settle' && toNum(reply.activity.survey?.personality_id) <= 0)
        || (action === 'saveAnswers' && (!reply.activity.survey || (params.clear
            ? Object.values(answersDto(reply.activity.survey.answers)).some(value => value > 0)
            : !Object.entries(input.answers).every(([key, value]) => answersDto(reply.activity.survey.answers)[key] === value))))) {
        fail('MUGE_RESULT_UNKNOWN', '操作状态未能确认，请刷新核对，勿重复提交');
    }
    const rewards = (result.awards || []).map(itemDto);
    try { return { activity: await getMugeActivity(), rewards }; }
    catch { return { activity: null, rewards, refreshRequired: true }; }
}

function operateMugeActivity(action: string, input: any = {}) {
    const pending = mutationTail.then(() => perform(action, input));
    mutationTail = pending.catch(() => {});
    return pending;
}

module.exports = { getMugeActivity, operateMugeActivity };
