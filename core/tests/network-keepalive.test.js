const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_CLIENT_VERSION,
    DEFAULT_CLIENT_VERSION_UPDATED_AT,
    resolveClientVersion,
    resolveClientVersionUpdatedAt,
} = require('../dist/config/config');
const { GatewayTokenProvider, createGatewayToken } = require('../dist/utils/gateway-token');
const {
    HEARTBEAT_STALE_AFTER_MS,
    MAX_HEARTBEAT_MISSES,
    shouldTerminateForHeartbeat,
} = require('../dist/utils/keepalive-policy');
const {
    REQUEST_PRESSURE_LOG_INTERVAL_MS,
    countBlockingQueuedRequests,
    shouldLogRequestPressure,
} = require('../dist/utils/request-pressure');
const {
    compareHandshakeUrls,
    redactHandshakeCode,
} = require('../../tools/analyze-keepalive-capture');

test('default client version has a release timestamp', () => {
    assert.equal(DEFAULT_CLIENT_VERSION, '1.13.3.16_20260826');
    assert.equal(DEFAULT_CLIENT_VERSION_UPDATED_AT, 1788238800000);
});

test('newer timestamp wins when resolving the client version', () => {
    const older = DEFAULT_CLIENT_VERSION_UPDATED_AT - 1;
    const newer = DEFAULT_CLIENT_VERSION_UPDATED_AT + 1;
    assert.deepEqual(resolveClientVersion('stored-without-time', undefined), {
        clientVersion: DEFAULT_CLIENT_VERSION,
        clientVersionUpdatedAt: DEFAULT_CLIENT_VERSION_UPDATED_AT,
    });
    assert.deepEqual(resolveClientVersion('stored-older', older), {
        clientVersion: DEFAULT_CLIENT_VERSION,
        clientVersionUpdatedAt: DEFAULT_CLIENT_VERSION_UPDATED_AT,
    });
    assert.deepEqual(resolveClientVersion('stored-equal', DEFAULT_CLIENT_VERSION_UPDATED_AT), {
        clientVersion: DEFAULT_CLIENT_VERSION,
        clientVersionUpdatedAt: DEFAULT_CLIENT_VERSION_UPDATED_AT,
    });
    assert.deepEqual(resolveClientVersion('stored-newer', newer), {
        clientVersion: 'stored-newer',
        clientVersionUpdatedAt: newer,
    });
});

test('client version timestamp changes only when the version changes', () => {
    const currentUpdatedAt = DEFAULT_CLIENT_VERSION_UPDATED_AT + 10;
    const now = currentUpdatedAt + 20;
    assert.equal(
        resolveClientVersionUpdatedAt('same', 'same', currentUpdatedAt, undefined, now),
        currentUpdatedAt,
    );
    assert.equal(
        resolveClientVersionUpdatedAt('changed', 'same', currentUpdatedAt, undefined, now),
        now,
    );
    assert.equal(
        resolveClientVersionUpdatedAt('default', 'custom', currentUpdatedAt, DEFAULT_CLIENT_VERSION_UPDATED_AT, now),
        DEFAULT_CLIENT_VERSION_UPDATED_AT,
    );
});

test('ordinary gateway tokens retain the official random format', () => {
    for (let index = 0; index < 256; index += 1) {
        assert.match(createGatewayToken(), /^[A-Z0-9]{64,127}=$/i);
    }
});

test('the TSDK initialization credential is consumed exactly once', () => {
    const provider = new GatewayTokenProvider();
    const initToken = `${'A'.repeat(150)}==`;

    assert.equal(provider.stageInitToken(initToken), 152);
    assert.equal(provider.next(), initToken);
    assert.match(provider.next(), /^[A-Z0-9]{64,127}=$/i);

    provider.stageInitToken(initToken);
    provider.clear();
    assert.notEqual(provider.next(), initToken);
});

test('invalid TSDK initialization credentials are rejected', () => {
    const provider = new GatewayTokenProvider();
    assert.throws(() => provider.stageInitToken('token with spaces'), /格式无效/);
});

test('heartbeat policy tolerates transient stalls but terminates a stale connection', () => {
    assert.equal(MAX_HEARTBEAT_MISSES, 3);
    assert.equal(HEARTBEAT_STALE_AFTER_MS, 30000);
    assert.equal(shouldTerminateForHeartbeat(2, 120000), false);
    assert.equal(shouldTerminateForHeartbeat(3, 30000), false);
    assert.equal(shouldTerminateForHeartbeat(3, 30001), true);
    assert.equal(shouldTerminateForHeartbeat(8, 1000), false);
});

test('handshake comparison removes only Code and compares every other URL byte', () => {
    const first = 'wss://example.test/prod/ws?platform=qq&code=first&ver=1.13.2.10&extra=A%2FB';
    const second = 'wss://example.test/prod/ws?platform=qq&code=second&ver=1.13.2.10&extra=A%2FB';
    const changed = 'wss://example.test/prod/ws?platform=qq&code=third&ver=1.13.2.10&extra=A%2Fb';

    assert.equal(
        redactHandshakeCode(first),
        'wss://example.test/prod/ws?platform=qq&code=[REDACTED]&ver=1.13.2.10&extra=A%2FB',
    );
    assert.deepEqual(compareHandshakeUrls([first, second]), {
        count: 2,
        distinctUrlsIgnoringCode: 1,
        identicalExceptCode: true,
        distinctCodes: 2,
        allCodesPresentAndDistinct: true,
    });
    assert.equal(compareHandshakeUrls([first, changed]).identicalExceptCode, false);
});

test('a background only backlog is not reported as gateway pressure', () => {
    const backgroundOnly = [{ requestClass: 'background' }, { requestClass: 'background' }, { requestClass: 'background' }];

    assert.equal(countBlockingQueuedRequests(backgroundOnly), 0);
    assert.equal(shouldLogRequestPressure(backgroundOnly, 60000, 0), false);
    assert.equal(shouldLogRequestPressure([], 60000, 0), false);
});

test('undispatchable requests are reported once per throttle window', () => {
    const queue = [{ requestClass: 'background' }, { requestClass: 'farm' }, { requestClass: 'critical' }];

    assert.equal(REQUEST_PRESSURE_LOG_INTERVAL_MS, 5000);
    assert.equal(countBlockingQueuedRequests(queue), 2);
    assert.equal(shouldLogRequestPressure(queue, 20000, 0), true);
    assert.equal(shouldLogRequestPressure(queue, 20000, 20000 - REQUEST_PRESSURE_LOG_INTERVAL_MS), true);
    assert.equal(shouldLogRequestPressure(queue, 20000, 20001 - REQUEST_PRESSURE_LOG_INTERVAL_MS), false);
});
