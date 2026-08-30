const assert = require('node:assert/strict');
const test = require('node:test');

test('friend list reads share in-flight work and a short successful-result cache', async (t) => {
    const config = require('../dist/config/config');
    const network = require('../dist/utils/network');
    const proto = require('../dist/utils/proto');
    const apiModulePath = require.resolve('../dist/services/friend/api');
    const originalPlatform = config.CONFIG.platform;
    const originalSendMsgAsync = network.sendMsgAsync;
    const originalRequestType = proto.types.GetAllFriendsRequest;
    const originalReplyType = proto.types.GetAllFriendsReply;
    const originalNow = Date.now;
    let now = 1000;
    let calls = 0;
    let releaseFirst;
    const firstReply = new Promise(resolve => {
        releaseFirst = resolve;
    });

    config.CONFIG.platform = 'wx';
    Date.now = () => now;
    proto.types.GetAllFriendsRequest = {
        create: value => value,
        encode: () => ({ finish: () => Buffer.alloc(0) }),
    };
    proto.types.GetAllFriendsReply = {
        decode: () => ({ game_friends: [{ gid: calls }] }),
    };
    network.sendMsgAsync = async () => {
        calls += 1;
        if (calls === 1) await firstReply;
        return { body: Buffer.alloc(0) };
    };
    delete require.cache[apiModulePath];
    const friendApi = require(apiModulePath);

    t.after(() => {
        friendApi.clearAllFriendsCache();
        config.CONFIG.platform = originalPlatform;
        network.sendMsgAsync = originalSendMsgAsync;
        if (originalRequestType) proto.types.GetAllFriendsRequest = originalRequestType;
        else delete proto.types.GetAllFriendsRequest;
        if (originalReplyType) proto.types.GetAllFriendsReply = originalReplyType;
        else delete proto.types.GetAllFriendsReply;
        Date.now = originalNow;
        delete require.cache[apiModulePath];
    });

    const first = friendApi.getAllFriends();
    const concurrent = friendApi.getAllFriends();
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    releaseFirst();
    const firstResult = await first;
    const concurrentResult = await concurrent;
    assert.strictEqual(firstResult, concurrentResult);

    const cached = await friendApi.getAllFriends();
    assert.equal(calls, 1);
    assert.strictEqual(cached, firstResult);

    now += friendApi.ALL_FRIENDS_CACHE_TTL_MS;
    await friendApi.getAllFriends();
    assert.equal(calls, 2);

    friendApi.clearAllFriendsCache();
    await friendApi.getAllFriends();
    assert.equal(calls, 3);

    await friendApi.getAllFriends(true);
    assert.equal(calls, 4);
});
