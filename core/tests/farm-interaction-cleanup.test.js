const assert = require('node:assert/strict');
const test = require('node:test');

const { loadProto, types } = require('../dist/utils/proto');
const {
    analyzeLands,
    buildLandDetail,
    getCleanableFarmSocialEventItemIds,
} = require('../dist/services/farm/land-analysis');
const { getMutantEffectById } = require('../dist/config/gameConfig');
const {
    analyzeFriendLands,
} = require('../dist/services/friend/visit-strategy');

function growingLand(id, itemId = 0, status = {}) {
    const now = Math.floor(Date.now() / 1000);
    return {
        id,
        unlocked: true,
        plant: {
            id: 100001,
            phases: [
                { phase: 2, begin_time: now - 60 },
                { phase: 6, begin_time: now + 3600 },
            ],
            interaction_uses: itemId > 0 ? [{ item_id: itemId }] : [],
            interaction_targets: itemId > 0 ? [{ item_id: itemId, land_id: id }] : [],
            ...status,
        },
    };
}

test('own farm cleanup selects golden beetles, footballs and active clouds only', () => {
    const status = analyzeLands([
        growingLand(1, 301101),
        growingLand(2, 301102),
        growingLand(3, 301103),
        growingLand(4, 5006),
    ], false, 9001);

    assert.deepEqual(status.needInteractionCleanup, [1, 2, 4]);
    assert.deepEqual(status.needWeed, []);
    assert.deepEqual(status.needBug, []);
    assert.deepEqual(status.needWater, []);
});

test('friend help does not treat golden beetles or footballs as help targets', () => {
    const status = analyzeFriendLands([
        growingLand(1, 301101),
        growingLand(2, 301102),
        growingLand(3, 5006),
    ], 9002);

    assert.deepEqual(status.needWeed, []);
    assert.deepEqual(status.needBug, []);
    assert.deepEqual(status.needWater, []);
});

test('ordinary watering, weeding and bug removal targets stay unchanged', () => {
    const land = growingLand(3, 0, {
        dry_num: 1,
        weed_owners: [8001],
        insect_owners: [8002],
    });
    const ownStatus = analyzeLands([land], false, 9001);
    const friendStatus = analyzeFriendLands([land], 9002);

    assert.deepEqual(ownStatus.needWater, [3]);
    assert.deepEqual(ownStatus.needWeed, [3]);
    assert.deepEqual(ownStatus.needBug, [3]);
    assert.deepEqual(friendStatus.needWater, [3]);
    assert.deepEqual(friendStatus.needWeed, [3]);
    assert.deepEqual(friendStatus.needBug, [3]);
});

test('qixi mutation uses official effect_name while keeping drought independent', () => {
    assert.equal(getMutantEffectById(1).icon, 'frozen');
    const effect = getMutantEffectById(13);
    assert.equal(effect.name, '喜鹊');
    assert.equal(effect.activityId, 2026081801);
    assert.equal(effect.description, '特殊活动变异，收获时可额外获得鹊羽。');

    const detail = buildLandDetail(growingLand(21, 0, {
        dry_num: 1,
        mutant_config_ids: [13],
        field_40: [
            { value_1: 2, value_2: 2 },
            { value_1: 10, value_2: 1 },
            { value_1: 1, value_2: 1 },
        ],
    }));

    assert.equal(detail.needWater, true);
    assert.deepEqual(detail.mutantEffects.map(item => item.name), ['喜鹊']);
    assert.deepEqual(detail.interactionEffects.map(item => item.itemId), ['301103']);
    assert.equal(detail.interactionEffects[0].activityId, effect.activityId);
});

test('crystal mutation uses the latest official effect_name mapping', () => {
    const effect = getMutantEffectById(14);
    assert.equal(effect.name, '晶辉');
    assert.equal(effect.icon, 'crystal');
    assert.equal(effect.description, '紫晶土地上随机出现');

    const detail = buildLandDetail(growingLand(14, 0, {
        mutant_config_ids: [14],
        extended_mutations: [
            { timestamp: 1787730000, mutant_config_id: 14 },
        ],
    }));

    assert.deepEqual(detail.mutantConfigIds, ['14']);
    assert.deepEqual(detail.mutantEffects.map(item => item.name), ['晶辉']);
});

