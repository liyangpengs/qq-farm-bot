const assert = require('node:assert/strict');
const test = require('node:test');

test('a 300-friend scan yields after each friend and stops after the active slice is aborted', async (t) => {
    const runner = require('../dist/app/account-task-runner');
    const store = require('../dist/models/store');
    const network = require('../dist/utils/network');
    const utils = require('../dist/utils/utils');
    const friendApi = require('../dist/services/friend/api');
    const gidManager = require('../dist/services/friend/gid-manager');
    const visitStrategy = require('../dist/services/friend/visit-strategy');
    const schedulerModulePath = require.resolve('../dist/services/friend/scheduler');
    const originals = {
        submitAccountTask: runner.submitAccountTask,
        isAutomationOn: store.isAutomationOn,
        getFriendBlacklist: store.getFriendBlacklist,
        getUserState: network.getUserState,
        randomDelay: utils.randomDelay,
        log: utils.log,
        logWarn: utils.logWarn,
        getAllFriends: friendApi.getAllFriends,
        extractReplyFriends: gidManager.extractReplyFriends,
        inFriendQuietHours: visitStrategy.inFriendQuietHours,
        cacheFriendsListFromReply: visitStrategy.cacheFriendsListFromReply,
        visitFriend: visitStrategy.visitFriend,
    };
    t.after(() => {
        Object.assign(runner, { submitAccountTask: originals.submitAccountTask });
        Object.assign(store, {
            isAutomationOn: originals.isAutomationOn,
            getFriendBlacklist: originals.getFriendBlacklist,
        });
        Object.assign(network, { getUserState: originals.getUserState });
        Object.assign(utils, {
            randomDelay: originals.randomDelay,
            log: originals.log,
            logWarn: originals.logWarn,
        });
        Object.assign(friendApi, { getAllFriends: originals.getAllFriends });
        Object.assign(gidManager, { extractReplyFriends: originals.extractReplyFriends });
        Object.assign(visitStrategy, {
            inFriendQuietHours: originals.inFriendQuietHours,
            cacheFriendsListFromReply: originals.cacheFriendsListFromReply,
            visitFriend: originals.visitFriend,
        });
        delete require.cache[schedulerModulePath];
    });

    const submissions = [];
    const events = [];
    const accountTasks = new runner.AccountTaskRunner();
    runner.submitAccountTask = (name, run, options) => {
        submissions.push({ name, options });
        return accountTasks.submit(name, run, options);
    };
    store.isAutomationOn = key => key === 'friend' || key === 'friend_steal';
    store.getFriendBlacklist = () => [];
    network.getUserState = () => ({ gid: 99, accountId: 'account-1' });
    utils.randomDelay = () => new Promise(resolve => setImmediate(resolve));
    utils.log = () => {};
    utils.logWarn = () => {};
    let listFailure = null;
    friendApi.getAllFriends = async () => {
        if (listFailure) throw listFailure;
        events.push('list');
        return {
            game_friends: Array.from({ length: 300 }, (_, index) => ({
                gid: 10001 + index,
                name: `friend-${10001 + index}`,
                plant: { steal_plant_num: 300 - index },
            })),
        };
    };
    gidManager.extractReplyFriends = reply => reply.game_friends;
    visitStrategy.inFriendQuietHours = () => false;
    visitStrategy.cacheFriendsListFromReply = () => {};
    let releaseFirstVisit;
    let markFirstVisitStarted;
    let releaseSecondVisit;
    let markSecondVisitStarted;
    const firstVisit = new Promise(resolve => {
        releaseFirstVisit = resolve;
    });
    const firstVisitStarted = new Promise(resolve => {
        markFirstVisitStarted = resolve;
    });
    const secondVisit = new Promise(resolve => {
        releaseSecondVisit = resolve;
    });
    const secondVisitStarted = new Promise(resolve => {
        markSecondVisitStarted = resolve;
    });
    visitStrategy.visitFriend = async (friend) => {
        events.push(`visit:${friend.gid}:start`);
        if (friend.gid === 10001) {
            markFirstVisitStarted();
            await firstVisit;
        }
        if (friend.gid === 10002) {
            markSecondVisitStarted();
            await secondVisit;
        }
        events.push(`visit:${friend.gid}:end`);
        return { acted: true, entered: true };
    };

    delete require.cache[schedulerModulePath];
    const { checkFriends } = require(schedulerModulePath);
    const controller = new AbortController();
    const scan = checkFriends({ signal: controller.signal });
    await firstVisitStarted;
    const interactive = accountTasks.submit('api:manual-operation', () => {
        events.push('interactive');
    }, { priority: 'interactive' });
    const farm = accountTasks.submit('farm.check', () => {
        events.push('farm');
    }, { priority: 'scheduled', dedupeKey: 'farm.check' });
    releaseFirstVisit();

    await secondVisitStarted;
    controller.abort();
    releaseSecondVisit();

    assert.equal(await scan, false);
    await Promise.all([interactive, farm]);

    assert.deepEqual(events.slice(0, 7), [
        'list',
        'visit:10001:start',
        'visit:10001:end',
        'interactive',
        'farm',
        'visit:10002:start',
        'visit:10002:end',
    ]);
    assert.equal(submissions.length, 3);
    assert.equal(submissions[0].name, 'friend.phase.get-all-friends');
    assert.equal(submissions[1].name, 'friend.visit:10001');
    assert.equal(submissions.at(-1).name, 'friend.visit:10002');
    assert.ok(submissions.every(item => item.options.priority === 'scheduled'));

    listFailure = new Error('friend list failed');
    assert.equal(await checkFriends(), false);
});
