const assert = require('node:assert/strict');
const test = require('node:test');

test('non QQ VIP claim result is treated as skipped for the rest of the day', async () => {
    const networkPath = require.resolve('../dist/utils/network');
    const protoPath = require.resolve('../dist/utils/proto');
    const utilsPath = require.resolve('../dist/utils/utils');
    const qqvipPath = require.resolve('../dist/services/qqvip');
    const requests = [];
    const logs = [];

    require.cache[networkPath] = {
        id: networkPath,
        filename: networkPath,
        loaded: true,
        exports: {
            sendMsgAsync: async (_serviceName, methodName, _body, options) => {
                requests.push({ methodName, options });
                if (methodName === 'ClaimQQVipRewards') {
                    const error = new Error('gamepb.qqvippb.QQVipService.ClaimQQVipRewards error: code=1021001 non QQ VIP');
                    error.code = 1021001;
                    throw error;
                }
                return { body: Buffer.alloc(0) };
            },
        },
    };
    require.cache[protoPath] = {
        id: protoPath,
        filename: protoPath,
        loaded: true,
        exports: {
            types: {
                RefreshVipInfoRequest: createCodec(),
                RefreshVipInfoReply: createCodec(),
                GetQQVipRewardsStatusRequest: createCodec(),
                GetQQVipRewardsStatusReply: createCodec({
                    reward_statuses: [{ enabled: true, can_claim: true, reward_type: 1 }],
                }),
                ClaimQQVipRewardsRequest: createCodec(),
                ClaimQQVipRewardsReply: createCodec(),
            },
        },
    };
    require.cache[utilsPath] = {
        id: utilsPath,
        filename: utilsPath,
        loaded: true,
        exports: {
            log: (...args) => logs.push(args),
            toNum: value => Number(value) || 0,
            getSystemDateKey: () => '2026-09-01',
        },
    };
    delete require.cache[qqvipPath];

    const { performDailyVipGift, getVipDailyState } = require(qqvipPath);
    assert.equal(await performDailyVipGift(), false);
    assert.deepEqual(requests.map(request => request.methodName), [
        'RefreshVipInfo',
        'GetQQVipRewardsStatus',
        'ClaimQQVipRewards',
    ]);
    assert.deepEqual(requests[2].options.expectedErrorCodes, [1021001, 1021002]);
    const state = getVipDailyState();
    assert.equal(state.doneToday, true);
    assert.equal(state.lastClaimAt, 0);
    assert.equal(state.result, 'none');
    assert.equal(state.hasGift, false);
    assert.equal(state.canClaim, false);
    assert.equal(logs.at(-1)[2].reason, 'not_qq_vip');

    assert.equal(await performDailyVipGift(), false);
    assert.equal(requests.length, 3);
});

function createCodec(decoded = {}) {
    return {
        create: value => value,
        encode: () => ({ finish: () => Buffer.alloc(0) }),
        decode: () => decoded,
    };
}
