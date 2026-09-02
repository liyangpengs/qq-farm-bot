const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

async function loadRoot() {
    const root = new protobuf.Root();
    await root.load([
        path.join(__dirname, '../src/proto/activitypb.proto'),
        path.join(__dirname, '../src/proto/corepb.proto'),
    ], { keepCase: true });
    return root;
}

test('charity red flower requests reproduce the capture-verified selectors', async () => {
    const root = await loadRoot();
    const Request = root.lookupType('gamepb.activitypb.CharityRedFlowerOperateRequest');
    const encode = payload => Buffer.from(Request.encode(Request.create({
        activity_id: '2026090901',
        ...payload,
    })).finish()).toString('hex');

    assert.equal(encode({ operate_type: 35, claim_seed: {} }), '0895e38ec6071023b20800');
    assert.equal(encode({ operate_type: 36, donate_love: {} }), '0895e38ec6071024ba0800');
    assert.equal(encode({ operate_type: 38, send_public_fund: {} }), '0895e38ec6071026ca0800');
    assert.equal(encode({ operate_type: 39, query: { accepted: true } }), '0895e38ec6071027d208020801');
});

test('charity red flower reward replies decode the verified result selectors', async () => {
    const root = await loadRoot();
    const Reply = root.lookupType('gamepb.activitypb.ActivityOperateReply');
    const seedReply = Reply.decode(Buffer.from(
        '0895e38ec6071023ba08180a160893a3011006188092b8c398feffffff01309a153801',
        'hex',
    ));
    const fundReply = Reply.decode(Buffer.from(
        '0895e38ec6071026d208590801121251514e43323639394d5732303236303930311a160881f1041002188092b8c398feffffff0130a3153801222c32303236303930315f63665f6634363830383363386365323761666139323730363466393236643533643462',
        'hex',
    ));

    assert.equal(Number(seedReply.charity_seed_result.reward.id), 20883);
    assert.equal(Number(seedReply.charity_seed_result.reward.count), 6);
    assert.equal(Number(fundReply.charity_public_fund_result.status), 1);
    assert.equal(Number(fundReply.charity_public_fund_result.reward.id), 80001);
    assert.equal(Number(fundReply.charity_public_fund_result.reward.count), 2);
    assert.equal(fundReply.charity_public_fund_result.order_id, 'QQNC2699MW20260901');
    assert.equal(fundReply.charity_public_fund_result.token, '20260901_cf_f468083c8ce27afa927064f926d53d4b');
});
