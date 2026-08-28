const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PerformanceMetricsStore } = require('../dist/services/performance-metrics-store');

test('performance metric windows are appended to dedicated ndjson files', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-performance-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    const store = new PerformanceMetricsStore({ directory: dir, now: () => now });

    store.append({
        kind: 'account_tasks',
        accountId: 'account-a',
        windowStartedAt: now - 60000,
        windowEndedAt: now,
        taskCount: 4,
        tasks: [],
    });

    const status = store.getStatus();
    assert.equal(status.files.length, 1);
    assert.equal(status.files[0].name, 'task-metrics-2026-08-27.jsonl');
    const lines = fs.readFileSync(path.join(dir, status.files[0].name), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.kind, 'account_tasks');
    assert.equal(record.accountId, 'account-a');
    assert.equal(record.schemaVersion, 1);
    assert.equal(typeof record.botVersion, 'string');
});

test('friend round windows are persisted without task histogram samples', (t) => {
    const storeModule = require('../dist/services/performance-metrics-store');
    const serviceModulePath = require.resolve('../dist/services/performance-metrics');
    const OriginalStore = storeModule.PerformanceMetricsStore;
    const records = [];

    storeModule.PerformanceMetricsStore = class {
        append(record) {
            records.push(record);
        }
    };
    delete require.cache[serviceModulePath];
    t.after(() => {
        storeModule.PerformanceMetricsStore = OriginalStore;
        delete require.cache[serviceModulePath];
    });

    const { recordAccountTaskMetrics } = require(serviceModulePath);
    recordAccountTaskMetrics('account-a', {
        windowStartedAt: 1000,
        windowEndedAt: 2000,
        taskCount: 0,
        friendRoundCount: 1,
        friendRounds: [{ friendCount: 300, processedCount: 2, deferredCount: 298 }],
        tasks: [],
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'account_tasks');
    assert.equal(records[0].accountId, 'account-a');
    assert.equal(records[0].friendRoundCount, 1);
});
