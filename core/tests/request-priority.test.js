const assert = require('node:assert/strict');
const test = require('node:test');

const {
    CLASS_STARVATION_MS,
    MAX_BUSINESS_IN_FLIGHT,
    MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT,
    describeRequestClassMarker,
    isClassQueueFull,
    maxQueuedForClass,
    resolveRequestClass,
    selectDispatchIndex,
} = require('../dist/utils/request-priority');

function queued(requestClass, extra = {}) {
    return { requestClass, enqueuedAt: 1_000_000, ...extra };
}

test('request classes preserve critical lanes and inherit normal requests from context', () => {
    assert.equal(resolveRequestClass({ criticalLane: 'heartbeat' }), 'critical');
    assert.equal(resolveRequestClass({ criticalLane: 'ace' }), 'critical');
    assert.equal(resolveRequestClass({ priority: 'high' }), 'critical');
    assert.equal(resolveRequestClass({ priority: 'low', requestClass: 'foreground' }), 'foreground');
    assert.equal(resolveRequestClass({ priority: 'low' }), 'background');
    assert.equal(resolveRequestClass({ priority: 'normal' }, 'friend'), 'friend');
    assert.equal(resolveRequestClass({}, 'farm'), 'farm');
    assert.equal(resolveRequestClass({}), 'foreground');
});

test('heartbeat and ACE keep independent slots when business traffic is full', () => {
    const queue = [
        queued('farm'),
        queued('critical', { criticalLane: 'ace' }),
        queued('critical', { criticalLane: 'heartbeat' }),
    ];
    const business = [
        { requestClass: 'farm' },
        { requestClass: 'friend' },
        { requestClass: 'foreground' },
    ];

    assert.equal(selectDispatchIndex(queue, business, 1_000_000), 2);
    assert.equal(selectDispatchIndex(
        queue,
        [...business, { requestClass: 'critical', criticalLane: 'heartbeat' }],
        1_000_000,
    ), 1);

    const critical = [
        { requestClass: 'critical', criticalLane: 'heartbeat' },
        { requestClass: 'critical', criticalLane: 'ace' },
    ];
    assert.equal(selectDispatchIndex(queue, [...business, ...critical], 1_000_000), -1);
    assert.equal(selectDispatchIndex(queue, critical, 1_000_000), 0);
});

test('scheduled business traffic cannot consume the foreground reserve', () => {
    const queue = [queued('farm'), queued('foreground')];
    const backgroundBusiness = [{ requestClass: 'farm' }, { requestClass: 'friend' }];

    assert.equal(backgroundBusiness.length, MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT);
    assert.equal(selectDispatchIndex(queue, backgroundBusiness, 1_000_000), 1);

    const full = [...backgroundBusiness, { requestClass: 'foreground' }];
    assert.equal(full.length, MAX_BUSINESS_IN_FLIGHT);
    assert.equal(selectDispatchIndex(queue, full, 1_000_000), -1);
});

test('business classes prefer foreground, then farm, then friend with FIFO inside a class', () => {
    const queue = [
        queued('friend', { methodName: 'friendA' }),
        queued('farm', { methodName: 'farmA' }),
        queued('foreground', { methodName: 'panel' }),
        queued('farm', { methodName: 'farmB' }),
    ];

    assert.equal(selectDispatchIndex(queue, [], 1_000_000), 2);
    const withoutForeground = queue.filter(item => item.requestClass !== 'foreground');
    assert.equal(selectDispatchIndex(withoutForeground, [{ requestClass: 'foreground' }], 1_000_000), 1);
    assert.equal(selectDispatchIndex(
        withoutForeground,
        [{ requestClass: 'farm' }, { requestClass: 'farm' }],
        1_000_000,
    ), -1);
    assert.equal(selectDispatchIndex([queued('friend')], [{ requestClass: 'farm' }], 1_000_000), 0);
});

test('starved business work is promoted without bypassing capacity limits', () => {
    const now = 1_000_000;
    assert.equal(selectDispatchIndex([
        queued('friend', { enqueuedAt: now - CLASS_STARVATION_MS }),
        queued('foreground', { enqueuedAt: now }),
    ], [], now), 0);
    assert.equal(selectDispatchIndex([
        queued('friend', { enqueuedAt: now - 500 }),
        queued('foreground', { enqueuedAt: now }),
    ], [], now), 1);
});

test('background work runs only when the gateway is otherwise idle', () => {
    const now = 1_000_000;
    assert.equal(selectDispatchIndex([queued('background')], [], now), 0);
    assert.equal(selectDispatchIndex(
        [queued('background')],
        [{ requestClass: 'critical', criticalLane: 'heartbeat' }],
        now,
    ), -1);
    assert.equal(selectDispatchIndex([queued('background'), queued('friend')], [], now), 1);
    assert.equal(selectDispatchIndex([queued('background')], [{ requestClass: 'background' }], now), -1);
});

test('queue limits are isolated by request class', () => {
    const backgroundFull = Array.from(
        { length: maxQueuedForClass('background') },
        () => queued('background'),
    );

    assert.ok(isClassQueueFull(backgroundFull, 'background'));
    assert.equal(isClassQueueFull(backgroundFull, 'critical'), false);
    assert.equal(isClassQueueFull(backgroundFull, 'foreground'), false);
    assert.ok(maxQueuedForClass('background') < maxQueuedForClass('foreground'));
    assert.ok(maxQueuedForClass('friend') <= maxQueuedForClass('farm'));
});

test('pressure markers identify every request class', () => {
    assert.equal(describeRequestClassMarker({ requestClass: 'critical', criticalLane: 'heartbeat' }), '!H:');
    assert.equal(describeRequestClassMarker({ requestClass: 'critical', criticalLane: 'ace' }), '!A:');
    assert.equal(describeRequestClassMarker({ requestClass: 'critical' }), '!');
    assert.equal(describeRequestClassMarker({ requestClass: 'foreground' }), '');
    assert.equal(describeRequestClassMarker({ requestClass: 'farm' }), '#');
    assert.equal(describeRequestClassMarker({ requestClass: 'friend' }), '&');
    assert.equal(describeRequestClassMarker({ requestClass: 'background' }), '~');
});
