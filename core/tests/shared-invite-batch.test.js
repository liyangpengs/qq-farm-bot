const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SharedInviteBatch } = require('../dist/app/shared-invite-batch');

function createShareFile(t, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-invites-'));
    const filePath = path.join(dir, 'share.txt');
    fs.writeFileSync(filePath, content, 'utf8');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return filePath;
}

test('a shared invite batch has only one account owner', (t) => {
    const filePath = createShareFile(t, [
        '?uid=11&openid=first&share_source=7',
        '?uid=11&openid=duplicate&share_source=8',
        '?uid=22&openid=second&share_source=9',
    ].join('\n'));
    const batches = new SharedInviteBatch(filePath);

    const claim = batches.claim('account-a');

    assert.deepEqual(claim.invites.map(invite => invite.uid), ['11', '22']);
    assert.equal(batches.claim('account-b'), null);
    assert.equal(batches.complete('account-b', claim.claimId), false);
    assert.notEqual(fs.readFileSync(filePath, 'utf8'), '');
    assert.equal(batches.complete('account-a', claim.claimId), true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), '');
});

test('a changed share file is not cleared when the old batch completes', (t) => {
    const firstLine = '?uid=11&openid=first&share_source=7';
    const filePath = createShareFile(t, firstLine);
    const batches = new SharedInviteBatch(filePath);
    const claim = batches.claim('account-a');

    fs.appendFileSync(filePath, '\n?uid=22&openid=second&share_source=9', 'utf8');

    assert.equal(batches.complete('account-a', claim.claimId), false);
    assert.match(fs.readFileSync(filePath, 'utf8'), /uid=22/);
    assert.ok(batches.claim('account-b'));
});

test('releasing a failed owner makes the unchanged batch claimable again', (t) => {
    const filePath = createShareFile(t, '?uid=11&openid=first&share_source=7');
    const batches = new SharedInviteBatch(filePath);
    const first = batches.claim('account-a');

    assert.equal(batches.release('account-b', first.claimId), false);
    assert.equal(batches.release('account-a', first.claimId), true);

    const retry = batches.claim('account-b');
    assert.deepEqual(retry.invites, first.invites);
    assert.notEqual(retry.claimId, first.claimId);
});
