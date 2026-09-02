const assert = require('node:assert/strict');
const test = require('node:test');

const {
    CHECK_COOLDOWN_MS,
    isEmailCheckDue,
} = require('../dist/services/email');

test('mailbox discovery repeats every five minutes even on the same day', () => {
    const firstCheckAt = new Date('2026-08-26T09:00:00+08:00').getTime();
    assert.equal(CHECK_COOLDOWN_MS, 5 * 60 * 1000);
    assert.equal(isEmailCheckDue(firstCheckAt, firstCheckAt + CHECK_COOLDOWN_MS - 1), false);
    assert.equal(isEmailCheckDue(firstCheckAt, firstCheckAt + CHECK_COOLDOWN_MS), true);
    assert.equal(isEmailCheckDue(firstCheckAt, firstCheckAt + 60 * 60 * 1000), true);
});

test('forced mailbox discovery bypasses the cooldown', () => {
    assert.equal(isEmailCheckDue(Date.now(), Date.now(), true), true);
});