test('purple crystal resonance follows the server land exp buff', () => {
    const purpleCrystalLand = {
        ...growingLand(14, 0, { mutant_config_ids: [12] }),
        level: 5,
        buff: {
            plant_yield_bonus: 3000,
            planting_time_reduction: 1500,
            plant_exp_bonus: 2500,
        },
    };
    const detail = buildLandDetail(purpleCrystalLand);

    assert.deepEqual(detail.landBuff, {
        plantYieldBonus: 3000,
        plantingTimeReduction: 1500,
        plantExpBonus: 2500,
    });
    assert.equal(detail.purpleCrystalResonanceExpBonus, 2500);

    const adjustedByServer = buildLandDetail({
        ...purpleCrystalLand,
        buff: { ...purpleCrystalLand.buff, plant_exp_bonus: 1800 },
    });
    assert.equal(adjustedByServer.purpleCrystalResonanceExpBonus, 1800);

    const disabledByServer = buildLandDetail({
        ...purpleCrystalLand,
        buff: { ...purpleCrystalLand.buff, plant_exp_bonus: 0 },
    });
    assert.equal(disabledByServer.purpleCrystalResonanceExpBonus, 0);

    const noMutation = buildLandDetail({
        ...purpleCrystalLand,
        plant: { ...purpleCrystalLand.plant, mutant_config_ids: [] },
    });
    assert.equal(noMutation.purpleCrystalResonanceExpBonus, 0);

    const goldenLand = buildLandDetail({ ...purpleCrystalLand, level: 4 });
    assert.equal(goldenLand.purpleCrystalResonanceExpBonus, 0);
});

test('field 40 history does not restore cleared golden beetles or footballs', () => {
    const clearedGoldenHistoryLand = growingLand(15, 0, {
        field_40: [
            { value_1: 1, value_2: 3 },
            { value_1: 2, value_2: 1 },
        ],
    });
    const clearedFootballHistoryLand = growingLand(16, 0, {
        field_40: [
            { value_1: 1, value_2: 2 },
            { value_1: 2, value_2: 2 },
        ],
    });
    const activeFootballLand = growingLand(23, 301102, {
        field_40: [
            { value_1: 2, value_2: 2 },
            { value_1: 1, value_2: 1 },
        ],
    });
    const activeGoldenTargetOnlyLand = growingLand(24, 0, {
        interaction_targets: [{ item_id: 301101, land_id: 24 }],
        field_40: [
            { value_1: 1, value_2: 3 },
            { value_1: 2, value_2: 1 },
        ],
    });
    const clearedCloudHistoryLand = growingLand(25, 0, {
        field_40: [{ value_1: 8, value_2: 1 }],
    });

    assert.deepEqual(buildLandDetail(clearedGoldenHistoryLand).interactionEffects, []);
    assert.deepEqual(buildLandDetail(clearedFootballHistoryLand).interactionEffects, []);
    assert.deepEqual(
        buildLandDetail(activeFootballLand).interactionEffects.map(item => item.itemId),
        ['301102'],
    );
    assert.deepEqual(
        buildLandDetail(activeGoldenTargetOnlyLand).interactionEffects.map(item => item.itemId),
        ['301101'],
    );
    assert.deepEqual(buildLandDetail(clearedCloudHistoryLand).interactionEffects, []);
    assert.deepEqual(
        analyzeLands([
            clearedGoldenHistoryLand,
            clearedFootballHistoryLand,
            activeFootballLand,
            activeGoldenTargetOnlyLand,
            clearedCloudHistoryLand,
        ], false, 9001)
            .needInteractionCleanup,
        [23, 24],
    );
});

test('qixi dew fallback requires both its captured history code and mutation 13', () => {
    const confirmedNineLand = growingLand(5, 0, {
        mutant_config_ids: [13],
        field_40: [{ value_1: 9, value_2: 1 }],
    });
    const confirmedTenLand = growingLand(12, 0, {
        mutant_config_ids: [13],
        field_40: [{ value_1: 10, value_2: 1 }],
    });
    const historyWithoutMutationLand = growingLand(6, 0, {
        field_40: [{ value_1: 10, value_2: 1 }],
    });
    const mutationWithoutHistoryLand = growingLand(22, 0, {
        mutant_config_ids: [13],
    });

    assert.deepEqual(buildLandDetail(confirmedNineLand).interactionEffects.map(item => item.itemId), ['301103']);
    assert.deepEqual(buildLandDetail(confirmedTenLand).interactionEffects.map(item => item.itemId), ['301103']);
    assert.deepEqual(buildLandDetail(historyWithoutMutationLand).interactionEffects, []);
    assert.deepEqual(buildLandDetail(mutationWithoutHistoryLand).interactionEffects, []);
});

