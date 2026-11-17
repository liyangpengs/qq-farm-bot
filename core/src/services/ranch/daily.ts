export {};

/**
 * 牧场每日礼包与任务的自动领取。
 * 由 Worker 现有的每日例程触发，不另开定时器；
 * 写入沿用牧场服务的报价 → 确认流程（账号队列、资源锁、回包核对），结果未知时当日不再重发。
 */

const { isUnlocked } = require('./transport');
const { prepareAction, operate } = require('./actions');
const dailyShare = require('./daily-share');
const dailyBenefit = require('./daily-benefit');
const { log } = require('../../utils/utils');
const { getAutomation } = require('../../models/store');
const gameDate = () => dailyShare.getState().dateKey;

/** 失败后的重试间隔；每日任务完成进度随时变化，按较长间隔复查可领奖励，避免频繁切换场景。 */
const RETRY_MS = 10 * 60 * 1000;
const taskCheckMs = () => getAutomation().ranch_check_minutes * 60 * 1000;

interface RoutineState {
    dateKey: string;
    doneToday: boolean;
    lastAt: number;
    nextCheckAt: number;
    result: string;
    lastError: string;
}

function emptyState(): RoutineState {
    return { dateKey: gameDate(), doneToday: false, lastAt: 0, nextCheckAt: 0, result: '', lastError: '' };
}

let share: RoutineState = emptyState();
let tasks: RoutineState = emptyState();
let benefit: RoutineState = emptyState();

function today(state: RoutineState): RoutineState {
    return state.dateKey === gameDate() ? state : emptyState();
}

function shareClaimed(): boolean {
    return isUnlocked() && !!dailyShare.getState().claimed;
}

function rewardText(rewards: any[]): string {
    return (rewards || []).map((item: any) => `${item.name} ×${item.count}`).join('、');
}

/** 回包无法确认时不自动重发，当日停止，等待人工刷新核对。 */
function isUnknown(error: any): boolean {
    return error?.outcomeUnknown === true || ['RANCH_RESULT_UNKNOWN', 'PENDING_CONFIRMATION'].includes(error?.code);
}

async function claimShare(): Promise<void> {
    share = today(share);
    if (!isUnlocked()) {
        share = { ...share, doneToday: true, result: 'locked', lastError: '' };
        return;
    }
    if (shareClaimed()) {
        share = { ...share, doneToday: true, result: share.result || 'already_claimed' };
        return;
    }
    const now = Date.now();
    try {
        const quote = await prepareAction('claimDailyShare');
        if (quote.skipped) {
            share = { ...share, doneToday: true, lastAt: now, result: 'already_claimed', lastError: '' };
            return;
        }
        const outcome = await operate('claimDailyShare', { expected: quote.expected });
        share = { ...share, doneToday: true, lastAt: Date.now(), result: outcome.status === 'skipped' ? 'already_claimed' : 'ok', lastError: '' };
        if (outcome.status !== 'skipped')
            log('牧场', `每日首次分享礼包已领取：${rewardText(outcome.rewards)}`, { module: 'ranch', event: 'ranch_daily_share', result: 'ok' });
    } catch (error: any) {
        const unknown = isUnknown(error);
        share = { ...share, doneToday: unknown, lastAt: now, nextCheckAt: unknown ? 0 : now + RETRY_MS, result: 'error', lastError: String(error?.message || error) };
        log('牧场', `每日首次分享礼包领取失败：${share.lastError}`, { module: 'ranch', event: 'ranch_daily_share', result: 'error' });
    }
}

