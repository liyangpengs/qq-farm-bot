const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_CLIENT_VERSION } = require('../dist/config/config');
const { GatewayTokenProvider, createGatewayToken } = require('../dist/utils/gateway-token');
const {
    HEARTBEAT_STALE_AFTER_MS,
    MAX_HEARTBEAT_MISSES,
    shouldTerminateForHeartbeat,
} = require('../dist/utils/keepalive-policy');
const {
    LEGACY_DEFAULT_CLIENT_VERSIONS,
    isManagedDefaultClientVersion,
} = require('../dist/models/store/shared-state');
const {
    compareHandshakeUrls,
    redactHandshakeCode,
} = require('../../tools/analyze-keepalive-capture');

test('official client version is the capture-verified 1.13.2.10 build', () => {
    assert.equal(DEFAULT_CLIENT_VERSION, '1.13.2.10_20260723');
});

test('legacy defaults migrate while explicit custom client versions survive', () => {
    assert.deepEqual(
        [...LEGACY_DEFAULT_CLIENT_VERSIONS],
        ['1.13.2.8_20260723', '1.13.2.9_20260723'],
    );
    assert.equal(isManagedDefaultClientVersion('1.13.2.9_20260723'), true);
    assert.equal(isManagedDefaultClientVersion(DEFAULT_CLIENT_VERSION), true);
    assert.equal(isManagedDefaultClientVersion('custom-client-version'), false);
});

test('ordinary gateway tokens retain the official random format', () => {
    for (let index = 0; index < 256; index += 1) {
        assert.match(createGatewayToken(), /^[A-Za-z0-9]{64,127}=$/);
    }
});

test('the TSDK initialization credential is consumed exactly once', () => {
    const provider = new GatewayTokenProvider();
    const initToken = `${'A'.repeat(150)}==`;

    assert.equal(provider.stageInitToken(initToken), 152);
    assert.equal(provider.next(), initToken);
    assert.match(provider.next(), /^[A-Za-z0-9]{64,127}=$/);

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
