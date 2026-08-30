export {};

/**
 * Gateway request pressure reporting policy.
 * Low priority requests own a dedicated slot and are meant to wait for an idle gateway,
 * so a queue that only holds low priority work (panel friend scans, background syncs) is
 * normal operation. Only requests that could not be dispatched at all mean congestion.
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
