const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ApiTokenStore } = require('../dist/models/api-token-store');

test('api token is generated once and reused across store instances', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-api-token-'));
    const filePath = path.join(dir, 'api-token.json');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const first = new ApiTokenStore({
        filePath,
        generateToken: () => 'a'.repeat(64),
    });
    assert.equal(first.getToken(), 'a'.repeat(64));

    const second = new ApiTokenStore({
        filePath,
        generateToken: () => 'b'.repeat(64),
    });
    assert.equal(second.getToken(), 'a'.repeat(64));
    assert.equal(second.verifyToken('a'.repeat(64)), true);
    assert.equal(second.verifyToken('b'.repeat(64)), false);
});

test('rotating the api token invalidates the old value and persists the new value', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-api-token-'));
    const filePath = path.join(dir, 'api-token.json');
    const generated = ['a'.repeat(64), 'b'.repeat(64)];
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const store = new ApiTokenStore({
        filePath,
        generateToken: () => generated.shift(),
    });
    const oldToken = store.getToken();
    const newToken = store.rotateToken();

    assert.equal(oldToken, 'a'.repeat(64));
    assert.equal(newToken, 'b'.repeat(64));
    assert.equal(store.verifyToken(oldToken), false);
    assert.equal(store.verifyToken(newToken), true);

    const reloaded = new ApiTokenStore({ filePath, generateToken: () => 'c'.repeat(64) });
    assert.equal(reloaded.getToken(), newToken);
});
