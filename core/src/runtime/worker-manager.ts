export {};
const { applyKnownFriendGidChange } = require('../app/known-friend-gid-sync');
const { getHttpRequestId } = require('../app/http-request-context');
const { sharedInviteBatch } = require('../app/shared-invite-batch');
const { createScheduler } = require('../services/scheduler');

const DEFAULT_API_CALL_TIMEOUT_MS = 10000;
// 好友现场天气需要逐个 Enter/Leave，单批最多 5 位好友；
// 好友列表只读缓存或拉一次名单，给的余量少一些。
const API_CALL_TIMEOUTS_MS: Record<string, number> = {
    scanWeatherFriends: 60000,
    getFriends: 30000,
    getWeatherFriends: 30000,
};

interface WorkerManagerOptions {
    fork: any;
    WorkerThread: any;
    runtimeMode?: string;
    processRef: any;
    mainEntryPath: string;
    workerScriptPath: string;
    workers: Record<string, any>;
    globalLogs: any[];
    log: (tag: string, msg: string, extra?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    normalizeStatusForPanel: (data: any, accountId: string, accountName: string) => any;
    buildConfigSnapshotForAccount: (accountId: string) => any;
    getOfflineAutoDeleteMs: () => number;
    triggerOfflineReminder: (payload: any) => void;
    sendConfiguredPush?: (payload: any) => Promise<void> | void;
    addOrUpdateAccount: (acc: any) => any;
    deleteAccount: (id: string) => void;
    defaultApiCallTimeoutMs?: number;
    onStatusSync?: (accountId: string, status: any, accountName?: string) => void;
    onWorkerLog?: (entry: any, accountId: string, accountName?: string) => void;
    onTaskMetrics?: (accountId: string, snapshot: any) => void;
}

function createWorkerManager(options: WorkerManagerOptions) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
        addOrUpdateAccount,
        deleteAccount,
        onStatusSync,
        onWorkerLog,
        onTaskMetrics,
    } = options;
    const managerScheduler = createScheduler('worker_manager');
    const useThreadRuntime = runtimeMode === 'thread' && !(processRef as any).pkg && typeof WorkerThread === 'function';
    const defaultApiCallTimeoutMs = Math.max(
        1,
        Number(options.defaultApiCallTimeoutMs) || DEFAULT_API_CALL_TIMEOUT_MS,
    );

    function createThreadWorker(account: any): any {
        const workerOptions: any = {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
            },
        };
        // When running from source with tsx, configure worker to use tsx
        if (workerScriptPath.endsWith('.ts')) {
            workerOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        const worker = new WorkerThread(workerScriptPath, workerOptions);
        worker.send = (payload: any) => worker.postMessage(payload);
        worker.kill = () => worker.terminate();
        return worker;
    }

    function createForkWorker(account: any): any {
        if ((processRef as any).pkg) {
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || '') },
            });
        }
        const forkOptions: any = {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || '') },
        };
        if (workerScriptPath.endsWith('.ts')) {
            forkOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        return fork(workerScriptPath, [], forkOptions);
    }

    function createWorkerProcess(account: any): any {
        if (useThreadRuntime) return createThreadWorker(account);
        return createForkWorker(account);
    }

    function startWorker(account: any): boolean {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false;

        log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });

        let child: any = null;
        try {
            child = createWorkerProcess(account);
        } catch (err: any) {
            const reason = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            return false;
        }

        const inviteBatchClaim = String(account.platform || '').toLowerCase() === 'wx'
            ? sharedInviteBatch.claim(account.id)
            : null;
        workers[account.id] = {
            process: child,
            status: null,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            nick: account.nick || '',
            avatar: account.avatar || '',
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            terminalHandled: false,
            wsError: null,
            knownFriendGidsRevision: 0,
            inviteBatchClaim,
        };

        const initialConfigSnapshot = buildConfigSnapshotForAccount(account.id);
        child.send({
            type: 'start',
            config: {
                code: account.code,
                platform: account.platform,
                systemTimeZone: initialConfigSnapshot.systemTimeZone,
                systemServerUrl: initialConfigSnapshot.systemServerUrl,
                systemClientVersion: initialConfigSnapshot.systemClientVersion,
                inviteBatch: inviteBatchClaim,
            },
        });
        child.send({ type: 'config_sync', config: initialConfigSnapshot });

        child.on('message', (msg: any) => {
            handleWorkerMessage(account.id, child, msg);
        });

        child.on('error', (err: any) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${err && err.message ? err.message : err}`, { accountId: String(account.id), accountName: account.name });
        });

        child.on('exit', (code: number, signal: string) => {
            const current = workers[account.id];
            if (!current || current.process !== child) return;
            const displayName = current.name || account.name;
            log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });

            managerScheduler.clear(`force_kill_${account.id}`);
            if (current.inviteBatchClaim) {
                sharedInviteBatch.release(account.id, current.inviteBatchClaim.claimId);
                current.inviteBatchClaim = null;
            }

            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    } catch {}
                }
                current.requests.clear();
            }

            if (current && current.process === child) {
                delete workers[account.id];
            }
        });
        return true;
    }

    function stopWorker(accountId: string): void {
        const worker = workers[accountId];
        if (!worker) return;

        const proc = worker.process;
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
            }
        });
    }

    function restartWorker(account: any): void {
        if (!account) return;
        const accountId = account.id;
        const worker = workers[accountId];
        if (!worker) { startWorker(account); return; }
        const proc = worker.process;
        const startOnce = () => {
            const current = workers[accountId];
            if (!current) { startWorker(account); return; }
            if (current.process !== proc) return;
            delete workers[accountId];
            startWorker(account);
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            startOnce();
            return;
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
    }

    function errorFromWorkerPayload(payload: any): Error & { code?: string | number } {
        if (!payload || typeof payload !== 'object') return new Error(String(payload || 'Worker API error'));
        const error: Error & { code?: string | number } = new Error(String(payload.message || 'Worker API error'));
        if (payload.name) error.name = String(payload.name);
        if (payload.code !== undefined && payload.code !== null && payload.code !== '') error.code = payload.code;
        return error;
    }

    function handleWorkerMessage(accountId: string, sourceProcess: any, msg: any): void {
        const worker = workers[accountId];
        if (!worker || worker.process !== sourceProcess) return;

        if (msg.type === 'status_sync') {
            worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }

            const profile = msg.data && msg.data.status && typeof msg.data.status === 'object'
                ? msg.data.status
                : {};
            const accountUpdate: any = { id: accountId };
            let profileChanged = false;

            if (profile.name) {
                const newNick = String(profile.name).trim();
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    if (worker.nick !== newNick) {
                        const oldNick = worker.nick;
                        worker.nick = newNick;
                        accountUpdate.nick = newNick;
                        profileChanged = true;
                        if (oldNick !== newNick) {
                            log('系统', `已同步账号昵称: ${oldNick || 'None'} -> ${newNick}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }

            const newAvatar = String(profile.avatarUrl || profile.avatar_url || '').trim();
            if (newAvatar && worker.avatar !== newAvatar) {
                worker.avatar = newAvatar;
                accountUpdate.avatar = newAvatar;
                profileChanged = true;
            }

            if (profileChanged) {
                addOrUpdateAccount(accountUpdate);
            }

            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
            } else if (!worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince) worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs();
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    worker.autoDeleteTriggered = true;
                    const offlineMin = Math.floor(offlineMs / 60000);
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        reason: 'offline_timeout',
                        offlineMs,
                    });
                    addAccountLog(
                        'offline_delete',
                        `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                        accountId,
                        worker.name,
                        { reason: 'offline_timeout', offlineMs },
                    );
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                    } catch (e: any) {
                        log('错误', `删除离线账号失败: ${e.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            const logEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000) worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000) globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        } else if (msg.type === 'task_metrics') {
            if (typeof onTaskMetrics === 'function') onTaskMetrics(accountId, msg.data);
        } else if (msg.type === 'error') {
            const workerError = errorFromWorkerPayload(msg.error);
            log('错误', `账号[${accountId}]进程报错: ${workerError.message}`, {
                accountId: String(accountId),
                accountName: worker.name,
                errorCode: workerError.code,
                errorName: workerError.name,
            });
        } else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            worker.wsError = { code, message, at: Date.now() };
            if (code === 400) {
                addAccountLog(
                    'ws_400',
                    `账号 ${worker.name} 登录失效，请更新 Code`,
                    accountId,
                    worker.name,
                );
            }
        } else if (msg.type === 'account_kicked') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const reason = msg.reason || '未知';
            log('系统', `账号 ${worker.name} 被踢下线，已自动停止账号`, { accountId: String(accountId), accountName: worker.name });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
            });
            addAccountLog('kickout_stop', `账号 ${worker.name} 被踢下线，已自动停止`, accountId, worker.name, { reason });
            stopWorker(accountId);
        } else if (msg.type === 'account_disconnected') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const source = String(msg.source || 'ws_close');
            const code = Number(msg.code) || 0;
            const reason = String(msg.reason || '连接已断开');
            const phase = String(msg.phase || 'unknown');
            if (worker.status?.connection) worker.status.connection.connected = false;
            if (worker.requests.size > 0) {
                for (const [reqId, req] of worker.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${accountId}_${reqId}`);
                    try { req.reject(new Error('账号连接已断开')); } catch {}
                }
                worker.requests.clear();
            }
            log('系统', `账号 ${worker.name} 连接已断开，已停止运行并等待 Helper 刷新 Code 或重新扫码`, {
                accountId: String(accountId),
                accountName: worker.name,
                source,
                code,
                phase,
            });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `disconnect:${source}:${phase}:${code}`,
                offlineMs: 0,
            });
            addAccountLog(
                'disconnect_stop',
                `账号 ${worker.name} 连接已断开，已停止运行并等待 Helper 刷新 Code 或重新扫码`,
                accountId,
                worker.name,
                { source, code, reason, phase, connectionId: Number(msg.connectionId) || 0 },
            );
            stopWorker(accountId);
        } else if (msg.type === 'api_call_started') {
            const id = Number(msg.id) || 0;
            const req = worker.requests.get(id);
            if (!req || req.started) return;
            req.started = true;
            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, req.timeoutMs, () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    req.reject(new Error('API Timeout'));
                }
            });
        } else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error) req.reject(errorFromWorkerPayload(error));
                else req.resolve(result);
                worker.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist: addToBlacklist } = require('../models/store');
                addToBlacklist(accountId, gid);
                log('好友', `已将好友 ${msg.friendName || `GID:${gid}`} 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason,
                });
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    worker_process.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        } else if (msg.type === 'known_friend_gids_sync') {
            const { getKnownFriendGids, setKnownFriendGids } = require('../models/store');
            const revision = Number(msg.revision) || 0;
            const baseGids: number[] = Array.isArray(msg.baseGids)
                ? msg.baseGids.map(Number).filter((gid: number) => Number.isFinite(gid) && gid > 0)
                : [];
            const gids: number[] = Array.isArray(msg.gids)
                ? msg.gids.map(Number).filter((gid: number) => Number.isFinite(gid) && gid > 0)
                : [];
            let saved: number[] = getKnownFriendGids(accountId);
            if (revision > worker.knownFriendGidsRevision) {
                saved = setKnownFriendGids(accountId, applyKnownFriendGidChange(saved, baseGids, gids));
                worker.knownFriendGidsRevision = revision;
                log('好友', `已同步并持久化 ${saved.length} 个好友 GID`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendCount: saved.length,
                });
            }
            worker.process.send({ type: 'known_friend_gids_ack', revision, gids: saved });
        } else if (msg.type === 'invite_batch_complete') {
            const claim = worker.inviteBatchClaim;
            if (!claim || Number(msg.claimId) !== Number(claim.claimId)) return;
            try {
                const cleared = sharedInviteBatch.complete(accountId, claim.claimId);
                if (!cleared) {
                    log('邀请', 'share.txt 在处理期间发生变化，已保留文件内容', {
                        accountId: String(accountId),
                        accountName: worker.name,
                    });
                }
            } catch (error: any) {
                log('错误', `清空 share.txt 失败: ${error?.message || error}`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                });
            } finally {
                worker.inviteBatchClaim = null;
            }
        } else if (msg.type === 'invite_batch_release') {
            const claim = worker.inviteBatchClaim;
            if (!claim || Number(msg.claimId) !== Number(claim.claimId)) return;
            sharedInviteBatch.release(accountId, claim.claimId);
            worker.inviteBatchClaim = null;
        } else if (msg.type === 'push_notify') {
            const title = String(msg.title || '').trim();
            const content = String(msg.content || '').trim();
            if (!title || !content || typeof sendConfiguredPush !== 'function') return;
            Promise.resolve(sendConfiguredPush({
                title,
                content,
                accountId,
                accountName: worker.name,
            })).catch((e: any) => {
                log('错误', `事件提醒发送异常: ${e && e.message ? e.message : e}`);
            });
        }
    }

    function callWorkerApi(accountId: string, method: string, ...args: any[]): Promise<any> {
        const worker = workers[accountId];
        if (!worker) return Promise.reject(new Error('账号未运行'));
        if (worker.stopping || worker.terminalHandled) return Promise.reject(new Error('账号已离线'));

        return new Promise((resolve, reject) => {
            const id = worker.reqId++;
            const requestId = getHttpRequestId();
            worker.requests.set(id, {
                resolve,
                reject,
                started: false,
                timeoutMs: API_CALL_TIMEOUTS_MS[method] || defaultApiCallTimeoutMs,
            });

            worker.process.send({
                type: 'api_call',
                id,
                method,
                args,
                ...(requestId ? { requestId } : {}),
            });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
    };
}

module.exports = {
    createWorkerManager,
};
