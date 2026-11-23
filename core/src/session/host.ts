import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { acquireExclusiveLock, encodeFrame, FrameDecoder, readLockMetadata, SESSION_IPC_VERSION } from '@qq-farm-bot/session-contract';
import { wireError } from './ipc';

const { getRuntimePaths } = require('../config/runtime-paths');
const paths = getRuntimePaths();
const hostInstanceId = randomUUID();
const releaseId = process.env.FARM_RELEASE_ID || 'dev';
const sessions = new Map<string, GatewaySession>();
const peers = new Set<Peer>();

interface Peer {
    socket: net.Socket;
    role?: 'backend' | 'control';
    instanceId?: string;
    session?: GatewaySession;
    jobs: Map<string, number>;
}

function send(peer: Peer, frame: any) {
    if (!peer.socket.destroyed) peer.socket.write(encodeFrame(frame));
}

class GatewaySession {
    readonly sessionId = randomUUID();
    readonly worker: Worker;
    owner?: Peer;
    opening?: Promise<any>;
    private epoch = 0;
    private seq = 0;
    private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; peer?: Peer; requestId?: string }>();
    lifecycle = 'CONNECTING';
    businessState = 'DETACHED';
    onlineAt = 0;
    heartbeatReplies = 0;

    constructor(readonly accountKey: string, readonly accountId: string, readonly platform: string) {
        const source = __filename.endsWith('.ts');
        this.worker = new Worker(path.join(__dirname, source ? 'gateway-worker.ts' : 'gateway-worker.js'), {
            env: { ...process.env, FARM_GATEWAY_WORKER: '1', FARM_ACCOUNT_ID: accountId, FARM_DATA_DIR: paths.hostDataDir },
            ...(source ? { execArgv: ['--require', 'tsx/cjs'] } : {}),
        });
        this.worker.on('message', message => this.receive(message));
        this.worker.once('error', err => this.finish(err));
        this.worker.once('exit', code => this.finish(new Error(`网关工作进程已退出 (${  code  })`)));
    }

    summary() {
        return {
            sessionId: this.sessionId, accountId: this.accountId, accountKey: this.accountKey, platform: this.platform,
            lifecycle: this.lifecycle, businessState: this.businessState, onlineAt: this.onlineAt,
            attachedBackendId: this.owner?.instanceId || '', heartbeatReplies: this.heartbeatReplies,
        };
    }

    bind(peer: Peer) {
        if (this.owner || peer.session) throw new Error('会话仍由另一个连接持有');
        this.owner = peer;
        peer.session = this;
        this.businessState = 'ATTACHING';
        this.worker.postMessage({ op: 'bind', epoch: ++this.epoch });
    }

    unbind(peer: Peer) {
        if (this.owner !== peer) return;
        this.owner = undefined;
        peer.session = undefined;
        peer.jobs.clear();
        this.businessState = 'DETACHED';
        this.worker.postMessage({ op: 'unbind', epoch: ++this.epoch });
    }

    call(op: string, params: any, peer?: Peer, requestId?: string): Promise<any> {
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, peer, requestId });
            if (peer && requestId) peer.jobs.set(requestId, id);
            this.worker.postMessage({ id, op, params, epoch: this.epoch });
        });
    }

    decision(peer: Peer, frame: any) {
        const id = peer.jobs.get(frame.id);
        if (this.owner === peer && id !== undefined) {
            this.worker.postMessage({ op: frame.kind, id, epoch: this.epoch, ok: frame.ok, error: frame.error });
        }
    }

    private receive(message: any) {
        if (message.event) {
            if (message.event === 'telemetry') this.heartbeatReplies = message.data.heartbeatReplies;
            if (message.event === 'online') {
                this.lifecycle = 'ONLINE';
                this.onlineAt = Date.now();
            }
            if (this.owner) {
                try { send(this.owner, { kind: 'event', event: message.event, data: message.data }); }
                catch { this.owner.socket.destroy(); }
            }
            if (message.event === 'disconnected') this.stop(message.data.reason || '游戏连接结束', false);
            return;
        }
        const job = this.pending.get(message.id);
        if (!job) return;
        if (message.prepare) {
            if (job.peer && job.peer === this.owner) send(job.peer, { kind: 'prepare', id: job.requestId });
            return;
        }
        this.pending.delete(message.id);
        if (job.requestId) job.peer?.jobs.delete(job.requestId);
        if (message.ok) job.resolve(message.result);
        else job.reject(Object.assign(new Error(message.error?.message), message.error));
    }

    private finish(error: Error, notify = true) {
        if (this.lifecycle === 'CLOSED') return;
        this.lifecycle = 'CLOSED';
        if (sessions.get(this.accountId) === this) sessions.delete(this.accountId);
        if (this.owner) {
            if (notify && !this.owner.socket.destroyed) send(this.owner, { kind: 'event', event: 'disconnected', data: { source: 'host_worker_exit', reason: error.message } });
            this.owner.session = undefined;
            this.owner.jobs.clear();
            this.owner = undefined;
        }
        for (const job of this.pending.values()) job.reject(error);
        this.pending.clear();
    }

    stop(reason: string, notify = true) {
        this.finish(new Error(reason), notify);
        return this.worker.terminate();
    }
}

