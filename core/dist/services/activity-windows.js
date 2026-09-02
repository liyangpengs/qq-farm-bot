"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { sendMsgAsync, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, logWarn, toNum } = require('../utils/utils');
const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRY_LOG_INTERVAL_MS = 60 * 1000;
let activityWindows = new Map();
let loadedAt = 0;
let pendingRefresh = null;
let lastFailureLogAt = 0;
function decodeActivityWindows(reply) {
    const rows = Array.isArray(reply?.activity_windows) ? reply.activity_windows : [];
    const windows = new Map();
    for (const row of rows) {
        const id = String(toNum(row?.id) || '').trim();
        if (!id)
            continue;
        windows.set(id, {
            id,
            name: String(row?.name || ''),
            beginTime: toNum(row?.begin_time),
            endTime: toNum(row?.end_time),
        });
    }
    return windows;
}
async function refreshActivityWindows() {
    if (pendingRefresh)
        return pendingRefresh;
    pendingRefresh = (async () => {
        const body = types.ActivityListRequest.encode(types.ActivityListRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'List', body);
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
    }
    finally {
        pendingRefresh = null;
    }
}
async function getActivityWindows() {
    const fresh = loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS;
    if (!fresh) {
        try {
            await refreshActivityWindows();
        }
        catch (error) {
            if (activityWindows.size === 0)
                throw error;
        }
    }
    return Array.from(activityWindows.values(), window => ({ ...window }));
}
function invalidateActivityWindows() {
    loadedAt = 0;
}
async function getSellConditionContext() {
    const fresh = loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS;
    if (!fresh) {
        try {
            await refreshActivityWindows();
        }
        catch (error) {
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
//# sourceMappingURL=activity-windows.js.map