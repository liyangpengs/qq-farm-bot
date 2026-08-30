const assert = require('node:assert/strict');
const test = require('node:test');

const {
    BUSINESS_BACKOFF_MAX_MS,
    BUSINESS_BACKOFF_MIN_MS,
    GATEWAY_STALL_PENDING_MS,
    LOW_PRIORITY_IDLE_WAIT_MAX_MS,
    LOW_PRIORITY_QUEUE_WAIT_MS,
    isGatewayHealthyForBusiness,
    isGatewayIdleForLowPriority,
    isGatewayYieldError,
    nextBusinessBackoffMs,
} = require('../dist/utils/low-priority-gate');

test('background work requires an idle and responsive gateway', () => {
    assert.ok(isGatewayIdleForLowPriority({
        blockingQueued: 0,
        businessPending: 0,
        backgroundPending: 0,
        heartbeatMisses: 0,
    }));
    assert.equal(isGatewayIdleForLowPriority({ blockingQueued: 1 }), false);
    assert.equal(isGatewayIdleForLowPriority({ businessPending: 1 }), false);
    assert.equal(isGatewayIdleForLowPriority({ backgroundPending: 1 }), false);
    assert.equal(isGatewayIdleForLowPriority({ heartbeatMisses: 1 }), false);
    assert.equal(isGatewayIdleForLowPriority({ oldestPendingAgeMs: GATEWAY_STALL_PENDING_MS }), false);
    assert.equal(isGatewayIdleForLowPriority(null), false);
});

test('business work backs off only when the gateway stops responding', () => {
    assert.ok(isGatewayHealthyForBusiness({
        blockingQueued: 3,
        businessPending: 3,
        oldestPendingAgeMs: 1200,
    }));
    assert.equal(isGatewayHealthyForBusiness({ heartbeatMisses: 1 }), false);
    assert.equal(isGatewayHealthyForBusiness({ oldestPendingAgeMs: GATEWAY_STALL_PENDING_MS }), false);
    assert.equal(isGatewayHealthyForBusiness(null), false);
});

test('business backoff starts at 30 seconds and caps at 60 seconds', () => {
    assert.equal(nextBusinessBackoffMs(), BUSINESS_BACKOFF_MIN_MS);
    assert.equal(nextBusinessBackoffMs(BUSINESS_BACKOFF_MIN_MS), BUSINESS_BACKOFF_MAX_MS);
    assert.equal(nextBusinessBackoffMs(BUSINESS_BACKOFF_MAX_MS), BUSINESS_BACKOFF_MAX_MS);
});

test('gateway yield errors are separated from friend-specific failures', () => {
    const busy = new Error('网关繁忙，后台请求已让路: Enter');
    busy.name = 'GatewayBusyError';
    assert.ok(isGatewayYieldError(busy));
    assert.ok(isGatewayYieldError(new Error('请求等待队列已满: Enter')));
    assert.ok(isGatewayYieldError(new Error('请求超时: Enter (stage=queued)')));
    assert.ok(isGatewayYieldError(new Error('连接未打开: Enter')));
    assert.equal(isGatewayYieldError(new Error('VisitService.Enter 错误: code=1001')), false);
    assert.equal(isGatewayYieldError(new Error('请求超时: Enter (stage=pending)')), false);
});

test('background wait limits are finite positive values', () => {
    assert.ok(LOW_PRIORITY_QUEUE_WAIT_MS > 0 && Number.isFinite(LOW_PRIORITY_QUEUE_WAIT_MS));
    assert.ok(LOW_PRIORITY_IDLE_WAIT_MAX_MS > 0 && Number.isFinite(LOW_PRIORITY_IDLE_WAIT_MAX_MS));
});
