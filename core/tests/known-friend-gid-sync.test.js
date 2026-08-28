const assert = require('node:assert/strict');
const test = require('node:test');

const {
    applyKnownFriendGidChange,
    KnownFriendGidSync,
} = require('../dist/app/known-friend-gid-sync');

test('known friend GID sync keeps the original base and latest value', () => {
    const sync = new KnownFriendGidSync();

    assert.deepEqual(sync.update([11], [11, 22]), {
        revision: 1,
        baseGids: [11],
        gids: [11, 22],
    });
    assert.deepEqual(sync.update([11, 22], [22, 33]), {
        revision: 2,
        baseGids: [11],
        gids: [22, 33],
    });
    assert.deepEqual(sync.getPending(), {
        revision: 2,
        baseGids: [11],
        gids: [22, 33],
    });
});

test('an old acknowledgement cannot clear a newer pending value', () => {
    const sync = new KnownFriendGidSync();

    sync.update([], [11]);
    sync.update([11], [22]);

    assert.equal(sync.acknowledge(1), false);
    assert.deepEqual(sync.getPending(), { revision: 2, baseGids: [], gids: [22] });
    assert.equal(sync.acknowledge(2), true);
    assert.equal(sync.getPending(), null);
});

test('applying a worker change preserves concurrent main-process edits', () => {
    assert.deepEqual(
        applyKnownFriendGidChange(
            [11, 22, 44],
            [11, 22],
            [22, 33],
        ),
        [22, 44, 33],
    );
    assert.deepEqual(
        applyKnownFriendGidChange(
            [22, 44],
            [11, 22],
            [22, 33],
        ),
        [22, 44, 33],
    );
});
