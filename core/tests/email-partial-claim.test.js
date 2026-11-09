const assert = require('node:assert/strict');
const test = require('node:test');

const networkPath = require.resolve('../dist/utils/network');
const protoPath = require.resolve('../dist/utils/proto');
const utilsPath = require.resolve('../dist/utils/utils');

const methods = [];
let claimCalls = 0;
const claimable = [
    { id: 'mail-1', has_reward: true, claimed: false },
    { id: 'mail-2', has_reward: true, claimed: false },
];

require.cache[networkPath] = {
    exports: {
        sendMsgAsync: async (_service, method, body) => {
            methods.push(method);
            if (method === 'GetEmailList') {
                const boxType = body && body.box_type;
                return { body: { box_type: boxType } };
            }
            if (method === 'BatchClaimEmail') throw new Error('batch unavailable');
            if (method === 'ClaimEmail') {
                claimCalls += 1;
                if (claimCalls === 2) throw new Error('single claim failed');
            }
            return { body: Buffer.alloc(0) };
        },
    },
};
require.cache[protoPath] = {
    exports: {
        types: {
            GetEmailListRequest: {
                create: value => value,
                encode: value => ({ finish: () => value }),
            },
            GetEmailListReply: {
                // 第一个邮箱返回两封可领取邮件，第二个邮箱为空。
                decode: body => ({ emails: body && body.box_type === 1 ? claimable : [] }),
            },
            BatchClaimEmailRequest: {
                create: value => value,
                encode: () => ({ finish: () => Buffer.alloc(0) }),
            },
            BatchClaimEmailReply: {
                decode: () => ({}),
            },
            ClaimEmailRequest: {
                create: value => value,
                encode: () => ({ finish: () => Buffer.alloc(0) }),
            },
            ClaimEmailReply: {
                decode: () => ({ items: [{ id: 1, count: 5 }] }),
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

const { checkAndClaimEmails, getEmailDailyState, resetEmailClaimStateForTest } = require('../dist/services/email');

test('邮箱部分领取失败会记录为 partial，而不是伪装成全部成功', async () => {
    resetEmailClaimStateForTest();
    methods.length = 0;
    claimCalls = 0;

    const result = await checkAndClaimEmails(false);

    assert.deepEqual(result, { claimed: 1, rewardItems: 1 });
    assert.deepEqual(methods, ['GetEmailList', 'GetEmailList', 'BatchClaimEmail', 'ClaimEmail', 'ClaimEmail']);
    assert.equal(getEmailDailyState().result, 'partial');

    const second = await checkAndClaimEmails(false);
    assert.equal(second.skipped, 'done');
    assert.equal(methods.length, 5, '当天已经触发后不再请求邮箱');
});
