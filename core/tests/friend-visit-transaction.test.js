const assert = require('node:assert/strict');
const test = require('node:test');

test('friend visits always leave after a successful enter', async (t) => {
    const store = require('../dist/models/store');
    const farm = require('../dist/services/farm');
    const friendApi = require('../dist/services/friend/api');
    const visitStrategyPath = require.resolve('../dist/services/friend/visit-strategy');
    const originals = {
        isAutomationOn: store.isAutomationOn,
        getPlantBlacklist: store.getPlantBlacklist,
        getCurrentPhase: farm.getCurrentPhase,
        enterFriendFarm: friendApi.enterFriendFarm,
        leaveFriendFarm: friendApi.leaveFriendFarm,
    };

    t.after(() => {
        Object.assign(store, {
            isAutomationOn: originals.isAutomationOn,
            getPlantBlacklist: originals.getPlantBlacklist,
        });
        Object.assign(farm, { getCurrentPhase: originals.getCurrentPhase });
        Object.assign(friendApi, {
            enterFriendFarm: originals.enterFriendFarm,
            leaveFriendFarm: originals.leaveFriendFarm,
        });
        delete require.cache[visitStrategyPath];
    });

    const events = [];
    store.isAutomationOn = key => key === 'friend_bad';
    store.getPlantBlacklist = () => [];
    farm.getCurrentPhase = () => {
        throw new Error('land analysis failed');
    };
    friendApi.enterFriendFarm = async (gid) => {
        events.push(`enter:${gid}`);
        return { lands: [{ id: 1, plant: { phases: [{}] } }] };
    };
    friendApi.leaveFriendFarm = async (gid) => {
        events.push(`leave:${gid}`);
    };

    delete require.cache[visitStrategyPath];
    const { visitFriend } = require(visitStrategyPath);

    await assert.rejects(
        visitFriend(
            { gid: 101, name: 'friend-101' },
            { steal: 0, farming: 0, putBug: 0, putWeed: 0 },
            999,
            'account-1',
        ),
        /land analysis failed/,
    );
    assert.deepEqual(events, ['enter:101', 'leave:101']);
});
