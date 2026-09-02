"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 主程序 - 进程管理器
 * 负责启动 Web 面板，并管理多个 Bot 子进程
 */
const path = require('node:path');
const fs = require('node:fs');
// tsx/bun 直接跑 client.ts 时用 src，避免 stale dist 缺新路由。
// node client.js / 打包产物仍优先加载已编译的 dist。
const runningFromSource = /\.[cm]?tsx?$/.test(__filename);
const distDir = path.join(__dirname, 'dist');
const baseDir = !runningFromSource && fs.existsSync(distDir) ? './dist' : './src';
const { startAdminServer, emitRealtimeStatus, emitRealtimeLog, emitRealtimeAccountLog, } = require(`${baseDir}/controllers/admin`);
const { createRuntimeEngine } = require(`${baseDir}/runtime/runtime-engine`);
const { createModuleLogger } = require(`${baseDir}/services/logger`);
const mainLogger = createModuleLogger('main');
// 打包后 worker 由当前可执行文件以 --worker 模式启动
const isWorkerProcess = process.env.FARM_WORKER === '1';
if (isWorkerProcess) {
    require(`${baseDir}/core/worker`);
}
else {
    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        startAdminServer,
        onStatusSync: (accountId, status) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry, accountId) => {
            // 确保日志条目包含 accountId
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry) => {
            emitRealtimeAccountLog(entry);
        },
    });
    runtimeEngine.start({
        startAdminServer: true,
        autoStartAccounts: true,
    }).catch((err) => {
        mainLogger.error('runtime bootstrap failed', { error: err && err.message ? err.message : String(err) });
    });
}
