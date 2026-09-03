"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { fork } = require('node:child_process');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const store = require('../models/store');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig } = require('../config/config');
const { sendPushooMessage } = require('../services/push');
const { reissueWxLoginCode, TARGET_APP_ID } = require('../services/wx-login/service');
const { createDataProvider } = require('./data-provider');
const { createReloginReminderService } = require('./relogin-reminder');
const { createRuntimeState } = require('./runtime-state');
const { createWorkerManager } = require('./worker-manager');
const OPERATION_KEYS = ['harvest', 'farming', 'fertilize', 'plant', 'steal', 'helpFarming', 'taskClaim', 'sell', 'upgrade'];
function createRuntimeEngine(options = {}) {
    const processRef = options.processRef || process;
    // Detect if running from source (tsx) or compiled (node)
    const isRunningFromSource = __dirname.includes(`${path.sep}src${path.sep}`);
    const fileExt = isRunningFromSource ? '.ts' : '.js';
    const mainEntryPath = options.mainEntryPath || path.join(__dirname, `../../client${fileExt}`);
    const workerScriptPath = options.workerScriptPath || path.join(__dirname, `../core/worker${fileExt}`);
    const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase();
    const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null;
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null;
    const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null;
    const runtimeState = createRuntimeState({
        store,
        operationKeys: OPERATION_KEYS,
    });
    const { workers, globalLogs: GLOBAL_LOGS, accountLogs: ACCOUNT_LOGS, runtimeEvents, nextConfigRevision, buildConfigSnapshotForAccount, log, addAccountLog, normalizeStatusForPanel, buildDefaultStatus, filterLogs, } = runtimeState;
    const reloginReminder = createReloginReminderService({
        store,
        sendPushooMessage,
        log,
    });
    const { getOfflineAutoDeleteMs, triggerOfflineReminder, sendConfiguredPush, } = reloginReminder;
    // 使用账号持久化的 loginBuffer 免扫码续发一次性 wx.login code
    async function refreshAccountCode(accountId) {
        const data = store.getAccounts();
        const acc = (data.accounts || []).find(a => String(a.id) === String(accountId));
        if (!acc || !String(acc.loginBuffer || '').trim())
            return null;
        try {
            const newCode = await reissueWxLoginCode(String(acc.loginBuffer), TARGET_APP_ID);
            if (!newCode)
                return null;
            store.addOrUpdateAccount({ id: String(acc.id), code: newCode });
            return newCode;
        }
        catch (e) {
            log('错误', `账号 ${accountId} 自动续码失败: ${e && e.message ? e.message : e}`, { accountId });
            return null;
        }
    }
    const { startWorker, stopWorker, restartWorker, callWorkerApi } = createWorkerManager({
        fork,
        WorkerThread: Worker,
        runtimeMode,
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs: GLOBAL_LOGS,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
        addOrUpdateAccount: store.addOrUpdateAccount,
        deleteAccount: store.deleteAccount,
        refreshAccountCode,
        onStatusSync: (accountId, status, accountName) => {
            runtimeEvents.emit('status', { accountId, status, accountName });
            if (onStatusSync)
                onStatusSync(accountId, status, accountName);
        },
        onWorkerLog: (entry, accountId, accountName) => {
            runtimeEvents.emit('worker_log', { entry, accountId, accountName });
            if (onLog)
                onLog(entry, accountId, accountName);
        },
    });
    const dataProvider = createDataProvider({
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        store,
        getAccounts: store.getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        buildConfigSnapshotForAccount,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
    });
    runtimeEvents.on('log', (entry) => {
        if (onLog)
            onLog(entry, entry && entry.accountId ? entry.accountId : '', entry && entry.accountName ? entry.accountName : '');
    });
    runtimeEvents.on('account_log', (entry) => {
        if (onAccountLog)
            onAccountLog(entry);
    });
    function broadcastConfigToWorkers(targetAccountId = '') {
        const targetId = String(targetAccountId || '').trim();
        for (const [accId, worker] of Object.entries(workers)) {
            if (targetId && String(accId) !== targetId)
                continue;
            const snapshot = buildConfigSnapshotForAccount(accId);
            try {
                worker.process.send({ type: 'config_sync', config: snapshot });
            }
            catch {
                // ignore IPC failures for exited workers
            }
        }
    }
    function broadcastGameConfigReload() {
        for (const worker of Object.values(workers)) {
            try {
                worker.process.send({ type: 'reload_config' });
            }
            catch {
                // ignore IPC failures for exited workers
            }
        }
    }
    function startAllAccounts() {
        const accounts = (store.getAccounts().accounts || []);
        if (accounts.length > 0) {
            log('系统', `发现 ${accounts.length} 个账号，正在启动...`);
            accounts.forEach((acc) => startWorker(acc));
        }
        else {
            log('系统', '未发现账号，请访问管理面板添加账号');
        }
    }
    async function start(options = {}) {
        const shouldStartAdminServer = options.startAdminServer !== false;
        const shouldAutoStartAccounts = options.autoStartAccounts !== false;
        const savedSystemConfig = store.getSystemConfig();
        if (savedSystemConfig) {
            updateRuntimeConfig(savedSystemConfig);
            log('系统', `已加载系统配置: serverUrl=${savedSystemConfig.serverUrl}, clientVersion=${savedSystemConfig.clientVersion}, platform=${savedSystemConfig.platform}`);
        }
        if (shouldStartAdminServer && startAdminServer) {
            startAdminServer(dataProvider);
        }
        if (shouldAutoStartAccounts) {
            startAllAccounts();
        }
    }
    function stopAllAccounts() {
        for (const accountId of Object.keys(workers)) {
            stopWorker(accountId);
        }
    }
    return {
        store,
        runtimeEvents,
        workers,
        dataProvider,
        start,
        startAllAccounts,
        stopAllAccounts,
        broadcastConfigToWorkers,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        log,
        addAccountLog,
    };
}
module.exports = {
    createRuntimeEngine,
};
