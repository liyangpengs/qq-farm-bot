#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROUTES = ['/api/status', '/api/lands', '/api/bag', '/api/seeds', '/api/friends'];

function parseNumber(value, name, fallback) {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
    return parsed;
}

function parseArgs(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--help' || flag === '-h') {
            values.help = true;
            continue;
        }
        if (!flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`);
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
        values[flag.slice(2)] = value;
        index += 1;
    }

    const accounts = String(values.accounts || process.env.FARM_LOAD_ACCOUNTS || '')
        .split(',').map(value => value.trim()).filter(Boolean);
    const routes = String(values.routes || DEFAULT_ROUTES.join(','))
        .split(',').map(value => value.trim()).filter(Boolean);
    return {
        help: values.help === true,
        baseUrl: String(values['base-url'] || process.env.FARM_LOAD_BASE_URL || 'http://127.0.0.1:3007').replace(/\/+$/, ''),
        token: String(values.token || process.env.FARM_API_TOKEN || ''),
        accounts,
        routes,
        durationMs: parseNumber(values['duration-minutes'], '--duration-minutes', 360) * 60 * 1000,
        intervalMs: parseNumber(values['interval-ms'], '--interval-ms', 5000),
        timeoutMs: parseNumber(values['timeout-ms'], '--timeout-ms', 30000),
        minFriends: Math.floor(parseNumber(values['min-friends'], '--min-friends', 300)),
        friendAccount: String(values['friend-account'] || ''),
        output: path.resolve(values.output || `fixed-load-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`),
    };
}

function validateOptions(options) {
    if (!options.token) throw new Error('Set FARM_API_TOKEN or pass --token');
    if (options.accounts.length === 0) throw new Error('Set FARM_LOAD_ACCOUNTS or pass --accounts');
    if (options.friendAccount && !options.accounts.includes(options.friendAccount)) {
        throw new Error('--friend-account must be included in --accounts');
    }
    if (options.routes.length === 0 || options.routes.some(route => !route.startsWith('/api/'))) {
        throw new Error('--routes must contain comma-separated /api/ paths');
    }
}

function buildRequestPlan(accounts, routes) {
    return accounts.flatMap(accountId => routes.map(route => ({ accountId, route })));
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function requestJson(options, accountId, route) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const startedAt = Date.now();
    try {
        const response = await fetch(`${options.baseUrl}${route}`, {
            headers: {
                'x-admin-token': options.token,
                'x-account-id': accountId,
            },
            signal: controller.signal,
        });
        const text = await response.text();
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {}
        const finishedAt = Date.now();
        return {
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            statusCode: response.status,
            ok: response.ok && body?.ok !== false,
            body,
            error: response.ok ? String(body?.error || '') : `HTTP ${response.status}`,
        };
    } catch (error) {
        const finishedAt = Date.now();
        return {
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            statusCode: 0,
            ok: false,
            body: null,
            error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error),
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function runFixedLoad(options) {
    validateOptions(options);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    const output = fs.openSync(options.output, 'a');
    const write = record => fs.writeSync(output, `${JSON.stringify(record)}\n`);
    let stopping = false;
    const stop = () => {
        stopping = true;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    try {
        const friendCounts = {};
        for (const accountId of options.accounts) {
            const result = await requestJson(options, accountId, '/api/friends?forceSync=true');
            const friendCount = Array.isArray(result.body?.data) ? result.body.data.length : 0;
            friendCounts[accountId] = friendCount;
            write({ kind: 'preflight', accountId, friendCount, ...result, body: undefined });
            if (!result.ok) throw new Error(`Friend preflight failed for ${accountId}: ${result.error}`);
        }
        const qualifyingAccounts = Object.entries(friendCounts)
            .filter(([, count]) => count >= options.minFriends)
            .map(([accountId]) => accountId);
        if (options.friendAccount && !qualifyingAccounts.includes(options.friendAccount)) {
            throw new Error(`${options.friendAccount} has fewer than ${options.minFriends} friends`);
        }
        if (!options.friendAccount && qualifyingAccounts.length === 0) {
            throw new Error(`No account has at least ${options.minFriends} friends`);
        }

        const plan = buildRequestPlan(options.accounts, options.routes);
        const startedAt = Date.now();
        const endsAt = startedAt + options.durationMs;
        const pending = new Set();
        const summary = { requests: 0, succeeded: 0, failed: 0, maxDurationMs: 0 };
        write({
            kind: 'fixed_load_start',
            startedAt,
            endsAt,
            intervalMs: options.intervalMs,
            timeoutMs: options.timeoutMs,
            accounts: options.accounts,
            routes: options.routes,
            friendCounts,
        });

        let cycle = 0;
        while (!stopping) {
            const cycleIndex = cycle;
            const dueAt = startedAt + cycleIndex * options.intervalMs;
            if (dueAt >= endsAt) break;
            await wait(dueAt - Date.now());
            if (stopping) break;

            const work = Promise.all(plan.map(async ({ accountId, route }) => {
                const result = await requestJson(options, accountId, route);
                summary.requests += 1;
                summary[result.ok ? 'succeeded' : 'failed'] += 1;
                summary.maxDurationMs = Math.max(summary.maxDurationMs, result.durationMs);
                write({
                    kind: 'fixed_load_request',
                    cycle: cycleIndex,
                    dueAt,
                    accountId,
                    route,
                    ...result,
                    body: undefined,
                });
            }));
            pending.add(work);
            work.finally(() => pending.delete(work));
            cycle += 1;
        }

        await Promise.allSettled([...pending]);
        write({
            kind: 'fixed_load_end',
            startedAt,
            finishedAt: Date.now(),
            stopped: stopping,
            cycles: cycle,
            ...summary,
        });
        return { output: options.output, cycles: cycle, friendCounts, ...summary };
    } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        fs.closeSync(output);
    }
}

function helpText() {
    return [
        'Usage: pnpm perf:fixed-load -- --accounts id1,id2,id3 [options]',
        '',
        'Environment: FARM_API_TOKEN, FARM_LOAD_BASE_URL, FARM_LOAD_ACCOUNTS',
        'Options: --duration-minutes 360 --interval-ms 5000 --min-friends 300',
        '         --friend-account id --routes /api/status,/api/lands,/api/bag,/api/seeds,/api/friends',
        '         --timeout-ms 30000 --output fixed-load.jsonl',
    ].join('\n');
}

if (require.main === module) {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
        if (options.help) {
            process.stdout.write(`${helpText()}\n`);
        } else {
            runFixedLoad(options).then(
                summary => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`),
                error => {
                    process.stderr.write(`${error.message}\n`);
                    process.exitCode = 1;
                },
            );
        }
    } catch (error) {
        process.stderr.write(`${error.message}\n${helpText()}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    DEFAULT_ROUTES,
    buildRequestPlan,
    parseArgs,
    runFixedLoad,
    validateOptions,
};
