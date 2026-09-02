const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

async function loadRoot() {
    const root = new protobuf.Root();
    await root.load([
        path.join(__dirname, '../src/proto/activitypb.proto'),
        path.join(__dirname, '../src/proto/itempb.proto'),
        path.join(__dirname, '../src/proto/weatherpb.proto'),
        path.join(__dirname, '../src/proto/friendpb.proto'),
        path.join(__dirname, '../src/proto/visitpb.proto'),
    ], { keepCase: true });
    return root;
}

test('weather research request reproduces the capture-verified field 140 selector', async () => {
    const root = await loadRoot();
    const Request = root.lookupType('gamepb.activitypb.AdvanceWeatherResearchRequest');
    const body = Buffer.from(Request.encode(Request.create({
        activity_id: '2026070304',
        operate_type: 40,
        weather_research_operate: { node_id: 1000 },
    })).finish());

    assert.equal(body.toString('hex'), '08a0c28dc6071028e2080308e807');
});

test('weather bottle use target preserves the host and explicit zero use config', async () => {
    const root = await loadRoot();
    const Request = root.lookupType('gamepb.itempb.UseRequest');
    const body = Buffer.from(Request.encode(Request.create({
        item: { id: 5002, count: 1, uid: 77 },
        target: { host_gid: 123456, use_config_id: 0 },
    })).finish());
    const decoded = Request.decode(body);

    assert.equal(Number(decoded.item.id), 5002);
    assert.equal(Number(decoded.target.host_gid), 123456);
    assert.equal(Number(decoded.target.use_config_id), 0);
    assert.deepEqual(Array.from(body.slice(-2)), [0x18, 0x00]);
});

test('frog and cloud bottle requests match the successful captures', async () => {
    const root = await loadRoot();
    const Request = root.lookupType('gamepb.itempb.UseRequest');
    const frogBody = Buffer.from(Request.encode(Request.create({
        item: { id: 5005, count: 1, uid: 13859 },
        target: { host_gid: '1001851355', use_config_id: 0 },
    })).finish());
    const cloudBody = Buffer.from(Request.encode(Request.create({
        item: { id: 5006, count: 1, uid: 13865 },
        target: { host_gid: '1027729951', land_ids: [11] },
    })).finish());

    assert.equal(frogBody.toString('hex'), '0a08088d27100130a36c120808db93dcdd031800');
    assert.equal(cloudBody.toString('hex'), '0a08088e27100130a96c1209089fd487ea0312010b');
});

test('weather collection request reproduces operate_type 9 and field 107.field 3', async () => {
    const root = await loadRoot();
    const Request = root.lookupType('gamepb.activitypb.CollectWeatherRequest');
    const body = Buffer.from(Request.encode(Request.create({
        activity_id: '2026070303',
        operate_type: 9,
        weather_collect_operate: { host_gid: '1027729951' },
    })).finish());

    assert.equal(body.toString('hex'), '089fc28dc6071009da0606189fd487ea03');
});

test('visit reply decodes field 13 weather and field 9 friend marker', async () => {
    const root = await loadRoot();
    const Reply = root.lookupType('gamepb.visitpb.EnterReply');
    const decoded = Reply.decode(Reply.encode(Reply.create({
        weather: {
            weather_type: 1,
            status: 2,
            begin_time: 1787723547,
            end_time: 1787730747,
            source: 1,
            field_9: 4,
        },
    })).finish());

    assert.equal(Number(decoded.weather.weather_type), 1);
    assert.equal(Number(decoded.weather.status), 2);
    assert.equal(Number(decoded.weather.field_9), 4);
    assert.equal(Number(decoded.weather.end_time) - Number(decoded.weather.begin_time), 7200);
});

test('field 9 collection state is scoped to the active thunderstorm cycle', () => {
    const {
        weatherAvailability,
        weatherStatusDto,
    } = require('../dist/services/weather-activity');
    const now = Math.floor(Date.now() / 1000);

    const collectedCycle = weatherStatusDto({
        weather_type: 1,
        status: 2,
        begin_time: now - 60,
        end_time: now + 3600,
        field_9: 4,
    }, 1001);
    assert.equal(collectedCycle.collectedThisCycle, true);
    assert.equal(Object.hasOwn(collectedCycle, 'collectedToday'), false);
    assert.deepEqual(weatherAvailability(collectedCycle, true), {
        state: 'collected',
        reason: '当前这轮雷雨已经采过，下轮雷雨可再次采集',
    });

    const expiredCycle = weatherStatusDto({
        weather_type: 1,
        status: 2,
        begin_time: now - 7200,
        end_time: now - 60,
        field_9: 4,
    }, 1001);
    assert.equal(weatherAvailability(expiredCycle, true).state, 'expired');

    const nextCycle = weatherStatusDto({
        weather_type: 1,
        status: 2,
        begin_time: now - 30,
        end_time: now + 7170,
        field_9: 0,
    }, 1001);
    assert.equal(nextCycle.collectedThisCycle, false);
    assert.equal(weatherAvailability(nextCycle, true).state, 'available');
});

test('frog bottle reply decodes field 6 experience rewards', async () => {
    const root = await loadRoot();
    const Reply = root.lookupType('gamepb.itempb.UseReply');
    const decoded = Reply.decode(Buffer.from('0a08088d27100130a36c320a088d27120508cd08101e', 'hex'));

    assert.equal(Number(decoded.used_items[0].id), 5005);
    assert.equal(Number(decoded.social_reward.item_id), 5005);
    assert.equal(Number(decoded.social_reward.items[0].id), 1101);
    assert.equal(Number(decoded.social_reward.items[0].count), 30);
});

test('friend weather scan keeps the five-friend batch contract', () => {
    const {
        FRIEND_WEATHER_SCAN_BATCH_LIMIT,
        scanWeatherFriends,
    } = require('../dist/services/weather-activity');

    assert.equal(FRIEND_WEATHER_SCAN_BATCH_LIMIT, 5);
    assert.throws(() => scanWeatherFriends([]), { code: 'INVALID_WEATHER_FRIEND_GID' });
    assert.throws(() => scanWeatherFriends(['0']), { code: 'INVALID_WEATHER_FRIEND_GID' });
    assert.throws(
        () => scanWeatherFriends(['11', '12', '13', '14', '15', '16']),
        { code: 'WEATHER_SCAN_BATCH_TOO_LARGE' },
    );
});
