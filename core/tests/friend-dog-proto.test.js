const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

async function loadEnterReplyType() {
    const root = new protobuf.Root();
    await root.load([path.join(__dirname, '../src/proto/visitpb.proto')], { keepCase: true });
    return root.lookupType('gamepb.visitpb.EnterReply');
}

test('Visit.Enter decodes the current friend dog from field 3', async () => {
    const EnterReply = await loadEnterReplyType();
    const reply = EnterReply.decode(Buffer.from([0x1A, 0x04, 0x08, 0x9B, 0xBF, 0x05]));
    assert.equal(Number(reply.brief_dog_info.dog_id), 90011);
});

test('Visit.Enter keeps an empty field 3 distinguishable as checked without a dog', async () => {
    const EnterReply = await loadEnterReplyType();
    const reply = EnterReply.decode(Buffer.from([0x1A, 0x00]));
    assert.ok(reply.brief_dog_info);
    assert.equal(Number(reply.brief_dog_info.dog_id || 0), 0);
});
