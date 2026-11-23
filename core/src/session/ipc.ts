import { EventEmitter } from 'node:events';
import net from 'node:net';
import { encodeFrame, FrameDecoder, SESSION_IPC_VERSION } from '@qq-farm-bot/session-contract';

const { getRuntimePaths } = require('../config/runtime-paths');

export function wireError(cause: any) {
    return {
        name: cause?.name, message: String(cause?.message ?? cause), code: cause?.code,
        serviceName: cause?.serviceName, methodName: cause?.methodName, errorMessage: cause?.errorMessage,
        clientSeq: cause?.clientSeq, outcomeUnknown: cause?.outcomeUnknown,
    };
}

interface SendHooks {
    beforeSend?: () => Error | null;
    onSent?: () => void;
}

interface PendingCall {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    hooks?: SendHooks;
    approved?: boolean;
}

export class SessionClient extends EventEmitter {
    private readonly socket: net.Socket;
    private readonly calls = new Map<string, PendingCall>();
    private seq = 0;

    private constructor() {
        super();
        this.socket = net.createConnection(getRuntimePaths().sessionSocketEndpoint);
        const decoder = new FrameDecoder(frame => this.receive(frame), err => this.socket.destroy(err));
        this.socket.on('data', data => decoder.push(data));
        this.socket.on('error', err => this.fail(err));
        this.socket.once('close', () => {
            this.fail(new Error('会话宿主连接已关闭'));
            this.emit('closed');
        });
    }

    static async open(role: 'control' | 'backend', timeoutMs = 3000): Promise<SessionClient> {
        const client = new SessionClient();
        try {
            await client.call('hello', { ipcVersion: SESSION_IPC_VERSION, role, instanceId: process.env.FARM_BACKEND_INSTANCE_ID }, timeoutMs);
            return client;
        } catch (err) {
            client.close();
            throw err;
        }
    }

    call(op: string, params: any = {}, timeoutMs = 3000, hooks?: SendHooks): Promise<any> {
        if (this.socket.destroyed) return Promise.reject(new Error('会话宿主连接已关闭'));
        const id = String(++this.seq);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.calls.get(id);
                this.calls.delete(id);
                if (!this.socket.destroyed) this.socket.write(encodeFrame({ kind: 'cancel', id }));
                reject(Object.assign(new Error(`会话宿主请求超时: ${  op}`), { outcomeUnknown: Boolean(pending?.approved) }));
            }, timeoutMs);
            this.calls.set(id, { resolve, reject, timer, hooks });
            try { this.socket.write(encodeFrame({ kind: 'req', id, op, params })); }
            catch (e) { clearTimeout(timer); this.calls.delete(id); reject(e); }
        });
    }

    private receive(frame: any): void {
        if (frame.kind === 'event') {
            this.emit('event', frame.event, frame.data);
            return;
        }
        const call = this.calls.get(frame.id);
        if (!call) return;
        if (frame.kind === 'prepare') {
            try {
                const blocked = call.hooks?.beforeSend?.();
                if (blocked) throw blocked;
                // 从允许发送开始，掉线后按可能已发处理，不能再次扣费。
                call.hooks?.onSent?.();
                call.approved = true;
                this.socket.write(encodeFrame({ kind: 'decision', id: frame.id, ok: true }));
            } catch (err) {
                this.socket.write(encodeFrame({ kind: 'decision', id: frame.id, ok: false, error: wireError(err) }));
            }
            return;
        }
        if (frame.kind !== 'res') return;
        clearTimeout(call.timer);
        this.calls.delete(frame.id);
        if (frame.ok) call.resolve(frame.result);
        else call.reject(Object.assign(new Error(frame.error?.message || '会话请求失败'), frame.error));
    }

    private fail(error: Error) {
        for (const call of this.calls.values()) {
            clearTimeout(call.timer);
            call.reject(Object.assign(new Error(error.message), { outcomeUnknown: Boolean(call.approved) }));
        }
        this.calls.clear();
    }

    close() { this.socket.destroy(); }
}

export async function listHostedSessions(): Promise<any[]> {
    const client = await SessionClient.open('backend');
    try { return (await client.call('listSessions')).sessions; }
    finally { client.close(); }
}


export function accountSessionKey(account: { id: string; createdAt: number }) {
    return JSON.stringify([String(account.id), account.createdAt]);
}

export function findAccountSession(sessions: any[], account: { id: string; createdAt: number; platform: string }) {
    const key = accountSessionKey(account);
    return sessions.find(s => s.accountKey === key && s.platform === account.platform);
}

export async function stopHostedAccount(accountId: string, accountKey: string) {
    const client = await SessionClient.open('backend');
    try { await client.call('stopAccount', { accountId, accountKey }); }
    finally { client.close(); }
}

export async function getServiceSummary() {
    let hostRunning = false;
    if (process.env.FARM_SESSION_SOCKET) {
        try {
            const client = await SessionClient.open('control', 800);
            client.close();
            hostRunning = true;
        } catch { /* 仍需返回后端实例，便于控制脚本诊断宿主是否可用。 */ }
    }
    return { backendInstanceId: process.env.FARM_BACKEND_INSTANCE_ID || '', backendReleaseId: process.env.FARM_RELEASE_ID || 'dev', hostRunning };
}
