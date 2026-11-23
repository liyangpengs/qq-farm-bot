import { parentPort } from 'node:worker_threads';
import { wireError } from './ipc';

const network = require('../utils/network');
const { loadProto, types } = require('../utils/proto');
const { updateRuntimeConfig } = require('../config/config');
const port = parentPort!;
let epoch = 0;
let bound = false;
let sceneUncertain = false;
let visit: { method: string; gid: string } | undefined;
const jobs = new Map<number, { cancelled: boolean; deny?: (err: Error) => void; allow?: () => void }>();
const inFlight = new Set<Promise<any>>();
const released = () => new Error('此后端已释放会话');

function event(name: string, data: any) { port.postMessage({ event: name, data }); }
function telemetry() { event('telemetry', network.getSessionTelemetry()); }

network.networkEvents.on('sessionTelemetry', telemetry);
network.networkEvents.on('sessionNotify', (buf: Buffer) => event('notify', buf.toString('base64')));
network.networkEvents.on('ws_error', (data: any) => event('ws_error', data));
network.networkEvents.on('disconnected', (data: any) => event('disconnected', data));
network.networkEvents.on('kickout', (data: any) => {
    event('kickout', data);
    event('disconnected', { source: 'kickout', reason: data.reason });
});

async function open(config: any) {
    updateRuntimeConfig({
        platform: config.platform, serverUrl: config.systemServerUrl, timeZone: config.systemTimeZone,
        clientVersion: config.systemClientVersion, wxClientVersion: config.systemWxClientVersion, deviceInfo: config.systemDeviceInfo,
    });
    await loadProto();
    await new Promise<void>((resolve, reject) => {
        const onDisconnect = (data: any) => reject(new Error(data.reason || '游戏连接已断开'));
        network.networkEvents.once('disconnected', onDisconnect);
        network.connect(config.code, () => { network.networkEvents.off('disconnected', onDisconnect); resolve(); });
    });
    event('online', {});
    return network.getSessionSnapshot();
}

async function request(id: number, owner: number, params: any) {
    const job: { cancelled: boolean; deny?: (err: Error) => void; allow?: () => void } = { cancelled: false };
    jobs.set(id, job);
    const { service, method, options } = params;
    const body = Buffer.from(params.body, 'base64');
    const beforeSend = () => bound && epoch === owner && !job.cancelled ? null : released();
    const scene = service === 'gamepb.globalscenepb.GlobalSceneService' && method === 'PlayerSceneLogin';
    const visiting = service === 'gamepb.visitpb.VisitService';
    const enterType = visiting && (method === 'Enter' ? types.VisitEnterRequest : method === 'EnterHomestead' ? types.RanchEnterHomesteadRequest : null);
    const entry = enterType ? { method, gid: enterType.decode(body).host_gid.toString() } : undefined;
    const previousVisit = visit;
    const previousSceneUncertain = sceneUncertain;
    let sent = false;
    try {
        const result = network.sendMsgAsync(service, method, body, {
            ...options, beforeSend,
            prepareSend: params.guarded ? async () => {
                const blocked = beforeSend();
                if (blocked) throw blocked;
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('后端未确认发送')), 1500);
                    job.allow = () => { clearTimeout(timer); resolve(); };
                    job.deny = err => { clearTimeout(timer); reject(err); };
                    port.postMessage({ id, prepare: true });
                });
            } : undefined,
            onSent: () => { sent = true; if (entry) visit = entry; if (scene) sceneUncertain = true; },
        });
        telemetry();
        const reply = await result;
        if (scene) {
            const decoded = types.PlayerSceneLoginReply.decode(reply.body);
            const requested = types.PlayerSceneLoginRequest.decode(body).global_scene_id;
            const sceneData = requested === 2 ? decoded.big_farm_scene_ext_data : decoded.farm_scene_ext_data;
            if (decoded.global_scene_id !== requested || !sceneData?.length) throw new Error('游戏场景登录回包不完整');
            network.getUserState().globalSceneId = requested;
            sceneUncertain = false;
        }
        if (visiting && (method === 'Leave' || method === 'LeaveHomestead')) visit = undefined;
        return { body: Buffer.from(reply.body).toString('base64'), meta: reply.meta?.toJSON?.() || reply.meta };
    } catch (err: any) {
        if (sent && err.name === 'GatewayError') {
            if (entry && visit === entry) visit = previousVisit;
            if (scene) sceneUncertain = previousSceneUncertain;
        }
        throw err;
    } finally { jobs.delete(id); telemetry(); }
}

async function resume(owner: number) {
    // 等待原后端已发的请求结算；新后端不会重放这些操作。
    await Promise.allSettled([...inFlight]);
    const check = () => { if (!bound || epoch !== owner) throw released(); };
    check();
    if (visit) {
        const ranch = visit.method === 'EnterHomestead';
        const type = ranch ? types.RanchLeaveHomesteadRequest : types.VisitLeaveRequest;
        const body = type.encode(type.fromObject({ host_gid: visit.gid })).finish();
        await network.sendMsgAsync('gamepb.visitpb.VisitService', ranch ? 'LeaveHomestead' : 'Leave', body);
        visit = undefined;
    }
    check();
    if (sceneUncertain || network.getUserState().globalSceneId !== 1) {
        await network.loginGameScene(1);
        sceneUncertain = false;
    }
    check();
    return network.getSessionSnapshot();
}

port.on('message', message => {
    const { op, id, params } = message;
    if (op === 'bind' || op === 'unbind') {
        epoch = message.epoch;
        bound = op === 'bind';
        for (const job of jobs.values()) { job.cancelled = true; job.deny?.(released()); }
        return;
    }
    if (op === 'decision' || op === 'cancel') {
        if (message.epoch !== epoch) return;
        const job = jobs.get(id);
        if (job && op === 'decision' && message.ok) job.allow?.();
        else if (job) { job.cancelled = true; job.deny?.(new Error(message.error?.message || '请求已取消')); }
        return;
    }
    const task = op === 'open' ? open(params) : op === 'resume' ? resume(message.epoch) : request(id, message.epoch, params);
    if (op === 'request' || op === 'resume') inFlight.add(task);
    void task.then(result => port.postMessage({ id, ok: true, result }),
        err => port.postMessage({ id, ok: false, error: wireError(err) })).finally(() => inFlight.delete(task));
});
