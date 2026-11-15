export {};

/**
 * 手游助手扫码渠道 - worker 侧客户端
 *
 * worker 在连接前通过 IPC 向主进程请求手游助手渠道的农场 Code。
 * 主进程无绑定凭据时回 ok:false，调用方继续使用原 Code（不影响其他登录渠道）。
 */

const { parentPort } = require('node:worker_threads');

interface PendingEntry {
    resolve: (value: string | null) => void;
    timer: any;
}

const pending = new Map<string, PendingEntry>();
let initialized = false;
let seq = 0;

function postToMaster(payload: any): boolean {
    if (process.send) {
        try {
            process.send(payload);
            return true;
        } catch {
            return false;
        }
    }
    if (parentPort) {
        try {
            parentPort.postMessage(payload);
            return true;
        } catch {
            return false;
        }
    }
    return false;
}

function onMasterMessage(handler: (msg: any) => void): void {
    if (process.send) process.on('message', handler);
    if (parentPort) parentPort.on('message', handler);
}

function settle(requestId: string, code: string | null): void {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(code);
}

function init(): void {
    if (initialized) return;
    initialized = true;
    onMasterMessage((msg: any) => {
        if (!msg || msg.type !== 'gameassist_code_response') return;
        settle(String(msg.id || ''), msg.ok && msg.code ? String(msg.code) : null);
    });
}

/**
 * 请求主进程从手游助手扫码渠道取新 Code。
 * 无凭据/超时/非 IPC 环境返回 null，调用方继续原流程。
 */
export function requestCode(reason: string = 'before_connect', timeoutMs: number = 25000): Promise<string | null> {
    if (process.env.NODE_TEST_CONTEXT) return Promise.resolve(null);
    init();
    const requestId = `${process.pid || 'w'}-${Date.now()}-${++seq}`;
    return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => settle(requestId, null), timeoutMs);
        if (timer && timer.unref) timer.unref();
        pending.set(requestId, { resolve, timer });
        if (!postToMaster({ type: 'gameassist_code_request', id: requestId, reason })) {
            settle(requestId, null);
        }
    });
}
