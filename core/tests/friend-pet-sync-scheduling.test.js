const assert = require('node:assert/strict');
const test = require('node:test');

test('friend pet synchronization keeps list reads outside the account queue and queues each visit', async (t) => {
    const runner = require('../dist/app/account-task-runner');
    const store = require('../dist/models/store');
    const network = require('../dist/utils/network');
    const utils = require('../dist/utils/utils');
    const friendApi = require('../dist/services/friend/api');
    const gidManager = require('../dist/services/friend/gid-manager');
    const petCache = require('../dist/services/friend/pet-cache');
    const visitStrategy = require('../dist/services/friend/visit-strategy');
    const petSyncModulePath = require.resolve('../dist/services/friend/pet-sync');
    const originals = {
        submitAccountTask: runner.submitAccountTask,
        isAutomationOn: store.isAutomationOn,
        getFriendBlacklist: store.getFriendBlacklist,
        getUserState: network.getUserState,
        sleep: utils.sleep,
        log: utils.log,
        logWarn: utils.logWarn,
        getAllFriends: friendApi.getAllFriends,
        enterFriendFarm: friendApi.enterFriendFarm,
        leaveFriendFarm: friendApi.leaveFriendFarm,
        extractReplyFriends: gidManager.extractReplyFriends,
        getInvalidKnownFriendGidSet: gidManager.getInvalidKnownFriendGidSet,
        isFriendDogKnownToday: petCache.isFriendDogKnownToday,
        isFullSyncDoneToday: petCache.isFullSyncDoneToday,
        markFullSyncDone: petCache.markFullSyncDone,
        getFriendPetCacheStats: petCache.getFriendPetCacheStats,
        getFreshFriendsListCacheOnly: visitStrategy.getFreshFriendsListCacheOnly,
        inFriendQuietHours: visitStrategy.inFriendQuietHours,
        handleFriendEnterError: visitStrategy.handleFriendEnterError,
    };
    t.after(() => {
        Object.assign(runner, { submitAccountTask: originals.submitAccountTask });
        Object.assign(store, {
            isAutomationOn: originals.isAutomationOn,
            getFriendBlacklist: originals.getFriendBlacklist,
        });
        Object.assign(network, { getUserState: originals.getUserState });
        Object.assign(utils, {
            sleep: originals.sleep,
            log: originals.log,
            logWarn: originals.logWarn,
        });
        Object.assign(friendApi, {
            getAllFriends: originals.getAllFriends,
            enterFriendFarm: originals.enterFriendFarm,
            leaveFriendFarm: originals.leaveFriendFarm,
        });
        Object.assign(gidManager, {
            extractReplyFriends: originals.extractReplyFriends,
            getInvalidKnownFriendGidSet: originals.getInvalidKnownFriendGidSet,
        });
        Object.assign(petCache, {
            isFriendDogKnownToday: originals.isFriendDogKnownToday,
            isFullSyncDoneToday: originals.isFullSyncDoneToday,
            markFullSyncDone: originals.markFullSyncDone,
            getFriendPetCacheStats: originals.getFriendPetCacheStats,
        });
        Object.assign(visitStrategy, {
            inFriendQuietHours: originals.inFriendQuietHours,
            handleFriendEnterError: originals.handleFriendEnterError,
        });
        if (originals.getFreshFriendsListCacheOnly === undefined) {
            delete visitStrategy.getFreshFriendsListCacheOnly;
        } else {
            visitStrategy.getFreshFriendsListCacheOnly = originals.getFreshFriendsListCacheOnly;
        }
        delete require.cache[petSyncModulePath];
    });

    const submissions = [];
    const visits = [];
    let listReads = 0;
    runner.submitAccountTask = async (name, run, options) => {
        submissions.push({ name, options });
        return run();
    };
    store.isAutomationOn = () => true;
    store.getFriendBlacklist = () => [];
    network.getUserState = () => ({ gid: 99 });
    utils.sleep = async () => {};
    utils.log = () => {};
    utils.logWarn = () => {};
    friendApi.getAllFriends = async () => {
        listReads += 1;
        return { game_friends: [
            { gid: 11, name: 'friend-11' },
            { gid: 12, name: 'friend-12' },
        ] };
    };
    friendApi.enterFriendFarm = async (gid) => {
        visits.push(`enter:${gid}`);
        return {};
    };
    friendApi.leaveFriendFarm = async (gid) => {
        visits.push(`leave:${gid}`);
    };
    gidManager.extractReplyFriends = reply => reply.game_friends;
    gidManager.getInvalidKnownFriendGidSet = () => new Set();
    petCache.isFriendDogKnownToday = () => false;
    petCache.isFullSyncDoneToday = () => false;
    petCache.markFullSyncDone = () => {};
    petCache.getFriendPetCacheStats = () => ({ known: 2, protect: 0 });
    visitStrategy.getFreshFriendsListCacheOnly = () => [];
    visitStrategy.inFriendQuietHours = () => false;
    visitStrategy.handleFriendEnterError = () => ({ handled: false, kind: '' });

    delete require.cache[petSyncModulePath];
    const { runFriendPetSync } = require(petSyncModulePath);
    const result = await runFriendPetSync();

    assert.equal(result.outcome, 'synced');
    assert.deepEqual(submissions.map(entry => entry.name), [
        'friend.pet-sync:11',
        'friend.pet-sync:12',
    ]);
    assert.deepEqual(submissions.map(entry => entry.options.priority), [
        'maintenance',
        'maintenance',
    ]);
    assert.deepEqual(visits, ['enter:11', 'leave:11', 'enter:12', 'leave:12']);
    assert.equal(listReads, 1);

    visitStrategy.getFreshFriendsListCacheOnly = () => [{ gid: 13, name: 'friend-13' }];
    const cachedResult = await runFriendPetSync();

    assert.equal(cachedResult.outcome, 'synced');
    assert.equal(listReads, 1);
    assert.equal(submissions.at(-1).name, 'friend.pet-sync:13');
    assert.deepEqual(visits.slice(-2), ['enter:13', 'leave:13']);
});

test('fresh friend list cache excludes entries after its configured TTL', (t) => {
    const store = require('../dist/models/store');
    const visitStrategy = require('../dist/services/friend/visit-strategy');
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    t.after(() => {
        Date.now = originalNow;
        visitStrategy.clearFriendsListCache();
    });

    visitStrategy.cacheFriendsListFromReply({
        game_friends: [{ gid: 11, name: 'friend-11' }],
    });
    assert.deepEqual(visitStrategy.getFreshFriendsListCacheOnly().map(friend => friend.gid), [11]);

    const configuredTtlMs = Number(store.getFriendsListCacheTtlSec()) * 1000;
    const ttlMs = Number.isFinite(configuredTtlMs) && configuredTtlMs > 0
        ? Math.max(10 * 1000, configuredTtlMs)
        : 60 * 1000;
    now += ttlMs;

    assert.deepEqual(visitStrategy.getFreshFriendsListCacheOnly(), []);
});
