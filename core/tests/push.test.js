const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
    buildDingTalkWebhook,
    createDingTalkSign,
} = require('../dist/services/push');

test('buildDingTalkWebhook converts a legacy access token to an official webhook', () => {
    const url = new URL(buildDingTalkWebhook('', 'legacy-token'));

    assert.equal(url.origin, 'https://oapi.dingtalk.com');
    assert.equal(url.pathname, '/robot/send');
    assert.equal(url.searchParams.get('access_token'), 'legacy-token');
});

test('buildDingTalkWebhook keeps a complete webhook address', () => {
    const endpoint = 'https://oapi.dingtalk.com/robot/send?access_token=complete-token';

    assert.equal(buildDingTalkWebhook(endpoint, ''), endpoint);
});

test('buildDingTalkWebhook appends the documented timestamp and signature', () => {
    const endpoint = 'https://oapi.dingtalk.com/robot/send?access_token=signed-token';
    const secret = 'SEC-test-secret';
    const timestamp = 1_700_000_000_000;
    const expectedSign = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${secret}`, 'utf8')
        .digest('base64');
    const url = new URL(buildDingTalkWebhook(endpoint, '', secret, timestamp));

    assert.equal(createDingTalkSign(secret, timestamp), expectedSign);
    assert.equal(url.searchParams.get('timestamp'), String(timestamp));
    assert.equal(url.searchParams.get('sign'), expectedSign);
});

test('buildDingTalkWebhook rejects non-DingTalk endpoints', () => {
    assert.throws(
        () => buildDingTalkWebhook('https://example.com/robot/send?access_token=test', ''),
        /钉钉 Webhook 地址格式无效/,
    );
});
