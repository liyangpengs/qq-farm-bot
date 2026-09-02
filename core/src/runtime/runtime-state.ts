export {};
const { EventEmitter } = require('node:events');
const { getRuntimeConfig } = require('../config/config');
const { createModuleLogger } = require('../services/logger');
const { getTodayKey, loadPersistedStats } = require('../services/stats');
const { formatSystemDateTime24 } = require('../utils/utils');

interface RuntimeStateOptions {
    store: any;
    operationKeys?: string[];
}

interface LogEntry {
    time: string;
    tag: string;
    msg: string;
    meta: Record<string, any>;
    ts: number;
    _searchText?: string;
    [key: string]: any;
}

interface AccountLogEntry {
    time: string;
    action: string;
    msg: string;
    accountId: string;
    accountName: string;
    [key: string]: any;
}

interface LogFilters {
    keyword?: string;
    tag?: string;
    module?: string;
    event?: string;
    isWarn?: boolean | string;
    timeFrom?: string;
    timeTo?: string;
}

function createRuntimeState(options: RuntimeStateOptions) {
    const {
        store,
        operationKeys = [],
    } = options;

    const workers: Record<string, any> = {};
    const globalLogs: LogEntry[] = [];
    const accountLogs: AccountLogEntry[] = [];
    const runtimeEvents = new EventEmitter();
    let configRevision = Date.now();
    const runtimeLogger = createModuleLogger('runtime');

    function nextConfigRevision(): number {
        configRevision += 1;
        return configRevision;
    }

    function buildConfigSnapshotForAccount(accountId: string): any {
        const { ui: _ui, ...accountConfig } = store.getConfigSnapshot(accountId);
        return {
            ...accountConfig,
            systemTimeZone: getRuntimeConfig().timeZone,
            systemServerUrl: getRuntimeConfig().serverUrl,
            systemClientVersion: getRuntimeConfig().clientVersion,
            __revision: configRevision,
        };
    }

    function log(tag: string, msg: string, extra: Record<string, any> = {}): void {
        const time = formatSystemDateTime24();
        const level = tag === '错误' ? 'error' : 'info';
        runtimeLogger[level](msg, { tag, ...extra });
        const moduleName = (tag === '系统' || tag === '错误') ? 'system' : '';
        const entry: LogEntry = {
            time,
            tag,
            msg,
            meta: moduleName ? { module: moduleName } : {},
            ts: Date.now(),
            ...extra,
        };
        entry._searchText = `${entry.msg || ''} ${entry.tag || ''} ${JSON.stringify(entry.meta || {})}`.toLowerCase();
        globalLogs.push(entry);
        if (globalLogs.length > 1000) globalLogs.shift();
        runtimeEvents.emit('log', entry);
    }

    function addAccountLog(action: string, msg: string, accountId = '', accountName = '', extra: Record<string, any> = {}): void {
        const entry: AccountLogEntry = {
            time: formatSystemDateTime24(),
            action,
            msg,
            accountId: accountId ? String(accountId) : '',
            accountName: accountName || '',
            ...extra,
        };
        accountLogs.push(entry);
        if (accountLogs.length > 300) accountLogs.shift();
        runtimeEvents.emit('account_log', entry);
    }

    function normalizeStatusForPanel(data: any, accountId: string, accountName: string): any {
        const src = (data && typeof data === 'object') ? data : {};
        const ops = (src.operations && typeof src.operations === 'object') ? { ...src.operations } : {};
        for (const k of operationKeys) {
            if (ops[k] === undefined || ops[k] === null || Number.isNaN(Number(ops[k]))) {
                ops[k] = 0;
            } else {
                ops[k] = Number(ops[k]);
            }
        }
        return {
            ...src,
            accountId,
            accountName,
            operations: ops,
        };
    }

    function buildDefaultOperations(): Record<string, number> {
        const ops: Record<string, number> = {};
        for (const k of operationKeys) ops[k] = 0;
        return ops;
    }

    function buildDefaultStatus(accountId: string): any {
        const id = String(accountId || '');
        const operations = buildDefaultOperations();
        let totalSteal = 0;

        if (id) {
            const saved = loadPersistedStats(id);
            const todayKey = getTodayKey();
            if (saved) {
                if (saved.date === todayKey && saved.operations) {
                    for (const k of operationKeys) {
                        if (saved.operations[k] !== undefined) {
                            operations[k] = Number(saved.operations[k]) || 0;
                        }
                    }
                }
                if (typeof saved.totalSteal === 'number') {
                    totalSteal = saved.totalSteal;
                }
            }
        }

        return {
            connection: { connected: false },
            status: { name: '', level: 0, gold: 0, exp: 0, platform: 'qq' },
            uptime: 0,
            operations,
            totalSteal,
            sessionExpGained: 0,
            sessionGoldGained: 0,
            sessionCouponGained: 0,
            lastExpGain: 0,
            lastGoldGain: 0,
            limits: {},
            wsError: null,
            automation: store.getAutomation(accountId),
            preferredSeed: store.getPreferredSeed(accountId),
            expProgress: { current: 0, needed: 0, level: 0 },
            configRevision,
            accountId: id,
        };
    }

    function filterLogs(list: LogEntry[], filters: LogFilters = {}): LogEntry[] {
        const f = filters || {};
        const keyword = String(f.keyword || '').trim().toLowerCase();
        const keywordTerms = keyword ? keyword.split(/\s+/).filter(Boolean) : [];
        const tag = String(f.tag || '').trim();
        const moduleName = String(f.module || '').trim();
        const eventName = String(f.event || '').trim();
        const isWarn = f.isWarn;
        const timeFromMs = f.timeFrom ? Date.parse(String(f.timeFrom)) : Number.NaN;
        const timeToMs = f.timeTo ? Date.parse(String(f.timeTo)) : Number.NaN;
        return (list || []).filter((l) => {
            const logMs = Number(l && l.ts) || Date.parse(String((l && l.time) || ''));
            if (Number.isFinite(timeFromMs) && Number.isFinite(logMs) && logMs < timeFromMs) return false;
            if (Number.isFinite(timeToMs) && Number.isFinite(logMs) && logMs > timeToMs) return false;
            if (tag && String(l.tag || '') !== tag) return false;
            if (moduleName) {
                const logModule = String((l.meta || {}).module || '');
                if (moduleName === 'system') {
                    const isSystemTag = String(l.tag || '') === '系统' || String(l.tag || '') === '错误';
                    if (logModule !== 'system' && !isSystemTag) return false;
                } else if (logModule !== moduleName) {
                    return false;
                }
            }
            if (eventName && String((l.meta || {}).event || '') !== eventName) return false;
            if (isWarn !== undefined && isWarn !== null && String(isWarn) !== '') {
                const expected = String(isWarn) === '1' || String(isWarn).toLowerCase() === 'true';
                if (!!l.isWarn !== expected) return false;
            }
            if (keywordTerms.length > 0) {
                const text = String(l._searchText || `${l.msg || ''} ${l.tag || ''}`).toLowerCase();
                for (const term of keywordTerms) {
                    if (!text.includes(term)) return false;
                }
            }
            return true;
        });
    }

    return {
        workers,
        globalLogs,
        accountLogs,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs,
    };
}

module.exports = {
    createRuntimeState,
};
