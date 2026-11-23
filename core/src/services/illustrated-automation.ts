export {};

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getDataDir } = require('../config/runtime-paths');
const { getAutomation } = require('../models/store');
const { writeJsonFileAtomic } = require('./json-db');
const { getIllustratedLevels, claimIllustratedRewards } = require('./illustrated');
const { log, logWarn } = require('../utils/utils');

const CHECK_INTERVAL_MS = 5 * 60_000;
const nextChecks = new Map<string, number>();
const running = new Map<string, Promise<void>>();
interface PendingClaim { levels: number[]; createdAt: number }
type PendingClaims = Partial<Record<1 | 2, PendingClaim>>;

function enabled(): boolean { return getAutomation().farm_illustrated === true; }
function isDue(): boolean {
    const account = process.env.FARM_ACCOUNT_ID;
    return !!account && enabled() && !running.has(account) && Date.now() >= (nextChecks.get(account) || 0);
}

async function check(account: string, canContinue: () => boolean): Promise<void> {
    const file = path.join(getDataDir(), 'illustrated-automation', `${createHash('sha256').update(account).digest('hex')}.json`);
    const pending: PendingClaims = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (!pending || Array.isArray(pending) || typeof pending !== 'object'
        || Object.entries(pending).some(([kind, value]) => !['1', '2'].includes(kind)
            || !Array.isArray(value?.levels) || !value.levels.length
            || value.levels.some((level: number) => !Number.isInteger(level) || level <= 0))) {
        throw new Error('农场图鉴待核对记录格式错误，请检查数据文件');
    }
    const allowed = () => process.env.FARM_ACCOUNT_ID === account && enabled() && canContinue();
    for (const type of [1, 2] as const) {
        if (!allowed()) return;
        const name = type === 1 ? '普通' : '变异';
        try {
            if (pending[type]) {
                const state = await getIllustratedLevels(type);
                const claimed = new Set((state.level_list || []).filter((level: any) => level.claimed).map((level: any) => Number(level.level)));
                if (!pending[type]!.levels.every(level => claimed.has(level))) continue;
                delete pending[type];
                writeJsonFileAtomic(file, pending);
                log('图鉴', `${name}图鉴上次领奖已回读确认`, { module: 'farm', event: 'illustrated_claim', result: 'reconciled', type });
            }
            const result = await claimIllustratedRewards(type, {
                canContinue: allowed,
                skipUnavailable: true,
                beforeSend: (levels: number[]) => {
                    pending[type] = { levels, createdAt: Date.now() };
                    // 发出领奖前持久记录；超时、断线和进程重启都不能触发盲目重放。
                    writeJsonFileAtomic(file, pending);
                },
            });
            if (!result) continue;
            const book = type === 1 ? result.snapshot?.crop : result.snapshot?.mutant;
            const claimed = new Set((book?.levels || []).filter((level: any) => level.claimed).map((level: any) => Number(level.level)));
            if (!pending[type]!.levels.every(level => claimed.has(level))) {
                logWarn('图鉴', `${name}图鉴领奖回读未确认，已暂停自动重试`);
                continue;
            }
            delete pending[type];
            writeJsonFileAtomic(file, pending);
            log('图鉴', `自动领取${name}图鉴奖励完成`, { module: 'farm', event: 'illustrated_claim', result: 'ok', type,
                levels: result.claimedLevels, rewards: result.rewards });
        } catch (cause: any) {
            logWarn('图鉴', `${name}图鉴${pending[type] ? '领奖结果待核对，已暂停自动重试' : '检查失败'}：${cause.message}`);
        }
    }
}

function run(options: { canContinue?: () => boolean } = {}): Promise<void> {
    const account = process.env.FARM_ACCOUNT_ID;
    if (!account || !enabled()) return Promise.resolve();
    if (running.has(account)) return running.get(account)!;
    if (!isDue()) return Promise.resolve();
    nextChecks.set(account, Date.now() + CHECK_INTERVAL_MS);
    const request = check(account, options.canContinue || (() => true)).finally(() => { running.delete(account); });
    running.set(account, request);
    return request;
}

module.exports = { isDue, run };