async function claimTasks(): Promise<void> {
    tasks = today(tasks);
    if (!isUnlocked()) {
        tasks = { ...tasks, doneToday: true, result: 'locked', lastError: '' };
        return;
    }
    const now = Date.now();
    try {
        const quote = await prepareAction('claimTasks', { all: true });
        if (quote.skipped) {
            tasks = { ...tasks, nextCheckAt: now + taskCheckMs(), result: tasks.result === 'error' ? 'none' : (tasks.result || 'none'), lastError: '' };
            return;
        }
        const outcome = await operate('claimTasks', { all: true, expected: quote.expected });
        tasks = { ...tasks, lastAt: Date.now(), nextCheckAt: Date.now() + taskCheckMs(), result: 'ok', lastError: '' };
        log('牧场', `领取牧场任务奖励 ${outcome.completed ?? quote.count} 项：${rewardText(outcome.rewards)}`, { module: 'ranch', event: 'ranch_task_claim', result: 'ok' });
    } catch (error: any) {
        const unknown = isUnknown(error);
        tasks = { ...tasks, doneToday: unknown, lastAt: now, nextCheckAt: unknown ? 0 : now + RETRY_MS, result: 'error', lastError: String(error?.message || error) };
        log('牧场', `牧场任务奖励领取失败：${tasks.lastError}`, { module: 'ranch', event: 'ranch_task_claim', result: 'error' });
    }
}

async function claimBenefit(): Promise<void> {
    benefit = today(benefit);
    const now = Date.now();
    try {
        const outcome = await dailyBenefit.claim();
        benefit = { ...benefit, doneToday: true, lastAt: outcome.claimed && !outcome.skipped ? now : 0, nextCheckAt: 0, result: outcome.claimed ? 'ok' : 'none', lastError: '' };
        if (!outcome.skipped) log('牧场', `每日福利已领取：${rewardText(outcome.rewards)}`, { module: 'ranch', event: 'ranch_daily_benefit', result: 'ok' });
    } catch (error: any) {
        const unknown = isUnknown(error);
        benefit = { ...benefit, doneToday: unknown, lastAt: now, nextCheckAt: unknown ? 0 : now + RETRY_MS, result: 'error', lastError: String(error?.message || error) };
        log('牧场', `每日福利领取失败：${benefit.lastError}`, { module: 'ranch', event: 'ranch_daily_benefit', result: 'error' });
    }
}

function getBenefitRoutineState(): { doneToday: boolean, nextCheckAt: number } {
    benefit = today(benefit);
    return { doneToday: benefit.doneToday || !isUnlocked() || !!dailyBenefit.getCachedState()?.claimed, nextCheckAt: benefit.nextCheckAt };
}

/** 供每日例程判断是否到期：分享以游戏端领取标记为准，任务按复查间隔。 */
function getShareRoutineState(): { doneToday: boolean, nextCheckAt: number } {
    share = today(share);
    return { doneToday: share.doneToday || !isUnlocked() || shareClaimed(), nextCheckAt: share.nextCheckAt };
}

function getTaskRoutineState(): { doneToday: boolean, nextCheckAt: number } {
    tasks = today(tasks);
    return { doneToday: tasks.doneToday || !isUnlocked(), nextCheckAt: tasks.nextCheckAt };
}

/** 每日礼包页的牧场部分：键名与农场一致，前端用同一套格子展示。 */
function getOverview(taskEnabled: boolean, shareEnabled = true, benefitEnabled = true): any {
    share = today(share);
    tasks = today(tasks);
    benefit = today(benefit);
    const unlocked = isUnlocked();
    return {
        unlocked,
        gifts: [
            { key: 'mall_free_gifts', label: '每日福利', enabled: benefitEnabled, doneToday: !!dailyBenefit.getCachedState()?.claimed || benefit.doneToday && benefit.result !== 'error', lastAt: benefit.lastAt, result: ['error', 'none'].includes(benefit.result) ? benefit.result : '', lastError: benefit.lastError },
            { key: 'task_claim', label: '每日任务', enabled: taskEnabled, lastAt: tasks.lastAt, result: tasks.result === 'error' ? 'error' : '', lastError: tasks.lastError },
            { key: 'daily_share', label: '分享礼包', enabled: shareEnabled, mode: 'auto_claim', doneToday: shareClaimed() || (share.doneToday && !['error', 'locked'].includes(share.result)), lastAt: share.lastAt,
                result: share.result === 'error' ? 'error' : '', lastError: share.lastError },
        ],
    };
}

function markTasksChanged(): void {
    tasks = today(tasks);
    if (tasks.result !== 'error') tasks.nextCheckAt = 0;
}

module.exports = { claimShare, claimTasks, claimBenefit, getBenefitRoutineState, getShareRoutineState, getTaskRoutineState, getOverview, markTasksChanged };
