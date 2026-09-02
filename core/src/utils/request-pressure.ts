export {};

/**
 * Gateway 请求压力上报策略。
 *
 * background 班次（面板好友扫描、宠物同步等补数据任务）本来就设计成「等网关空闲」，
 * 队列里只剩这类请求属于正常运行，不该刷压力告警。只有真正等不到连接的班次
 * （critical / foreground / farm / friend）才代表拥塞。
 */

const REQUEST_PRESSURE_LOG_INTERVAL_MS = 5000;

interface QueuedPriorityLike {
    requestClass?: string;
}

function countBlockingQueuedRequests(queue: readonly QueuedPriorityLike[]): number {
    let count = 0;
    for (const request of queue || []) {
        if (request && request.requestClass === 'background') continue;
        count += 1;
    }
    return count;
}

function shouldLogRequestPressure(
    queue: readonly QueuedPriorityLike[],
    now: number,
    lastLoggedAt: number,
    intervalMs: number = REQUEST_PRESSURE_LOG_INTERVAL_MS,
): boolean {
    if (countBlockingQueuedRequests(queue) === 0) return false;
    return Number(now) - Number(lastLoggedAt) >= intervalMs;
}

module.exports = {
    REQUEST_PRESSURE_LOG_INTERVAL_MS,
    countBlockingQueuedRequests,
    shouldLogRequestPressure,
};
