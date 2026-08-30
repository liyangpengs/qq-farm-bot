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

test('a friend needing steal and help is visited once with both actions', () => {
    const plan = buildFriendVisitPlan(baseInput({
        friends: [friend(1, { steal: 3, dry: 2 })],
    }));

    assert.equal(plan.visits.length, 1);
    assert.deepEqual(
        {
            wantSteal: plan.visits[0].wantSteal,
            wantHelp: plan.visits[0].wantHelp,
            wantBad: plan.visits[0].wantBad,
        },
        { wantSteal: true, wantHelp: true, wantBad: false },
    );
});

test('self, blacklisted, duplicate and idle friends are excluded', () => {
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

test('bad-only visits require budget and use the configured high-level cap', () => {
    const idle = [
        friend(1, { level: 30 }),
        friend(2, { level: 20 }),
        friend(3, { level: 10 }),
    ];

    assert.equal(buildFriendVisitPlan(baseInput({ friends: idle, badBudget: 0 })).visits.length, 0);
    const plan = buildFriendVisitPlan(baseInput({ friends: idle, maxBadOnlyVisits: 2 }));
    assert.deepEqual(plan.visits.map(item => item.gid), [1, 2]);
    assert.ok(plan.visits.every(item => item.wantBad));
});

test('bad-only work never piggybacks on steal or help targets', () => {
    const plan = buildFriendVisitPlan(baseInput({
        friends: [
            friend(1, { steal: 2 }),
            friend(2, { dry: 1 }),
            friend(3, { level: 50 }),
        ],
    }));

    assert.deepEqual(plan.visits.map(item => item.gid), [1, 2, 3]);
    assert.equal(plan.visits[0].wantBad, false);
    assert.equal(plan.visits[1].wantBad, false);
    assert.equal(plan.visits[2].wantBad, true);
});

test('help-only friends are skipped at the experience limit unless a protect dog is known', () => {
    const dogStates = { 1: 'protect', 2: 'other', 3: 'unknown' };
    const plan = buildFriendVisitPlan(baseInput({
        friends: [
            friend(1, { dry: 1 }),
            friend(2, { dry: 1 }),
            friend(3, { dry: 1 }),
            friend(4, { steal: 1, dry: 1 }),
        ],
        helpAllowedForAll: false,
        protectDogBypassEnabled: true,
        getDogState: gid => dogStates[gid] || 'other',
        badEnabled: false,
    }));

    assert.deepEqual(plan.visits.map(item => item.gid), [4, 1]);
    assert.equal(plan.visits[0].wantHelp, false);
    assert.equal(plan.visits[0].wantSteal, true);
    assert.equal(plan.visits[1].wantHelp, true);
    assert.equal(plan.skippedExpLimit, 3);
    assert.equal(plan.skippedUnknownDog, 1);
});

test('single-operation modes only schedule their selected operation', () => {
    const friends = [friend(1, { steal: 2, dry: 2 })];

    const noSteal = buildFriendVisitPlan(baseInput({ friends, stealEnabled: false }));
    assert.equal(noSteal.visits[0].wantSteal, false);
    assert.equal(noSteal.visits[0].wantHelp, true);

    const noHelp = buildFriendVisitPlan(baseInput({ friends, helpEnabled: false }));
    assert.equal(noHelp.visits[0].wantHelp, false);
    assert.equal(noHelp.visits[0].wantSteal, true);
});

test('steal count sorts first, followed by help count and level', () => {
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
