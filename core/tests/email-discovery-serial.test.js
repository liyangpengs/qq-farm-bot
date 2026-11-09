const assert = require('node:assert/strict');
const test = require('node:test');

const networkPath = require.resolve('../dist/utils/network');
const protoPath = require.resolve('../dist/utils/proto');
const utilsPath = require.resolve('../dist/utils/utils');

let activeCount = 0;
let maxActiveCount = 0;
const methods = [];

require.cache[networkPath] = {
    exports: {
        sendMsgAsync: async (_service, method) => {
            activeCount += 1;
            maxActiveCount = Math.max(maxActiveCount, activeCount);
            await new Promise(resolve => setImmediate(resolve));
            methods.push(method);
            activeCount -= 1;
            return { body: Buffer.alloc(0) };
        },
    },
};
require.cache[protoPath] = {
    exports: {
        types: {
            GetEmailListRequest: {
                create: () => ({}),
                encode: () => ({ finish: () => Buffer.alloc(0) }),
            },
            GetEmailListReply: {
                decode: () => ({ emails: [] }),
            },
        },
    },
};
require.cache[utilsPath] = {
    exports: {
        log: () => {},
        toNum: value => Number(value) || 0,
        getSystemDateKey: () => 'test',
        getServerTimeSec: () => Math.floor(Date.now() / 1000),
        getSystemClockMinutes: () => 600,
    },
};

const { checkAndClaimEmails, resetEmailClaimStateForTest } = require('../dist/services/email');

test('邮箱两个列表串行发现，不叠加网关请求', async () => {
    resetEmailClaimStateForTest();
    await checkAndClaimEmails(true);

    assert.equal(maxActiveCount, 1);
    assert.deepEqual(methods, ['GetEmailList', 'GetEmailList']);
});

test('邮箱领取一天只触发一次，第二次直接跳过', async () => {
    resetEmailClaimStateForTest();
    methods.length = 0;

    await checkAndClaimEmails(false);
    assert.equal(methods.length, 2);

    await checkAndClaimEmails(false);
    assert.equal(methods.length, 2, '当天已触发后不再请求邮箱列表');
});
