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

test('班次解析：心跳/ACE 永远是 critical，priority:normal 视为未表态', () => {
    assert.equal(resolveRequestClass({ criticalLane: 'heartbeat' }), 'critical');
    assert.equal(resolveRequestClass({ criticalLane: 'ace' }), 'critical');
    assert.equal(resolveRequestClass({ priority: 'high' }), 'critical');
    // 显式班次优先于 priority 兼容映射
    assert.equal(resolveRequestClass({ priority: 'low', requestClass: 'foreground' }), 'foreground');
    assert.equal(resolveRequestClass({ priority: 'low' }), 'background');
    // api 层大量默认传 normal，必须回落到调度器注入的环境班次，否则后台任务会伪装成前台
    assert.equal(resolveRequestClass({ priority: 'normal' }, 'friend'), 'friend');
    assert.equal(resolveRequestClass({}, 'farm'), 'farm');
    // 没有环境班次（面板 HTTP / Socket.IO 调用）默认前台：那边确实有人在等结果
    assert.equal(resolveRequestClass({}), 'foreground');
    assert.equal(resolveRequestClass(null, 'bogus'), 'foreground');
});

test('心跳与 ACE 各有独立保留槽位，业务排满也挤不掉', () => {
    const queue = [
        queued('farm'),
        queued('critical', { criticalLane: 'ace' }),
        queued('critical', { criticalLane: 'heartbeat' }),
    ];
    const busyBusiness = [
        { requestClass: 'farm' },
        { requestClass: 'friend' },
        { requestClass: 'foreground' },
    ];
    // 业务在途已满，心跳仍然先走
    assert.equal(selectDispatchIndex(queue, busyBusiness, 1_000_000), 2);
    // 心跳已经在飞，ACE 用自己的槽位
    assert.equal(selectDispatchIndex(queue, [...busyBusiness, { requestClass: 'critical', criticalLane: 'heartbeat' }], 1_000_000), 1);
    // 两条通道都在飞就轮到业务，但业务预算已满 → 什么都发不出去
    const bothLanes = [
        { requestClass: 'critical', criticalLane: 'heartbeat' },
        { requestClass: 'critical', criticalLane: 'ace' },
    ];
    assert.equal(selectDispatchIndex(queue, [...busyBusiness, ...bothLanes], 1_000_000), -1);
    // 业务在途清空后，farm 可以发
    assert.equal(selectDispatchIndex(queue, bothLanes, 1_000_000), 0);
});

test('前台永远留一个业务槽位，后台定时任务抢不走', () => {
    const queue = [queued('farm'), queued('foreground')];
    const nonForeground = [{ requestClass: 'farm' }, { requestClass: 'friend' }];

    assert.equal(nonForeground.length, MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT);
    // farm + friend 已占满非前台额度：队首的 farm 被跳过，前台请求直接插到前面
    assert.equal(selectDispatchIndex(queue, nonForeground, 1_000_000), 1);
    // 业务总预算被占满后连前台也得等（此时在飞的都会很快回来）
    const full = [...nonForeground, { requestClass: 'foreground' }];
    assert.equal(full.length, MAX_BUSINESS_IN_FLIGHT);
    assert.equal(selectDispatchIndex(queue, full, 1_000_000), -1);
});

test('业务班次按 前台 > 自己农场 > 好友农场 排序，同班次 FIFO', () => {
    const queue = [
        queued('friend', { methodName: 'friendA' }),
        queued('farm', { methodName: 'farmA' }),
        queued('foreground', { methodName: 'panel' }),
        queued('farm', { methodName: 'farmB' }),
    ];
    // 前台请求排在队尾也先走
    assert.equal(selectDispatchIndex(queue, [], 1_000_000), 2);
    // 前台已发完（不在队列里）时轮到自己农场，同班次内取更早入队的 farmA
    const withoutForeground = queue.filter(item => item.requestClass !== 'foreground');
    assert.equal(selectDispatchIndex(withoutForeground, [{ requestClass: 'foreground' }], 1_000_000), 1);
    // 自己农场还有活要干时，好友农场就得等（饿死保护会在 4 秒后把它提上来）
    assert.equal(
        selectDispatchIndex(withoutForeground, [{ requestClass: 'farm' }, { requestClass: 'farm' }], 1_000_000),
        -1,
    );
    // 自己农场的活清空后好友请求才发出去
    assert.equal(selectDispatchIndex([queued('friend')], [{ requestClass: 'farm' }], 1_000_000), 0);
});

test('排队超时的低优先班次会被提升，避免被持续插队饿死', () => {
    const now = 1_000_000;
    const queue = [
        queued('friend', { enqueuedAt: now - CLASS_STARVATION_MS }),
        queued('foreground', { enqueuedAt: now }),
    ];
    // 好友请求已经等了阈值时长，这一轮先让它走
    assert.equal(selectDispatchIndex(queue, [], now), 0);
    // 还没到阈值时仍按班次优先级
    const fresh = [
        queued('friend', { enqueuedAt: now - 500 }),
        queued('foreground', { enqueuedAt: now }),
    ];
    assert.equal(selectDispatchIndex(fresh, [], now), 1);
});

test('background 只在连接彻底空闲时才发', () => {
    const now = 1_000_000;
    assert.equal(selectDispatchIndex([queued('background')], [], now), 0);
    // 有任何在途请求（哪怕只是心跳）都不发后台请求
    assert.equal(selectDispatchIndex([queued('background')], [{ requestClass: 'critical', criticalLane: 'heartbeat' }], now), -1);
    // 队列里还有业务请求在等，也不能插队
    assert.equal(selectDispatchIndex([queued('background'), queued('friend')], [], now), 1);
    // 已经有一个后台请求在飞就不再叠加
    assert.equal(selectDispatchIndex([queued('background')], [{ requestClass: 'background' }], now), -1);
});

test('排队配额按班次独立计算，后台排满也不影响心跳和前台', () => {
    const backgroundFull = Array.from({ length: maxQueuedForClass('background') }, () => queued('background'));

    assert.ok(isClassQueueFull(backgroundFull, 'background'));
    assert.equal(isClassQueueFull(backgroundFull, 'critical'), false);
    assert.equal(isClassQueueFull(backgroundFull, 'foreground'), false);
    // 后台配额刻意留得比前台小得多：排不上就该让路，而不是硬排到超时
    assert.ok(maxQueuedForClass('background') < maxQueuedForClass('foreground'));
    assert.ok(maxQueuedForClass('friend') <= maxQueuedForClass('farm'));
});

test('压力日志标记能区分心跳/ACE 与各业务班次', () => {
    assert.equal(describeRequestClassMarker({ requestClass: 'critical', criticalLane: 'heartbeat' }), '!H:');
    assert.equal(describeRequestClassMarker({ requestClass: 'critical', criticalLane: 'ace' }), '!A:');
    assert.equal(describeRequestClassMarker({ requestClass: 'critical' }), '!');
    assert.equal(describeRequestClassMarker({ requestClass: 'foreground' }), '');
    assert.equal(describeRequestClassMarker({ requestClass: 'farm' }), '#');
    assert.equal(describeRequestClassMarker({ requestClass: 'friend' }), '&');
    assert.equal(describeRequestClassMarker({ requestClass: 'background' }), '~');
});