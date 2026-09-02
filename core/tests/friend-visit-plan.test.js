const assert = require('node:assert/strict');
const test = require('node:test');

const { buildFriendVisitPlan } = require('../dist/services/friend/visit-plan');

function friend(gid, extra = {}) {
    const { level = 10, steal = 0, dry = 0, weed = 0, insect = 0, name = `f${gid}` } = extra;
    return {
        gid,
        name,
        level,
        plant: { steal_plant_num: steal, dry_num: dry, weed_num: weed, insect_num: insect },
    };
}

function baseInput(overrides = {}) {
    return {
        friends: [],
        myGid: 999,
        blacklist: new Set(),
        stealEnabled: true,
        helpEnabled: true,
        badEnabled: true,
        helpAllowedForAll: true,
        protectDogBypassEnabled: false,
        getDogState: () => 'unknown',
        badBudget: 10,
        maxBadOnlyVisits: 20,
        ...overrides,
    };
}

test('既能偷又要帮的好友只安排一次访问，三件事在同一次进农场里做完', () => {
    const plan = buildFriendVisitPlan(baseInput({
        friends: [friend(1, { steal: 3, dry: 2 })],
    }));

    assert.equal(plan.visits.length, 1);
    assert.deepEqual(
        { wantSteal: plan.visits[0].wantSteal, wantHelp: plan.visits[0].wantHelp, wantBad: plan.visits[0].wantBad },
        { wantSteal: true, wantHelp: true, wantBad: false },
    );
    assert.equal(plan.stealCount, 1);
    assert.equal(plan.helpCount, 1);
});

test('自己、黑名单、重复 gid 与无事可做的好友都不进农场', () => {
    const plan = buildFriendVisitPlan(baseInput({
        friends: [
            friend(999, { steal: 5 }),
            friend(2, { steal: 5 }),
            friend(2, { steal: 5 }),
            friend(3, { steal: 5 }),
        ],
        blacklist: new Set([3]),
        badEnabled: false,
    }));

    assert.deepEqual(plan.visits.map(item => item.gid), [2]);
});

test('捣乱额度用完就完全不安排捣乱访问', () => {
    const idle = [friend(1, { level: 30 }), friend(2, { level: 20 })];

    assert.equal(buildFriendVisitPlan(baseInput({ friends: idle, badBudget: 0 })).visits.length, 0);
    assert.equal(buildFriendVisitPlan(baseInput({ friends: idle, badEnabled: false })).visits.length, 0);

    const plan = buildFriendVisitPlan(baseInput({ friends: idle }));
    assert.equal(plan.badOnlyCount, 2);
    assert.ok(plan.visits.every(item => item.wantBad));
    // 等级高的先捣乱
    assert.deepEqual(plan.visits.map(item => item.gid), [1, 2]);
});

test('捣乱访问只针对没可偷也没可帮的好友，并有数量上限', () => {
    const friends = [
        friend(1, { steal: 2 }),
        friend(2, { dry: 1 }),
        friend(3, { level: 50 }),
        friend(4, { level: 40 }),
        friend(5, { level: 30 }),
    ];
    const plan = buildFriendVisitPlan(baseInput({ friends, maxBadOnlyVisits: 2 }));

    // 偷/帮的好友排在前面，纯捣乱的排队尾且只取等级最高的两位
    assert.deepEqual(plan.visits.map(item => item.gid), [1, 2, 3, 4]);
    assert.deepEqual(plan.visits.filter(item => item.wantBad).map(item => item.gid), [3, 4]);
});

test('经验满且不开护主犬绕过时，只需要帮忙的好友一个请求都不发', () => {
    const plan = buildFriendVisitPlan(baseInput({
        friends: [friend(1, { dry: 3 }), friend(2, { steal: 1, weed: 2 })],
        helpAllowedForAll: false,
        protectDogBypassEnabled: false,
        badEnabled: false,
    }));

    // 好友 1 只需要帮忙 → 不进农场；好友 2 还能偷 → 照样进，但这次不帮
    assert.deepEqual(plan.visits.map(item => item.gid), [2]);
    assert.equal(plan.visits[0].wantHelp, false);
    assert.equal(plan.visits[0].wantSteal, true);
    assert.equal(plan.skippedExpLimit, 2);
});

test('经验满 + 护主犬绕过开启时，只帮当天缓存已确认是护主犬的好友', () => {
    const dogStates = { 1: 'protect', 2: 'none', 3: 'unknown' };
    const plan = buildFriendVisitPlan(baseInput({
        friends: [friend(1, { dry: 1 }), friend(2, { dry: 1 }), friend(3, { dry: 1 })],
        helpAllowedForAll: false,
        protectDogBypassEnabled: true,
        getDogState: gid => dogStates[gid],
        badEnabled: false,
    }));

    assert.deepEqual(plan.visits.map(item => item.gid), [1]);
    assert.equal(plan.visits[0].wantHelp, true);
    // 宠物还没同步的好友不再逐个进农场试探，交给每日宠物同步补齐
    assert.equal(plan.skippedExpLimit, 2);
    assert.equal(plan.skippedUnknownDog, 1);
});

test('单项开关关闭时对应的操作不会被安排', () => {
    const friends = [friend(1, { steal: 2, dry: 2 })];

    const noSteal = buildFriendVisitPlan(baseInput({ friends, stealEnabled: false }));
    assert.equal(noSteal.visits[0].wantSteal, false);
    assert.equal(noSteal.visits[0].wantHelp, true);

    const noHelp = buildFriendVisitPlan(baseInput({ friends, helpEnabled: false }));
    assert.equal(noHelp.visits[0].wantHelp, false);
    assert.equal(noHelp.visits[0].wantSteal, true);

    const nothing = buildFriendVisitPlan(baseInput({ friends, stealEnabled: false, helpEnabled: false }));
    assert.equal(nothing.visits.length, 0);
});

test('偷得多的好友优先，其次是帮助需求大的', () => {
    const plan = buildFriendVisitPlan(baseInput({
        friends: [
            friend(1, { steal: 1 }),
            friend(2, { steal: 4 }),
            friend(3, { dry: 5, weed: 5 }),
            friend(4, { dry: 1 }),
        ],
        badEnabled: false,
    }));

    assert.deepEqual(plan.visits.map(item => item.gid), [2, 1, 3, 4]);
});