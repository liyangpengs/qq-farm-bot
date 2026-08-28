export {};
/**
 * 任务系统 - 自动领取任务奖励
 */

const { submitAccountTask } = require('../app/account-task-runner');
const { isAutomationOn } = require('../models/store');
const { sendMsgAsync, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep, getSystemDateKey } = require('../utils/utils');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');

let taskClaimDoneDateKey: string = '';
let taskClaimLastAt: number = 0;
const taskScheduler: any = createScheduler('task');

// ============ 任务 API ============

async function getTaskInfo(): Promise<any> {
    const body: Uint8Array = types.TaskInfoRequest.encode(types.TaskInfoRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'TaskInfo', body);
    return types.TaskInfoReply.decode(replyBody);
}

async function claimTaskReward(taskId: number, doShared: boolean = false): Promise<any> {
    const body: Uint8Array = types.ClaimTaskRewardRequest.encode(types.ClaimTaskRewardRequest.create({
        id: toLong(taskId),
        do_shared: doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimTaskReward', body);
    return types.ClaimTaskRewardReply.decode(replyBody);
}

async function claimDailyReward(type: number, pointIds: number[]): Promise<any> {
    if (!types.ClaimDailyRewardRequest || !types.ClaimDailyRewardReply) {
        return { items: [] };
    }
    const body: Uint8Array = types.ClaimDailyRewardRequest.encode(types.ClaimDailyRewardRequest.create({
        type: Number(type) || 0,
        point_ids: (pointIds || []).map((id: number) => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimDailyReward', body);
    return types.ClaimDailyRewardReply.decode(replyBody);
}

async function claimAllIllustratedRewards(): Promise<any> {
    if (!types.ClaimAllRewardsV2Request || !types.ClaimAllRewardsV2Reply) {
        return { items: [], bonus_items: [] };
    }
    const body: Uint8Array = types.ClaimAllRewardsV2Request.encode(types.ClaimAllRewardsV2Request.create({
        only_claimable: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.illustratedpb.IllustratedService', 'ClaimAllRewardsV2', body);
    return types.ClaimAllRewardsV2Reply.decode(replyBody);
}

async function getTicketBalanceFromBag(): Promise<number> {
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const rep: any = await getBag();
        const items: any[] = getBagItems(rep);
        for (const it of (items || [])) {
            if (toNum(it && it.id) === 1002) return Math.max(0, toNum(it && it.count));
        }
        return 0;
    } catch {
        return 0;
    }
}

// ============ 任务分析 ============

function formatTask(t: any, category: string = 'main'): any {
    return {
        id: toNum(t.id),
        desc: t.desc || `任务#${toNum(t.id)}`,
        category,
        progress: toNum(t.progress),
        totalProgress: toNum(t.total_progress),
        isClaimed: t.is_claimed,
        isUnlocked: t.is_unlocked,
        shareMultiple: toNum(t.share_multiple),
        rewards: (t.rewards || []).map((r: any) => ({ id: toNum(r.id), count: toNum(r.count) })),
        canClaim: t.is_unlocked && !t.is_claimed && toNum(t.progress) >= toNum(t.total_progress) && toNum(t.total_progress) > 0
    };
}

/**
 * 分析任务列表，找出可领取的任务
 */
function analyzeTaskList(tasks: any[], category: string = 'main'): any[] {
    const claimable: any[] = [];
    for (const task of tasks) {
        const t: any = formatTask(task, category);
        if (t.id > 0 && t.canClaim) {
            claimable.push(t);
        }
    }
    return claimable;
}

/**
 * 计算奖励摘要
 */
function getRewardSummary(items: any[]): string {
    const summary: string[] = [];
    for (const item of items) {
        const id: number = toNum(item.id);
        const count: number = toNum(item.count);
        if (id === 1 || id === 1001) summary.push(`金币${count}`);
        else if (id === 2 || id === 1101) summary.push(`经验${count}`);
        else if (id === 1002) summary.push(`点券${count}`);
        else summary.push(`物品#${id}x${count}`);
    }
    return summary.join('/');
}

interface NormalizedTaskInfo {
    growthTasks: any[];
    dailyTasks: any[];
    otherTasks: any[];
    actives: any[];
}

function normalizeTaskInfo(taskInfo: any): NormalizedTaskInfo {
    const source: any = taskInfo && typeof taskInfo === 'object' ? taskInfo : {};
    const growthTasks: any[] = [];
    const dailyTasks: any[] = [];
    const otherTasks: any[] = [];
    const seenIds = new Set<number>();

    const append = (task: any, target: any[]): void => {
        if (!task || typeof task !== 'object') return;
        const id: number = toNum(task.id);
        if (id > 0) {
            if (seenIds.has(id)) return;
            seenIds.add(id);
        }
        target.push(task);
    };

    for (const task of (Array.isArray(source.tasks) ? source.tasks : [])) {
        const taskType: number = toNum(task && task.task_type);
        if (taskType === 1) append(task, growthTasks);
        else if (taskType === 2) append(task, dailyTasks);
        else append(task, otherTasks);
    }
    for (const task of (Array.isArray(source.growth_tasks) ? source.growth_tasks : [])) {
        append(task, growthTasks);
    }
    for (const task of (Array.isArray(source.daily_tasks) ? source.daily_tasks : [])) {
        append(task, dailyTasks);
    }

    return {
        growthTasks,
        dailyTasks,
        otherTasks,
        actives: Array.isArray(source.actives) ? source.actives : [],
    };
}

async function checkAndClaimActives(actives: any[]): Promise<{ scanned: number; claimed: number; errors: number }> {
    const list: any[] = Array.isArray(actives) ? actives : [];
    let scanned: number = 0;
    let claimed: number = 0;
    let errors: number = 0;
    for (const active of list) {
        const activeType: number = toNum(active.type);
        const rewards: any[] = active.rewards || [];
        const claimable: any[] = rewards.filter((r: any) => toNum(r.status) === 2);
        if (!claimable.length) continue;
        scanned += claimable.length;
        const pointIds: number[] = claimable.map((r: any) => toNum(r.point_id)).filter((n: number) => n > 0);
        if (!pointIds.length) continue;
        const typeName: string = activeType === 1 ? '日活跃' : (activeType === 2 ? '周活跃' : `活跃${activeType}`);
        try {
            log('活跃', `${typeName} 发现 ${pointIds.length} 个可领取奖励`, {
                module: 'task', event: '扫描活跃奖励', result: 'ok', activeType, count: pointIds.length
            });
            const reply: any = await claimDailyReward(activeType, pointIds);
            const items: any[] = reply.items || [];
            if (items.length > 0) {
                log('活跃', `${typeName} 领取: ${getRewardSummary(items)}`, {
                    module: 'task', event: '领取活跃奖励', result: 'ok', activeType, count: items.length
                });
            }
            claimed += pointIds.length;
            await sleep(300);
        } catch (e: any) {
            errors += 1;
            log('活跃', `${typeName} 领取失败: ${e.message}`, {
                module: 'task', event: '领取活跃奖励', result: 'error', activeType
            });
        }
    }
    return { scanned, claimed, errors };
}

async function checkAndClaimIllustratedRewards(): Promise<boolean> {
    try {
        const beforeTicket: number = await getTicketBalanceFromBag();
        const reply: any = await claimAllIllustratedRewards();
        const items: any[] = [
            ...(Array.isArray(reply && reply.items) ? reply.items : []),
            ...(Array.isArray(reply && reply.bonus_items) ? reply.bonus_items : []),
        ];
        const afterTicket: number = await getTicketBalanceFromBag();
        const gainTicket: number = Math.max(0, afterTicket - beforeTicket);
        if (gainTicket < 200) return false;

        log('任务', `领取成功: 点券${gainTicket}`, {
            module: 'task',
            event: '图鉴奖励',
            result: 'ok',
            scope: 'illustrated',
            count: items.length,
        });
        taskClaimDoneDateKey = getSystemDateKey();
        taskClaimLastAt = Date.now();
        recordOperation('taskClaim', 1);
        return true;
    } catch {
        return false;
    }
}

// ============ 自动领取 ============

async function checkAndClaimTasks(): Promise<void> {
    if (!isAutomationOn('task')) return;
    try {
        const reply: any = await getTaskInfo();
        if (!reply.task_info) return;

        const taskInfo: any = reply.task_info;
        const normalized: NormalizedTaskInfo = normalizeTaskInfo(taskInfo);

        const dailyClaimable: any[] = analyzeTaskList(normalized.dailyTasks, 'daily');
        const growthClaimable: any[] = analyzeTaskList(normalized.growthTasks, 'growth');
        const mainClaimable: any[] = analyzeTaskList(normalized.otherTasks, 'main');
        const claimable: any[] = [...dailyClaimable, ...growthClaimable, ...mainClaimable];
        if (claimable.length > 0) {
            log('任务', `发现 ${claimable.length} 个可领取任务`, {
                module: 'task', event: '扫描任务', result: 'ok', count: claimable.length
            });
            if (dailyClaimable.length > 0) {
                log('任务', `每日任务可领取: ${dailyClaimable.map((t: any) => t.desc).join('，')}`, {
                    module: 'task', event: '扫描任务', result: 'ok', count: dailyClaimable.length, scope: 'daily'
                });
            }
            let dailyClaimSuccess: number = 0;
            for (const task of claimable) {
                const ok: boolean = await doClaim(task);
                if (task.category === 'daily' && ok) dailyClaimSuccess += 1;
            }
            if (dailyClaimable.length > 0 && dailyClaimSuccess === 0) {
                log('任务', '每日任务本次未领取成功', {
                    module: 'task', event: '领取任务', result: 'none', scope: 'daily'
                });
            }
        }
        await checkAndClaimActives(normalized.actives);
    } catch (e: any) {
        logWarn('任务', `检查任务失败: ${e.message}`, {
            module: 'task', event: '扫描任务', result: 'error'
        });
    }
}

async function doClaim(task: any): Promise<boolean> {
    try {
        const useShare: boolean = task.shareMultiple > 1;
        const multipleStr: string = useShare ? ` (${task.shareMultiple}倍)` : '';

        const claimReply: any = await claimTaskReward(task.id, useShare);
        const items: any[] = claimReply.items || [];
        const rewardStr: string = items.length > 0 ? getRewardSummary(items) : '无';

        const categoryName: string = task.category === 'daily' ? '每日任务' : (task.category === 'growth' ? '成长任务' : '任务');
        log('任务', `领取(${categoryName}): ${task.desc}${multipleStr} → ${rewardStr}`, {
            module: 'task', event: '领取任务', result: 'ok', taskId: task.id, shared: useShare
        });
        taskClaimDoneDateKey = getSystemDateKey();
        taskClaimLastAt = Date.now();
        recordOperation('taskClaim', 1);
        await sleep(300);
        if (task.category === 'growth') {
            // The server exposes one growth task at a time. Fetching again after a
            // successful claim makes the next task visible immediately.
            await getTaskInfo();
        }
        return true;
    } catch {
        // 领取失败静默处理
        return false;
    }
}

function onTaskInfoNotify(taskInfo: any): void {
    if (!taskInfo) return;
    if (!isAutomationOn('task')) return;

    const normalized: NormalizedTaskInfo = normalizeTaskInfo(taskInfo);
    const claimable: any[] = [
        ...analyzeTaskList(normalized.dailyTasks, 'daily'),
        ...analyzeTaskList(normalized.growthTasks, 'growth'),
        ...analyzeTaskList(normalized.otherTasks, 'main'),
    ];
    const actives: any[] = normalized.actives;
    const hasClaimable: boolean = claimable.length > 0;
    if (!hasClaimable && actives.length === 0) return;
    if (hasClaimable) log('任务', `有 ${claimable.length} 个任务可领取，准备自动领取...`, {
        module: 'task', event: '领取任务', result: 'plan', count: claimable.length
    });
    taskScheduler.setTimeoutTask('task_claim_debounce', 1000, async () => {
        await submitAccountTask('task.notify.claim', async () => {
            if (hasClaimable) await claimTasksFromList(claimable);
            await checkAndClaimActives(actives);
        }, { priority: 'event' });
    });
}

async function claimTasksFromList(claimable: any[]): Promise<void> {
    if (!isAutomationOn('task')) return;
    for (const task of claimable) {
        await doClaim(task);
    }
}

// ============ 初始化 ============

function initTaskSystem(): void {
    cleanupTaskSystem();
    networkEvents.on('taskInfoNotify', onTaskInfoNotify);
    taskScheduler.setTimeoutTask('task_init_bootstrap', 4000, async () => {
        await submitAccountTask('task.claim', checkAndClaimTasks, {
            priority: 'maintenance',
            dedupeKey: 'task.claim',
        });
        if (isAutomationOn('task')) {
            await submitAccountTask('task.bootstrap.illustrated', checkAndClaimIllustratedRewards, {
                priority: 'maintenance',
                dedupeKey: 'task.bootstrap.illustrated',
            });
        }
    });
}

function cleanupTaskSystem(): void {
    networkEvents.off('taskInfoNotify', onTaskInfoNotify);
    taskScheduler.clearAll();
}

module.exports = {
    checkAndClaimTasks,
    initTaskSystem,
    cleanupTaskSystem,
    claimTaskReward,
    doClaim, // 供手动领取使用
    normalizeTaskInfo,
    getTaskClaimDailyState: () => ({
        key: 'task_claim',
        doneToday: taskClaimDoneDateKey === getSystemDateKey(),
        lastClaimAt: taskClaimLastAt,
    }),
    getTaskDailyStateLikeApp: async () => {
        try {
            const reply: any = await getTaskInfo();
            const ti: any = reply && reply.task_info ? reply.task_info : {};
            const dailyAll: any[] = normalizeTaskInfo(ti).dailyTasks;
            const completedDaily: any[] = dailyAll.filter((t: any) => {
                const progress: number = toNum(t && t.progress);
                const totalProgress: number = toNum(t && t.total_progress);
                return totalProgress > 0 && progress >= totalProgress;
            });
            const completedCount: number = Math.min(3, completedDaily.length);
            const pendingDaily: any[] = dailyAll.filter((t: any) => {
                const isUnlocked: boolean = !!(t && t.is_unlocked);
                const isClaimed: boolean = !!(t && t.is_claimed);
                const totalProgress: number = toNum(t && t.total_progress);
                return isUnlocked && !isClaimed && totalProgress > 0;
            });
            const dailyClaimable: any[] = analyzeTaskList(dailyAll, 'daily');
            return {
                key: 'task_claim',
                // 每日任务总数按 3 计算，完成口径为 progress >= total_progress
                doneToday: completedCount >= 3,
                lastClaimAt: taskClaimLastAt,
                claimableCount: dailyClaimable.length,
                pendingCount: pendingDaily.length,
                completedCount,
                totalCount: 3,
            };
        } catch {
            return {
                key: 'task_claim',
                doneToday: false,
                lastClaimAt: taskClaimLastAt,
                claimableCount: 0,
                pendingCount: 0,
                completedCount: 0,
                totalCount: 3,
            };
        }
    },
    getGrowthTaskStateLikeApp: async () => {
        try {
            const reply: any = await getTaskInfo();
            const ti: any = reply && reply.task_info ? reply.task_info : {};
            const growthList: any[] = normalizeTaskInfo(ti).growthTasks;
            const tasks: any[] = growthList.map((t: any) => {
                const progress: number = Math.max(0, toNum(t && t.progress));
                const totalProgress: number = Math.max(0, toNum(t && t.total_progress));
                const isClaimed: boolean = !!(t && t.is_claimed);
                const isUnlocked: boolean = !!(t && t.is_unlocked);
                const isCompleted: boolean = totalProgress > 0 && progress >= totalProgress;
                return {
                    id: toNum(t && t.id),
                    desc: (t && t.desc) || `成长任务#${toNum(t && t.id)}`,
                    progress,
                    totalProgress,
                    isClaimed,
                    isUnlocked,
                    isCompleted,
                };
            });
            const activeTasks: any[] = tasks.filter((t: any) => t.isUnlocked && !t.isClaimed);
            const currentTask: any | null = activeTasks[0] || tasks[0] || null;
            return {
                key: 'growth_task',
                // Growth tasks are a chain, not a daily checklist. An empty server
                // list means the chain is complete; a completed current task is
                // claimable and will be replaced by the next task after claiming.
                doneToday: false,
                completedCount: currentTask ? Math.min(currentTask.progress, currentTask.totalProgress) : 0,
                totalCount: currentTask ? currentTask.totalProgress : 0,
                currentTask,
                tasks,
            };
        } catch {
            return {
                key: 'growth_task',
                doneToday: false,
                completedCount: 0,
                totalCount: 0,
                tasks: [],
            };
        }
    },
};