test('own Farming request keeps the two explicit zero-valued scene fields', async () => {
    await loadProto();
    const { encodeOwnFarmingRequest } = require('../dist/services/farm/api');
    const body = encodeOwnFarmingRequest([8, 15], 1234);
    const decoded = types.FarmingRequest.decode(body);

    assert.deepEqual(Array.from(decoded.land_ids, value => Number(value)), [8, 15]);
    assert.equal(Number(decoded.host_gid), 1234);
    assert.deepEqual(Array.from(body.slice(-4)), [0x18, 0x00, 0x20, 0x00]);

    const repeatedField40Reply = types.AllLandsReply.decode(Buffer.from(
        '0a10520ec2020408011003c2020408021001',
        'hex',
    ));
    assert.deepEqual(
        repeatedField40Reply.lands[0].plant.field_40.map(status => [
            Number(status.value_1),
            Number(status.value_2),
        ]),
        [[1, 3], [2, 1]],
    );
});

test('frog cleanup matches captured single-land and one-click Farming bytes', async () => {
    await loadProto();
    const { encodeOwnFarmingRequest } = require('../dist/services/farm/api');

    const singleBody = encodeOwnFarmingRequest([9], 1009631504, [5005]);
    assert.equal(Buffer.from(singleBody).toString('hex'), '0a0109109082b7e103180020002a028d27');
    const single = types.FarmingRequest.decode(singleBody);
    assert.deepEqual(Array.from(single.social_event_item_ids, value => Number(value)), [5005]);

    const oneClickBody = encodeOwnFarmingRequest([3, 6, 12, 14, 17, 22], 1009631504, [5005]);
    assert.equal(Buffer.from(oneClickBody).toString('hex'), '0a0603060c0e1116109082b7e103180020002a028d27');

    const landsReply = types.AllLandsReply.decode(Buffer.from(
        '1a0f088d27109fd487ea0318cd86bcd406',
        'hex',
    ));
    assert.deepEqual(getCleanableFarmSocialEventItemIds(landsReply), [5005]);

    const farmingReply = types.FarmingReply.decode(Buffer.from(
        '220a088d27120508cd08101e',
        'hex',
    ));
    assert.equal(Number(farmingReply.social_event_rewards[0].item_id), 5005);
    assert.equal(Number(farmingReply.social_event_rewards[0].reward.id), 1101);
    assert.equal(Number(farmingReply.social_event_rewards[0].reward.count), 30);

    const clearedNotify = types.FarmSocialEventsNotify.decode(Buffer.from('109082b7e103', 'hex'));
    assert.equal(Number(clearedNotify.host_gid), 1009631504);
    assert.deepEqual(clearedNotify.social_events, []);
});

test('cloud notify uses live interaction target while Farming keeps no extra event field', async () => {
    await loadProto();
    const { encodeOwnFarmingRequest } = require('../dist/services/farm/api');
    const notify = types.LandsNotify.decode(Buffer.from(
        '0a1808015214b20211088e27109fd487ea0318978cbcd4062001109082b7e103',
        'hex',
    ));
    const target = notify.lands[0].plant.interaction_targets[0];
    assert.equal(Number(target.item_id), 5006);
    assert.equal(Number(target.host_gid), 1027729951);
    assert.equal(Number(target.land_id), 1);

    const activeCloudLand = growingLand(1, 0, {
        interaction_targets: [target],
        field_40: [{ value_1: 8, value_2: 1 }],
    });
    assert.deepEqual(analyzeLands([activeCloudLand], false, 9001).needInteractionCleanup, [1]);
    assert.deepEqual(buildLandDetail(activeCloudLand).interactionEffects.map(item => item.itemId), ['5006']);

    const body = encodeOwnFarmingRequest([2], 1009631504);
    assert.equal(Buffer.from(body).toString('hex'), '0a0102109082b7e10318002000');
    assert.deepEqual(types.FarmingRequest.decode(body).social_event_item_ids, []);
});
