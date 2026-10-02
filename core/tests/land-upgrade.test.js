const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLandUpgradeDetail } = require('../dist/services/farm/land-upgrade');

test('land 21 keeps the exact server level and currency conditions and compares gold to crystal bonuses', () => {
    const info = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 5,
        buff: { plant_yield_bonus: 30000, planting_time_reduction: 2000, plant_exp_bonus: 2000 },
        upgrade_condition: { condition_type: 1, condition_value: 150,
            required_items: [{ id: 1001, count: '450000000' }, { id: 1005, count: '18670' }] } });
    assert.equal(info.needLevel, 150);
    assert.deepEqual(info.costs.map(c => [c.id, c.count]), [['1001', '450000000'], ['1005', '18670']]);
    assert.equal(info.current.expBonus, 20);
    assert.equal(info.next.expBonus, 25);
    assert.equal(info.next.mutantMultiplier, 1.2);
    assert.equal(info.next.resonanceBonus, 25);
    assert.equal(info.unknown, false);
});

test('max level does not show upgrade costs; server bonuses override static defaults', () => {
    const info = buildLandUpgradeDetail({ unlocked: true, level: 5, max_level: 5, buff: { plant_exp_bonus: 5000 } });
    assert.equal(info.mode, 'max');
    assert.equal(info.current.expBonus, 50);
    assert.equal(info.next, null);
    assert.deepEqual(info.costs, []);
});

test('unlocking shows prerequisite land and exact price instead of upgrade requirements', () => {
    const raw = { id: 8, unlocked: false, unlock_condition: { preceding_land_id: 7, need_level: 10, need_gold: 100000 } };
    const info = buildLandUpgradeDetail(raw, new Map([[7, { unlocked: true }]]));
    assert.equal(info.mode, 'unlock');
    assert.equal(info.needLevel, 10);
    assert.equal(info.prerequisite.met, true);
    assert.equal(info.costs[0].count, '100000');
    assert.equal(buildLandUpgradeDetail(raw).prerequisite.met, false);
});

test('unknown server condition types stay unknown; known official fallback does not imply upgrade permission', () => {
    const info = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 5,
        upgrade_condition: { condition_type: 99, condition_value: 150, required_items: [] } });
    assert.equal(info.unknown, true);
    assert.equal(info.needLevel, null);
    const fallback = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 5 });
    assert.equal(fallback.needLevel, 150);
    assert.equal(fallback.serverAllowed, false);
    assert.equal(fallback.costs[1].count, '18670');
});
