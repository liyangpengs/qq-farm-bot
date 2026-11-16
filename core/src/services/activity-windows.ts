import type { ActivityWindow, SellConditionContext } from '../config/sell-conditions';

export {};

const { sendMsgAsync, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, logWarn, toNum } = require('../utils/utils');

const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRY_LOG_INTERVAL_MS = 60 * 1000;

let activityWindows: ReadonlyMap<string, ActivityWindow> = new Map();
let loadedAt = 0;
let pendingRefresh: Promise<ReadonlyMap<string, ActivityWindow>> | null = null;
let lastFailureLogAt = 0;

function decodeActivityWindows(reply: any): ReadonlyMap<string, ActivityWindow> {
    const rows: any[] = Array.isArray(reply?.activity_windows) ? reply.activity_windows : [];
    const windows = new Map<string, ActivityWindow>();
    for (const row of rows) {
        const id = String(toNum(row?.id) || '').trim();
        if (!id) continue;
        windows.set(id, {
            id,
            name: String(row?.name || ''),
            beginTime: toNum(row?.begin_time),
            endTime: toNum(row?.end_time),
        });
    }
    return windows;
}

async function refreshActivityWindows(): Promise<ReadonlyMap<string, ActivityWindow>> {
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = (async () => {
        const body: Uint8Array = types.ActivityListRequest.encode(
            types.ActivityListRequest.create({ game_scene_id: 1 })
        ).finish();
        const { body: replyBody } = await sendMsgAsync(
            'gamepb.activitypb.ActivityService',
            'List',
            body
        );
        const reply = types.ActivityListReply.decode(replyBody);
        const nextWindows = decodeActivityWindows(reply);
        if (nextWindows.size === 0) {
            throw new Error('活动列表回包未包含时间配置');
        }
        activityWindows = nextWindows;
        loadedAt = Date.now();
        return activityWindows;
    })();
    try {
        return await pendingRefresh;
    } finally {
        pendingRefresh = null;
    }
}

async function getActivityWindows(): Promise<ReadonlyArray<ActivityWindow>> {
    const fresh = loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS;
    if (!fresh) {
        try {
            await refreshActivityWindows();
        } catch (error) {
            if (activityWindows.size === 0) throw error;
        }
    }
    return Array.from(activityWindows.values(), window => ({ ...window }));
}

function invalidateActivityWindows(): void {
    loadedAt = 0;
}

async function getSellConditionContext(): Promise<SellConditionContext> {
    const fresh = loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS;
    if (!fresh) {
        try {
            await refreshActivityWindows();
        } catch (error: any) {
            const now = Date.now();
            if (now - lastFailureLogAt >= RETRY_LOG_INTERVAL_MS) {
                lastFailureLogAt = now;
                logWarn('仓库', `活动时间同步失败: ${error?.message || error}`);
            }
        }
    }
    return {
        nowSec: getServerTimeSec(),
        activityWindows,
        activityWindowsLoaded: loadedAt > 0,
    };
}

networkEvents.on('activitiesChanged', invalidateActivityWindows);
networkEvents.on('disconnected', invalidateActivityWindows);

module.exports = {
    refreshActivityWindows,
    getActivityWindows,
    invalidateActivityWindows,
    getSellConditionContext,
};
