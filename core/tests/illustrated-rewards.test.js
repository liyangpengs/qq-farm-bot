const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const protobuf = require('protobufjs');
const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/illustratedpb.proto'), { keepCase: true });
const types = Object.fromEntries(['GetIllustratedListV2Request', 'GetIllustratedListV2Reply', 'GetIllustratedLevelListV2Request', 'GetIllustratedLevelListV2Reply', 'ClaimAllRewardsV2Request', 'ClaimAllRewardsV2Reply'].map(n => [n, root.lookupType(`gamepb.illustratedpb.${n}`)]));
function harness() {
    let writes = 0;
    let failRefresh = false;
    const requests = [];
    const levels = [{ level: 28, point_condition: 5530, rewards: [{ id: 1002, count: 200 }], claimed: true }, { level: 29, point_condition: 6010, rewards: [{ id: 1002, count: 200 }], can_claim: true }, { level: 30, point_condition: 6520, rewards: [{ id: 1002, count: 200 }] }];
    const mock = (name, exports) => { const id = require.resolve(`../dist/${name}`); require.cache[id] = { id, filename: id, loaded: true, exports }; };
    mock('utils/proto', { types }); mock('utils/utils', { toNum: Number });
    mock('config/gameConfig', { getItemById: id => ({ name: `物品${id}` }), getItemImageById: () => '', getPlantBySeedId: () => null, getPlantByFruitId: () => null, getPlantNameBySeedId: () => '', getIllustratedTypeByParam: () => '', getIllustratedSortByParam: () => 1, getIllustratedBuffsByLevel: () => [], getIllustratedBuffs: () => [], getAllSeeds: () => [] });
    mock('services/farm', { getAvailableSeeds: async () => [] });
    const hooks = {};
    mock('utils/network', { sendMsgAsync: async (_service, method, body, options) => {
        if (method === 'ClaimAllRewardsV2') {
            hooks.beforeSend?.();
            const blocked = options?.beforeSend?.();
            if (blocked) throw blocked;
        }
        const req = types[`${method}Request`].decode(body); requests.push({ method, type: req.type, body });
        let reply;
        if (method === 'ClaimAllRewardsV2') { writes++; levels[1].claimed = true; levels[1].can_claim = false; reply = { total_rewards: [{ id: 1002, count: 200 }], claimed_level_ids: [29], current_level: 29 }; }
        else {
            if (failRefresh && writes) throw new Error('offline');
            reply = method === 'GetIllustratedLevelListV2' ? { current_level: 29, total_progress: 6100, level_list: levels } : { type: req.type, current_level: 29, total_progress: 6100, next_level_progress: 6520, list: [] };
        }
        return { body: types[`${method}Reply`].encode(types[`${method}Reply`].fromObject(reply)).finish() };
    } });
    const id = require.resolve('../dist/services/illustrated'); delete require.cache[id];
    return { service: require(id), levels, requests, hooks, failRefresh: () => { failRefresh = true; }, writes: () => writes };
}
test('illustrated rewards distinguish claimed, claimable and unmet levels', async () => {
    const h = harness();
    const state = (await h.service.getIllustratedSnapshot()).crop;
    assert.equal(state.progress, 6100);
    assert.equal(state.nextLevelProgress, 6520);
    assert.deepEqual(state.levels.map(v => [v.claimed, v.canClaim]), [[true, false], [false, true], [false, false]]);
    assert.equal(state.levels[1].rewards[0].count, 200);
    assert.equal(state.claimable, true);
    assert.equal(h.requests[0].body.toString('hex'), '08001001');
});
test('illustrated claims use the requested book type and reject duplicate/invalid claims', async () => {
    const h = harness();
    await assert.rejects(h.service.claimIllustratedRewards('1'), /类型无效/);
    const result = await h.service.claimIllustratedRewards(2);
    assert.deepEqual(result.claimedLevels, [29]);
    assert.equal(result.rewards[0].itemId, 1002);
    assert.equal(h.requests.find(v => v.method === 'ClaimAllRewardsV2').body.toString('hex'), '0802');
    await assert.rejects(h.service.claimIllustratedRewards(2), /暂无/);
    assert.equal(h.writes(), 1);
});
test('illustrated claim success survives a subsequent refresh failure', async () => {
    const h = harness(); h.failRefresh();
    const result = await h.service.claimIllustratedRewards(1);
    assert.equal(result.refreshRequired, true);
    assert.equal(result.rewards[0].count, 200);
    assert.equal(h.writes(), 1);
});

test('automatic claims check the switch at the actual send point and persist before sending', async () => {
    const h = harness();
    let enabled = true;
    let recorded = false;
    h.hooks.beforeSend = () => { enabled = false; };
    await assert.rejects(h.service.claimIllustratedRewards(1, {
        canContinue: () => enabled, beforeSend: () => { recorded = true; },
    }), /自动领奖已关闭/);
    assert.equal(h.writes(), 0);
    assert.equal(recorded, false);
    h.hooks.beforeSend = () => {};
    enabled = true;
    await h.service.claimIllustratedRewards(1, {
        canContinue: () => enabled,
        beforeSend: levels => { assert.deepEqual(levels, [29]); assert.equal(h.writes(), 0); recorded = true; },
    });
    assert.equal(recorded, true);
    assert.equal(h.writes(), 1);
    assert.equal(await h.service.claimIllustratedRewards(1, { skipUnavailable: true }), null);
});
