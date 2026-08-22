const assert = require('node:assert/strict');
const test = require('node:test');

const { loadProto, types } = require('../dist/utils/proto');
const {
    analyzeLands,
    buildLandDetail,
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

test('own farm cleanup selects golden beetles and footballs only', () => {
    const status = analyzeLands([
        growingLand(1, 301101),
        growingLand(2, 301102),
        growingLand(3, 301103),
    ], false, 9001);

    assert.deepEqual(status.needInteractionCleanup, [1, 2]);
    assert.deepEqual(status.needWeed, []);
    assert.deepEqual(status.needBug, []);
    assert.deepEqual(status.needWater, []);
});

test('friend help does not treat golden beetles or footballs as help targets', () => {
    const status = analyzeFriendLands([
        growingLand(1, 301101),
        growingLand(2, 301102),
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
    assert.deepEqual(
        analyzeLands([
            clearedGoldenHistoryLand,
            clearedFootballHistoryLand,
            activeFootballLand,
            activeGoldenTargetOnlyLand,
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
