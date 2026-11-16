export {};

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getDataDir } = require('../../config/runtime-paths');
const { writeJsonFileAtomic } = require('../json-db');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const { error } = require('./model');

interface PendingOperation {
    id: string;
    target: string;
    label: string;
    costs: Array<{ resourceKey: string; amount: string }>;
    createdAt: number;
    message: string;
}

// 每个账号的结果未知写入保留到人工核对，重启也不自动重发。
function forCurrentAccount() {
    const accountId = process.env.FARM_ACCOUNT_ID;
    if (!accountId) throw error('RANCH_ACCOUNT_REQUIRED', '牧场操作缺少账号标识');
    const file = path.join(getDataDir(), 'ranch-operations', `${createHash('sha256').update(accountId).digest('hex')}.json`);
    function pending(): PendingOperation[] {
        if (!fs.existsSync(file)) return [];
        const records = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(records) || records.some(row => !row.id || !row.target || !Array.isArray(row.costs)
            || row.costs.some((cost: any) => !/^item:\d+$/.test(cost.resourceKey) || !/^\d+$/.test(cost.amount)))) {
            throw error('RANCH_STATE_INVALID', '牧场待核对记录格式错误，请检查数据文件');
        }
        return records;
    }
    function save(records: PendingOperation[]): void { writeJsonFileAtomic(file, records); }
    function reserved(key: string): string {
        return pending().flatMap(row => row.costs).filter(cost => cost.resourceKey === key)
            .reduce((sum, cost) => sum + BigInt(cost.amount), 0n).toString();
    }
    function acknowledge(id: string): void {
        const records = pending();
        if (!records.some(row => row.id === id)) throw error('RANCH_STATE_CHANGED', '这条记录已处理，请刷新');
        save(records.filter(row => row.id !== id));
    }
    async function spend<T>(plan: any, run: () => Promise<T>): Promise<T> {
        if (pending().some(row => row.target === plan.target)) throw error('PENDING_CONFIRMATION', '该操作的上次结果未知，请在牧场页面核对后解除保护');
        for (const cost of plan.costs) {
            const balance = plan.balances.find((row: any) => row.resourceKey === cost.resourceKey);
            if (!balance || balance.state !== 'known') throw error('RANCH_BALANCE_UNKNOWN', '牧场资源余额未确认');
            if (BigInt(balance.total) - BigInt(balance.locked) - BigInt(reserved(cost.resourceKey)) < BigInt(cost.amount)) {
                throw error('RESERVE_PROTECTED', '扣除待核对操作的预留资源后余额不足');
            }
        }
        const record: PendingOperation = { id: randomUUID(), target: plan.target, label: plan.label, costs: plan.costs,
            createdAt: Date.now(), message: '操作结果待核对' };
        save([...pending(), record]);
        let sent = 0;
        let first: { service: string; method: string } | undefined;
        const parent = getAmbientSendContext();
        try {
            const result = await runWithSendContext({
                check: (service: string, method: string) => parent?.check(service, method) || null,
                onSent: (service: string, method: string) => { sent++; first ??= { service, method }; parent?.onSent(service, method); },
            }, run);
            acknowledge(record.id);
            return result;
        } catch (cause: any) {
            const rejected = sent === 0 || (sent === 1 && cause.name === 'GatewayError'
                && cause.serviceName === first?.service && cause.methodName === first?.method);
            if (rejected) acknowledge(record.id);
            else {
                save(pending().map(row => row.id === record.id ? { ...row, message: String(cause.message).slice(0, 300) } : row));
                cause.outcomeUnknown = true;
            }
            throw cause;
        }
    }
    // 调用方已持有上游自动操作锁，整个报价与写入共用同一串行任务。
    return { withLock: <T>(run: () => Promise<T>) => run(), spend, reserved, pending, acknowledge };
}

module.exports = { forCurrentAccount };