function hostInfo() {
    return { ready: true, hostInstanceId, releaseId, ipcVersion: SESSION_IPC_VERSION, pid: process.pid, sessionCount: sessions.size };
}

async function dispatch(peer: Peer, frame: any) {
    const { op, params = {} } = frame;
    if (op === 'hello') {
        if (peer.role || params.ipcVersion !== SESSION_IPC_VERSION || !['backend', 'control'].includes(params.role)) throw new Error('不兼容的会话 IPC 握手');
        if (params.role === 'backend') {
            const writer = readLockMetadata(path.join(paths.runtimeDir, 'backend-writer.lock'));
            if (!writer || writer.instanceId !== params.instanceId) throw new Error('后端实例未持有运行锁');
        }
        peer.role = params.role;
        peer.instanceId = params.instanceId;
        return hostInfo();
    }
    if (!peer.role) throw new Error('需要先完成会话 IPC 握手');
    if (op === 'status') return hostInfo();
    if (op === 'listSessions') return { sessions: Array.from(sessions.values(), session => session.summary()) };
    if (peer.role !== 'backend') throw new Error('此操作需要后端连接');
    const session = sessions.get(String(params.accountId));
    if (op === 'openSession') {
        if (session || peer.session) throw new Error('账号已有会话');
        if (!params.accountId || !params.accountKey || !params.config?.code) throw new Error('缺少账号标识或登录凭据');
        const fresh = new GatewaySession(params.accountKey, String(params.accountId), params.config.platform || 'qq');
        sessions.set(fresh.accountId, fresh);
        fresh.bind(peer);
        try {
            fresh.opening = fresh.call('open', params.config);
            const snapshot = await fresh.opening;
            return { session: fresh.summary(), snapshot };
        } catch (err) { await fresh.stop('登录未完成'); throw err; }
        finally { fresh.opening = undefined; }
    }
    if (op === 'attachSession') {
        if (!session || session.accountKey !== params.accountKey || session.sessionId !== params.sessionId) throw new Error('已在线会话不匹配');
        if (session.owner && session.owner.instanceId !== peer.instanceId) {
            const previousOwner = session.owner;
            session.unbind(previousOwner);
            previousOwner.socket.destroy();
        }
        session.bind(peer);
        try {
            if (session.opening) await session.opening;
            if (session.owner !== peer) throw new Error('会话连接已经释放');
            const snapshot = await session.call('resume', {});
            return { session: session.summary(), snapshot };
        }
        catch (error) { session.unbind(peer); throw error; }
    }
    // 管理面板显式停止账号时，工作进程即使已退出也能关闭对应的游戏连接。
    if (op === 'stopAccount') {
        if (session && session.accountKey === params.accountKey && (!session.owner || session.owner.instanceId === peer.instanceId)) {
            await session.stop('账号已停止');
        }
        return {};
    }
    const active = peer.session;
    if (!active || active.owner !== peer) throw new Error('后端已释放此会话');
    switch (op) {
        case 'request': return active.call('request', params, peer, frame.id);
        case 'activate': active.businessState = 'ACTIVE'; return {};
        case 'detach': active.unbind(peer); return {};
        case 'close': await active.stop('账号已停止'); return {};
        default: throw new Error(`未知的会话操作: ${  op}`);
    }
}

async function main() {
    const lock = acquireExclusiveLock(path.join(paths.runtimeDir, 'session-host.lock'), { role: 'host', instanceId: hostInstanceId, releaseId, nonce: randomUUID() });
    process.once('exit', () => lock.release());
    const endpoint = paths.sessionSocketEndpoint;
    if (process.platform !== 'win32') {
        fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
        if (fs.existsSync(endpoint)) {
            if (!fs.lstatSync(endpoint).isSocket()) throw new Error('IPC 路径不是套接字');
            const active = await new Promise<boolean>((resolve, reject) => {
                const probe = net.createConnection(endpoint);
                probe.once('connect', () => { probe.destroy(); resolve(true); });
                probe.once('error', (e: NodeJS.ErrnoException) => e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? resolve(false) : reject(e));
            });
            if (active) throw new Error('IPC 套接字已在使用');
            if (fs.existsSync(endpoint)) fs.unlinkSync(endpoint);
        }
    }
    const server = net.createServer(socket => {
        const peer: Peer = { socket, jobs: new Map() };
        peers.add(peer);
        const decoder = new FrameDecoder(frame => {
            if (frame?.kind === 'cancel' || frame?.kind === 'decision') { peer.session?.decision(peer, frame); return; }
            if (frame?.kind !== 'req' || typeof frame.id !== 'string') { socket.destroy(); return; }
            void dispatch(peer, frame).then(result => send(peer, { kind: 'res', id: frame.id, ok: true, result }))
                .catch(err => send(peer, { kind: 'res', id: frame.id, ok: false, error: wireError(err) }));
        }, () => socket.destroy());
        socket.on('data', chunk => decoder.push(chunk));
        socket.on('error', () => socket.destroy());
        socket.once('close', () => { peer.session?.unbind(peer); peers.delete(peer); });
    });
    server.listen(endpoint, () => { if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600); });
    const shutdown = async () => {
        server.close();
        for (const peer of peers) peer.socket.destroy();
        await Promise.all([...sessions.values()].map(session => session.stop('会话宿主已停止')));
        lock.release();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

void main().catch(err => { console.error('[session-host]', err.message); process.exitCode = 1; });
