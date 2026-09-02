const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const protobuf = require('protobufjs');

const ORGANIC_SUCCESS_BODY = Buffer.from(
    '0a930108011001180520054a1308b0ea0110d00f18c41320e05d28a01f30c41352710898a23e1209e58da1e789b9e585b02210080210eed9ced406181538d1e6ced406220a080610ee8fcfd406180a280150f8b90258c00d78808e028001018801019001c00da2010101b001de2fd001f8b902d801c00d92020a08e90710c2031898a23ea8028201ca02080896cfced4061001800105120b089a4e103118ff93ebdc031a0708f40710d2c00d220a08011a0608f40710a82b',
    'hex',
);

const NORMAL_SUCCESS_BODY = Buffer.from(
    '0ab50108011001180520054a1308b0ea0110d00f18c41320e05d28a01f30c41352920108baa13e1206e89684e88db72216080210dbdbced406180630d087cfd40640a5f7ced406220a080210db88cfd4061808220a080210dbb5cfd406180c22160802109bf9cfd406180a30deabd0d4064088abd0d406220a080610dbbcd0d40618132801509ab90258a00678808e028001019001a006b0019c19d0019ab902d801a00692020a08e90710c20318baa13ea8028201800105120b089a4e103318ff93ebdc031a0708f30710dcb41e220a08011a0608f30710e42c',
    'hex',
);

async function loadFertilizeReply() {
    const root = new protobuf.Root();
    await root.load(path.join(__dirname, '../src/proto/plantpb.proto'), { keepCase: true });
    return root.lookupType('gamepb.plantpb.FertilizeReply');
}

test('FertilizeReply decodes an organic-fertilizer success captured from the game', async () => {
    const FertilizeReply = await loadFertilizeReply();
    const reply = FertilizeReply.decode(ORGANIC_SUCCESS_BODY);

    assert.equal(Number(reply.fertilizer.id), 1012);
    assert.equal(Number(reply.fertilizer.count), 221266);
    assert.equal(Number(reply.fertilizer_use.consumed.id), 1012);
    assert.equal(Number(reply.fertilizer_use.consumed.count), 5544);
});

test('FertilizeReply decodes a normal-fertilizer success captured from the game', async () => {
    const FertilizeReply = await loadFertilizeReply();
    const reply = FertilizeReply.decode(NORMAL_SUCCESS_BODY);

    assert.equal(Number(reply.fertilizer.id), 1011);
    assert.equal(Number(reply.fertilizer.count), 498268);
    assert.equal(Number(reply.fertilizer_use.consumed.id), 1011);
    assert.equal(Number(reply.fertilizer_use.consumed.count), 5732);
});
