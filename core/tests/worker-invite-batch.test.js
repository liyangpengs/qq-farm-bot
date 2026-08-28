const assert = require('node:assert/strict');
const test = require('node:test');

const { runClaimedInviteBatch } = require('../dist/app/worker-invite-batch');

function createOptions(messages, error = null) {
    return {
        processInvites: async () => {
            if (error) throw error;
        },
        submitTask: async (_name, run) => run(),
        notify: message => messages.push(message),
    };
}

test('a completed invite batch is acknowledged for deletion', async () => {
    const messages = [];
    const batch = { claimId: 7, invites: [{ uid: '11' }] };

    await runClaimedInviteBatch(batch, createOptions(messages));

    assert.deepEqual(messages, [{ type: 'invite_batch_complete', claimId: 7 }]);
});

test('a failed invite batch releases its claim without marking the file complete', async () => {
    const messages = [];
    const batch = { claimId: 7, invites: [{ uid: '11' }] };

    await assert.rejects(
        runClaimedInviteBatch(batch, createOptions(messages, new Error('queue stopped'))),
        /queue stopped/,
    );

    assert.deepEqual(messages, [{ type: 'invite_batch_release', claimId: 7 }]);
});
