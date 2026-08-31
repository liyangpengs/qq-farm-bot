export {};

interface GatewayLoadLike {
    blockingQueued?: number;
    businessPending?: number;
    backgroundPending?: number;
    heartbeatMisses?: number;
    oldestPendingAgeMs?: number;
}

const LOW_PRIORITY_QUEUE_WAIT_MS = 8000;
const LOW_PRIORITY_IDLE_WAIT_MAX_MS = 8000;
const LOW_PRIORITY_IDLE_POLL_MS = 250;
const GATEWAY_STALL_PENDING_MS = 5000;
const BUSINESS_BACKOFF_MIN_MS = 30000;
const BUSINESS_BACKOFF_MAX_MS = 60000;

function isGatewayIdleForLowPriority(load: GatewayLoadLike | null | undefined): boolean {
    if (!load) return false;
    if (Number(load.blockingQueued) > 0) return false;
    if (Number(load.businessPending) > 0) return false;
    if (Number(load.backgroundPending) > 0) return false;
    if (Number(load.heartbeatMisses) > 0) return false;
    if (Number(load.oldestPendingAgeMs) >= GATEWAY_STALL_PENDING_MS) return false;
    return true;
}

function isGatewayHealthyForBusiness(load: GatewayLoadLike | null | undefined): boolean {
    if (!load) return false;
    if (Number(load.heartbeatMisses) > 0) return false;
    if (Number(load.oldestPendingAgeMs) >= GATEWAY_STALL_PENDING_MS) return false;
    return true;
}

function nextBusinessBackoffMs(previousBackoffMs: number = 0): number {
    const previous = Number(previousBackoffMs) || 0;
    if (previous <= 0) return BUSINESS_BACKOFF_MIN_MS;
    return Math.min(BUSINESS_BACKOFF_MAX_MS, previous * 2);
}

function isGatewayYieldError(error: any): boolean {
    if (!error) return false;
    if (error.name === 'GatewayBusyError') return true;
    const message = String(error?.message || error || '');
    return message.includes('已让路')
        || message.includes('stage=queued')
        || message.includes('请求等待队列已满')
        || message.includes('请求已中断')
        || message.includes('连接未打开')
        || message.includes('尚未登录');
}

module.exports = {
    GATEWAY_STALL_PENDING_MS,
    BUSINESS_BACKOFF_MIN_MS,
    BUSINESS_BACKOFF_MAX_MS,
    LOW_PRIORITY_QUEUE_WAIT_MS,
    LOW_PRIORITY_IDLE_WAIT_MAX_MS,
    LOW_PRIORITY_IDLE_POLL_MS,
    isGatewayIdleForLowPriority,
    isGatewayHealthyForBusiness,
    nextBusinessBackoffMs,
    isGatewayYieldError,
};
