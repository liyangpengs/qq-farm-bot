const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DEFAULT_ROUTES, buildRequestPlan, parseArgs, runFixedLoad, validateOptions } = require('../../tools/performance/fixed-load');

test('fixed load profile builds a deterministic account and route plan', () => {
    const options = parseArgs([
        '--base-url', 'https://farm.example.test/',
        '--token', 'secret',
        '--accounts', 'a01,a02,a03',
        '--friend-account', 'a03',
        '--duration-minutes', '360',
        '--interval-ms', '5000',
        '--output', 'fixed-load.jsonl',
    ]);

    validateOptions(options);
    assert.equal(options.baseUrl, 'https://farm.example.test');
    assert.deepEqual(options.routes, DEFAULT_ROUTES);
    assert.equal(options.durationMs, 6 * 60 * 60 * 1000);
    assert.equal(options.intervalMs, 5000);
    assert.equal(options.minFriends, 300);
    assert.equal(buildRequestPlan(options.accounts, options.routes).length, 15);
    assert.deepEqual(buildRequestPlan(['a01'], ['/api/status', '/api/lands']), [
        { accountId: 'a01', route: '/api/status' },
        { accountId: 'a01', route: '/api/lands' },
    ]);
});

test('fixed load runner records stable cycle indexes under overlapping schedules', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-fixed-load-'));
    const output = path.join(directory, 'load.jsonl');
    const server = http.createServer((req, res) => {
        const data = req.url.startsWith('/api/friends')
            ? Array.from({ length: 300 }, (_, index) => ({ gid: index + 1 }))
            : { ready: true };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, data }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const address = server.address();
    const summary = await runFixedLoad({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: 'test-token',
        accounts: ['a01'],
        routes: ['/api/status'],
        durationMs: 35,
        intervalMs: 10,
        timeoutMs: 1000,
        minFriends: 300,
        friendAccount: 'a01',
        output,
    });

    const records = fs.readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const requests = records.filter(record => record.kind === 'fixed_load_request');
    assert.ok(summary.cycles >= 2);
    assert.deepEqual(
        requests.map(record => record.cycle).sort((left, right) => left - right),
        Array.from({ length: summary.cycles }, (_, index) => index),
    );
});
