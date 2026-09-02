export {};
const { Buffer } = require('node:buffer');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { CONFIG } = require('../config/config');
const { createScheduler } = require('../services/scheduler');
const { updateStatusFromLogin, updateStatusGold, updateStatusLevel } = require('../services/status');
const { recordOperation } = require('../services/stats');
const { types } = require('./proto');
const { toLong, toNum, syncServerTime, log, logWarn, sleep } = require('./utils');
const cryptoWasm = require('./crypto-wasm');
const { GatewayTokenProvider } = require('./gateway-token');
const { MAX_HEARTBEAT_MISSES, shouldTerminateForHeartbeat } = require('./keepalive-policy');
const { countBlockingQueuedRequests, shouldLogRequestPressure } = require('./request-pressure');
const {
    LOW_PRIORITY_IDLE_POLL_MS,
    LOW_PRIORITY_IDLE_WAIT_MAX_MS,
    LOW_PRIORITY_QUEUE_WAIT_MS,
    isGatewayIdleForLowPriority,
} = require('./low-priority-gate');
const {
    describeRequestClassMarker,
    isClassQueueFull,
    maxQueuedForClass,
    resolveRequestClass,
    selectDispatchIndex,
} = require('./request-priority');
const { getAmbientRequestClass } = require('./request-context');
const { startAceRuntime, stopAceRuntime } = require('../services/ace');

// ============ 事件发射器 (用于推送通知) ============
const networkEvents = new EventEmitter();

// ============ 内部状态 ============
type ConnectionPhase = 'connecting' | 'login' | 'online';
type RequestPriority = 'low' | 'normal' | 'high';
/** 请求班次，见 utils/request-priority.ts。 */
type RequestClass = 'critical' | 'foreground' | 'farm' | 'friend' | 'background';
type CriticalLane = 'heartbeat' | 'ace';

interface ConnectionContext {
    id: number;
    socket: WebSocket;
    phase: ConnectionPhase;
    intentionalClose: boolean;
    finalized: boolean;
    loginInitialized: boolean;
}

interface SendMsgOptions {
    timeoutMs?: number;
    expectedErrorCodes?: readonly number[];
    /** 兼容旧调用：high→critical、low→background、normal 视为「未表态」交给环境班次。 */
    priority?: RequestPriority;
    /** 显式指定班次，优先于 priority 与环境班次。 */
    requestClass?: RequestClass;
    criticalLane?: CriticalLane;
    expectReply?: boolean;
}

interface PendingRequest {
    callback: (err: Error | null, body?: Buffer, meta?: any) => void;
    expectedErrorCodes: Set<number>;
    serviceName?: string;
    methodName?: string;
    startedAt?: number;
    requestClass: RequestClass;
    criticalLane?: CriticalLane;
}

interface QueuedRequest {
    context: ConnectionContext;
    serviceName: string;
    methodName: string;
    bodyBytes: Buffer;
    expectedErrorCodes: Set<number>;
    resolve: (value: { body: Buffer; meta: any }) => void;
    reject: (reason: Error) => void;
    timeoutKey: string;
    queueWaitKey: string;
    seq: number | null;
    settled: boolean;
    requestClass: RequestClass;
    criticalLane?: CriticalLane;
    enqueuedAt: number;
    expectReply: boolean;
}

class GatewayError extends Error {
    code: number;
    serviceName: string;
    methodName: string;
    errorMessage: string;
    clientSeq: number;

    constructor(meta: any) {
        const code = toNum(meta && meta.error_code);
        const serviceName = String((meta && meta.service_name) || '');
        const methodName = String((meta && meta.method_name) || '');
        const errorMessage = String((meta && meta.error_message) || '');
        super(`${serviceName}.${methodName} 错误: code=${code} ${errorMessage}`.trim());
        this.name = 'GatewayError';
        this.code = code;
        this.serviceName = serviceName;
        this.methodName = methodName;
        this.errorMessage = errorMessage;
        this.clientSeq = toNum(meta && meta.client_seq);
    }
}

/** background 班次请求让路时抛出的错误：不是业务失败，而是「现在不该占用连接」。 */
class GatewayBusyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GatewayBusyError';
    }
}

let ws: WebSocket | null = null;
let currentConnection: ConnectionContext | null = null;
let nextConnectionId = 1;
let clientSeq: number = 1;
let serverSeq: number = 0;
const pendingCallbacks = new Map<number, PendingRequest>();
const requestQueue: QueuedRequest[] = [];
// Gateway 是单连接复用，并发预算与班次优先级全部集中在 utils/request-priority.ts。
// 这里只保留日志里要展示多少条在途请求。
const MAX_DESCRIBED_PENDING_REQUESTS = 6;
let nextRequestId = 1;
let wsErrorState = { code: 0, at: 0, message: '' };
let lastRequestPressureLogAt = 0;
const networkScheduler = createScheduler('network');
const gatewayTokens = new GatewayTokenProvider();
let lastHeartbeatResponse = Date.now();
let lastInboundAt = Date.now();
let heartbeatMissCount = 0;

function settleQueuedRequest(request: QueuedRequest, error?: Error, value?: { body: Buffer; meta: any }): void {
    if (request.settled) return;
    request.settled = true;
    networkScheduler.clear(request.timeoutKey);
    networkScheduler.clear(request.queueWaitKey);
    if (error) request.reject(error);
    else request.resolve(value!);
}

function pendingClassCount(requestClass: RequestClass): number {
    let count = 0;
    for (const pending of pendingCallbacks.values()) {
        if (pending.requestClass === requestClass) count += 1;
    }
    return count;
}

function pendingBusinessCount(): number {
    return pendingClassCount('foreground') + pendingClassCount('farm') + pendingClassCount('friend');
}

interface GatewayLoad {
    pending: number;
    queued: number;
    /** 队列里非 background 的请求数：只有这些代表「有人真的在等连接」。 */
    blockingQueued: number;
    criticalPending: number;
    businessPending: number;
    foregroundPending: number;
    backgroundPending: number;
    heartbeatMisses: number;
    oldestPendingAgeMs: number;
}

function oldestPendingAgeMs(): number {
    const now = Date.now();
    let oldest = 0;
    for (const pending of pendingCallbacks.values()) {
        if (!pending.startedAt) continue;
        const age = Math.max(0, now - pending.startedAt);
        if (age > oldest) oldest = age;
    }
    return oldest;
}

/** 后台任务用来判断「现在该不该占用连接」的负载快照。 */
function getGatewayLoad(): GatewayLoad {
    return {
        pending: pendingCallbacks.size,
        queued: requestQueue.length,
        blockingQueued: countBlockingQueuedRequests(requestQueue),
        criticalPending: pendingClassCount('critical'),
        businessPending: pendingBusinessCount(),
        foregroundPending: pendingClassCount('foreground'),
        backgroundPending: pendingClassCount('background'),
        heartbeatMisses: heartbeatMissCount,
        oldestPendingAgeMs: oldestPendingAgeMs(),
    };
}

function isGatewayIdleForBackground(): boolean {
    return isGatewayIdleForLowPriority(getGatewayLoad());
}

/**
 * 等网关空闲到可以插入后台请求；等不到就返回 false，由调用方整轮让路。
 * 只观察不排队，所以等待期间一点压力都不加给网关。
 */
async function waitForGatewayIdle(
    maxWaitMs: number = LOW_PRIORITY_IDLE_WAIT_MAX_MS,
    pollMs: number = LOW_PRIORITY_IDLE_POLL_MS,
): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, Number(maxWaitMs) || 0);
    for (;;) {
        if (isGatewayIdleForBackground()) return true;
        if (Date.now() >= deadline) return false;
        await sleep(Math.max(20, Number(pollMs) || LOW_PRIORITY_IDLE_POLL_MS));
    }
}

/**
 * 挑出下一个可发送的请求。分层与容量规则全部在 utils/request-priority.ts 里，
 * 这里只负责清掉已结算的队列项、把选中项摘出来。
 */
function takeDispatchableRequest(): QueuedRequest | null {
    for (let index = requestQueue.length - 1; index >= 0; index--) {
        if (requestQueue[index].settled) requestQueue.splice(index, 1);
    }
    if (requestQueue.length === 0) return null;
    const index = selectDispatchIndex(requestQueue, Array.from(pendingCallbacks.values()), Date.now());
    if (index < 0) return null;
    return requestQueue.splice(index, 1)[0];
}

function drainRequestQueue(): void {
    while (requestQueue.length > 0) {
        const request = takeDispatchableRequest();
        if (!request) break;

        if (!isCurrentConnection(request.context) || request.context.phase !== 'online') {
            settleQueuedRequest(request, new Error(`连接未打开: ${request.methodName}`));
            continue;
        }

        const seq = clientSeq;
        request.seq = seq;
        const pending: PendingRequest | undefined = request.expectReply ? {
            serviceName: request.serviceName,
            methodName: request.methodName,
            startedAt: Date.now(),
            requestClass: request.requestClass,
            criticalLane: request.criticalLane,
            expectedErrorCodes: request.expectedErrorCodes,
            callback: (err, body, meta) => {
                if (err) settleQueuedRequest(request, err);
                else settleQueuedRequest(request, undefined, { body: body!, meta });
                drainRequestQueue();
            },
        } : undefined;
        sendMsg(request.context, request.serviceName, request.methodName, request.bodyBytes, pending).then((sent) => {
            if (sent) {
                if (!request.expectReply) {
                    settleQueuedRequest(request, undefined, { body: Buffer.alloc(0), meta: {} });
                    drainRequestQueue();
                }
                return;
            }
            pendingCallbacks.delete(seq);
            settleQueuedRequest(request, new Error(`发送失败: ${request.methodName}`));
            drainRequestQueue();
        }).catch((error: any) => {
            pendingCallbacks.delete(seq);
            settleQueuedRequest(request, error instanceof Error ? error : new Error(String(error)));
            drainRequestQueue();
        });
    }
}

function rejectAllQueuedRequests(reason: string): number {
    const entries = requestQueue.splice(0);
    for (const request of entries) settleQueuedRequest(request, new Error(reason));
    return entries.length;
}

function rejectAllPendingRequests(reason = '请求被中断'): number {
    const entries = Array.from(pendingCallbacks.entries());
    pendingCallbacks.clear();
    for (const [, pending] of entries) {
        try {
            pending.callback(new Error(reason));
        } catch {
            // ignore callback failure
        }
    }
    return entries.length;
}

function describePendingRequests(): string {
    if (pendingCallbacks.size === 0) return 'none';
    const now = Date.now();
    return Array.from(pendingCallbacks.entries())
        .slice(0, MAX_DESCRIBED_PENDING_REQUESTS)
        .map(([seq, pending]) => {
            const method = pending.methodName || 'unknown';
            const ageMs = pending.startedAt ? Math.max(0, now - pending.startedAt) : 0;
            return `${method}#${seq}:${ageMs}ms`;
        })
        .join(',');
}

function describeQueuedRequests(): string {
    if (requestQueue.length === 0) return 'none';
    return requestQueue
        .slice(0, 8)
        .map(request => `${describeRequestClassMarker(request)}${request.methodName || 'unknown'}`)
        .join(',');
}

function logRequestPressure(): void {
    const now = Date.now();
    if (!shouldLogRequestPressure(requestQueue, now, lastRequestPressureLogAt)) return;
    lastRequestPressureLogAt = now;
    logWarn('系统', `Gateway 请求压力: pending=${pendingCallbacks.size}, queued=${requestQueue.length}, active=${describePendingRequests()}, queuedMethods=${describeQueuedRequests()}`);
}

// ============ 用户状态 (登录后设置) ============
const userState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    coupon: 0,
    goldBean: 0,
    openId: '',
    avatarUrl: '',
};

function getUserState() { return userState; }
function getWsErrorState() { return { ...wsErrorState }; }
function setWsErrorState(code: number, message: string): void {
    wsErrorState = { code: Number(code) || 0, at: Date.now(), message: message || '' };
}
function clearWsErrorState(): void {
    wsErrorState = { code: 0, at: 0, message: '' };
}

function hasOwn(obj: any, key: string): boolean {
    return !!obj && Object.hasOwn(obj, key);
}

// 登录后获取用户设置
async function fetchUserSettings(): Promise<void> {
    try {
        const body = types.GetUserSettingsRequest.encode(types.GetUserSettingsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.userpb.UserService', 'GetUserSettings', body);
        const reply = types.GetUserSettingsReply.decode(replyBody);
        if (reply.settings) {
            log('系统', `用户设置已同步`);
        }
    } catch {
        // 忽略获取失败
    }
}

// ============ 消息编解码 ============
async function encodeMsg(serviceName: string, methodName: string, bodyBytes: Buffer, clientSeqValue: number): Promise<Buffer> {
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) {
        finalBody = await cryptoWasm.encryptBuffer(finalBody);
    }
    const msg = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(clientSeqValue),
            server_seq: toLong(serverSeq),
        },
        body: finalBody,
        token: gatewayTokens.next(),
    });
    return types.GateMessage.encode(msg).finish();
}

function isCurrentConnection(context: ConnectionContext): boolean {
    return currentConnection === context && ws === context.socket && !context.finalized;
}

async function sendMsg(context: ConnectionContext, serviceName: string, methodName: string, bodyBytes: Buffer, pending?: PendingRequest): Promise<boolean> {
    if (!isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
        log('系统', '[WS] 连接未打开');
        return false;
    }
    const seq = clientSeq;
    clientSeq += 1;
    // 加密前登记在途请求，确保排队器能准确计算并发槽位。
    if (pending) pendingCallbacks.set(seq, pending);
    const encoded = await encodeMsg(serviceName, methodName, bodyBytes, seq);
    if (pending && pendingCallbacks.get(seq) !== pending) return false;
    if (!isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
        if (pending) {
            pendingCallbacks.delete(seq);
            pending.callback(new Error(`连接未打开: ${methodName}`));
        }
        return false;
    }
    try {
        context.socket.send(encoded);
    } catch (err: any) {
        if (pending) {
            pendingCallbacks.delete(seq);
            pending.callback(err);
        }
        return false;
    }
    return true;
}

/** Promise 版发送 */
function sendMsgAsync(serviceName: string, methodName: string, bodyBytes: Buffer, timeoutOrOptions: number | SendMsgOptions = 20000): Promise<{ body: Buffer; meta: any }> {
    const options: SendMsgOptions = typeof timeoutOrOptions === 'number'
        ? { timeoutMs: timeoutOrOptions }
        : (timeoutOrOptions || {});
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 20000);
    const expectedErrorCodes = new Set((options.expectedErrorCodes || []).map(Number).filter(Number.isFinite));
    const criticalLane: CriticalLane | undefined = options.criticalLane === 'heartbeat' || options.criticalLane === 'ace'
        ? options.criticalLane
        : undefined;
    const expectReply = options.expectReply !== false;
    // 班次由「显式 requestClass > priority 兼容映射 > 调度器注入的环境班次 > 前台」决定。
    const requestClass: RequestClass = resolveRequestClass(
        { priority: options.priority, requestClass: options.requestClass, criticalLane },
        getAmbientRequestClass(),
    );
    return new Promise((resolve, reject) => {
        const context = currentConnection;
        if (!context || !isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
            reject(new Error(`连接未打开: ${methodName}`));
            return;
        }
        if (context.phase !== 'online') {
            reject(new Error(`账号尚未登录: ${methodName}`));
            return;
        }

        // 每个班次有独立的排队配额：后台任务把自己的配额排满，也不会占掉前台/心跳的名额。
        if (isClassQueueFull(requestQueue, requestClass)) {
            reject(new Error(
                `请求等待队列已满: ${methodName} (class=${requestClass}, limit=${maxQueuedForClass(requestClass)}, `
                + `queued=${requestQueue.length}, pending=${pendingCallbacks.size})`,
            ));
            return;
        }

        const requestId = nextRequestId++;
        const request: QueuedRequest = {
            context,
            serviceName,
            methodName,
            bodyBytes,
            expectedErrorCodes,
            resolve,
            reject,
            timeoutKey: `request_timeout_${requestId}`,
            queueWaitKey: `request_queue_wait_${requestId}`,
            seq: null,
            settled: false,
            requestClass,
            criticalLane,
            enqueuedAt: Date.now(),
            expectReply,
        };
        requestQueue.push(request);
        networkScheduler.setTimeoutTask(request.timeoutKey, timeoutMs, () => {
            if (request.seq !== null) pendingCallbacks.delete(request.seq);
            const index = requestQueue.indexOf(request);
            if (index >= 0) requestQueue.splice(index, 1);
            const stage = request.seq === null ? 'queued' : 'pending';
            settleQueuedRequest(request, new Error(`请求超时: ${methodName} (stage=${stage}, pending=${pendingCallbacks.size}, queued=${requestQueue.length}, active=${describePendingRequests()})`));
            drainRequestQueue();
        });
        if (requestClass === 'background') {
            // background 是「后台补数据」：拿不到空闲槽位就早点让路，而不是一路熬到请求超时——
            // 熬着既拖长队列，也会给调用方刷一堆看着像故障的超时日志。
            const queueWaitMs = Math.min(timeoutMs, LOW_PRIORITY_QUEUE_WAIT_MS);
            networkScheduler.setTimeoutTask(request.queueWaitKey, queueWaitMs, () => {
                if (request.settled || request.seq !== null) return;
                const index = requestQueue.indexOf(request);
                if (index >= 0) requestQueue.splice(index, 1);
                settleQueuedRequest(request, new GatewayBusyError(
                    `网关繁忙，后台请求已让路: ${methodName} (waited=${queueWaitMs}ms, `
                    + `pending=${pendingCallbacks.size}, queued=${requestQueue.length}, active=${describePendingRequests()})`,
                ));
            });
        }
        drainRequestQueue();
        logRequestPressure();
    });
}

async function sendMsgNoReply(serviceName: string, methodName: string, bodyBytes: Buffer): Promise<void> {
    // 即使调用方不需要回包，也必须经过同一调度器，不能绕过心跳/ACE保护和并发上限。
    // 不写死班次，交给环境班次判定：后台任务发的通知不该被当成前台流量。
    await sendMsgAsync(serviceName, methodName, bodyBytes, { expectReply: false });
}

// ============ 消息处理 ============
function handleMessage(data: Buffer): void {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const msg = types.GateMessage.decode(buf);
        lastInboundAt = Date.now();
        const meta = msg.meta;
        if (!meta) return;

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = meta.message_type;

        // Notify
        if (msgType === 3) {
            handleNotify(msg);
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const pending = pendingCallbacks.get(clientSeqVal);
            const expectedError = !!pending && pending.expectedErrorCodes.has(errorCode);
            if (errorCode !== 0 && !expectedError) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }

            if (pending) {
                pendingCallbacks.delete(clientSeqVal);
                if (errorCode !== 0) {
                    pending.callback(new GatewayError(meta));
                } else {
                    pending.callback(null, msg.body, meta);
                }
                
            }
        }
    } catch (err: any) {
        logWarn('解码', err.message);
    }
}

function handleNotify(msg: any): void {
    if (!msg.body || msg.body.length === 0) return;
    try {
        const event = types.EventMessage.decode(msg.body);
        const type = event.message_type || '';
        const eventBody = event.body;

        // 被踢下线
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
            try {
                const notify = types.KickoutNotify.decode(eventBody);
                log('推送', `原因: ${notify.reason_message || '未知'}`);
                networkEvents.emit('kickout', {
                    type,
                    reason: notify.reason_message || '未知',
                });
            } catch {}
            return;
        }

        // 土地状态变化
        if (type.includes('LandsNotify')) {
            try {
                const notify = types.LandsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                const lands = notify.lands || [];
                if (lands.length > 0) {
                    if (hostGid === userState.gid || hostGid === 0) {
                        networkEvents.emit('landsChanged', lands);
                    }
                }
            } catch {}
            return;
        }

        // 青蛙等农场级社交事件变化。与乌云不同，它不附着在 LandInfo 上。
        if (type.includes('FarmSocialEventsNotify')) {
            try {
                const notify = types.FarmSocialEventsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                if (hostGid === userState.gid || hostGid === 0) {
                    networkEvents.emit('farmSocialEventsChanged', notify.social_events || []);
                }
            } catch {}
            return;
        }

        // 特殊天气变化。通知携带天气所属农场 GID；空 weather 表示天气结束。
        if (type.includes('WeatherChangeNotify')) {
            try {
                const notify = types.WeatherChangeNotify.decode(eventBody);
                networkEvents.emit('weatherChanged', {
                    hostGid: toNum(notify.host_gid),
                    weather: notify.weather || null,
                });
            } catch {}
            return;
        }

        // 护主犬“同气连枝”主人侧待拾取礼包数量。
        if (type.includes('PendingGiftCountNotify')) {
            try {
                const notify = types.PendingGiftCountNotify.decode(eventBody);
                networkEvents.emit('dogSkillGiftPending', Math.max(0, toNum(notify.count)));
            } catch {}
            return;
        }

        // 守护日志新增通知的真实事件体为空，仅作为失效信号使用。
        if (type.includes('NewProtectLogNotify')) {
            networkEvents.emit('dogProtectLogChanged');
            return;
        }

        // 物品变化通知
        if (type.includes('ItemNotify')) {
            try {
                const notify = types.ItemNotify.decode(eventBody);
                const items = notify.items || [];
                for (const itemChg of items) {
                    const item = itemChg.item;
                    if (!item) continue;
                    const id = toNum(item.id);
                    const count = toNum(item.count);
                    const delta = toNum(itemChg.delta);

                    if (id === 1101) {
                        if (count > 0) userState.exp = count;
                        else if (delta !== 0) userState.exp = Math.max(0, Number(userState.exp || 0) + delta);
                        updateStatusLevel(userState.level, userState.exp);
                    } else if (id === 1 || id === 1001) {
                        if (count > 0) {
                            userState.gold = count;
                        } else if (delta !== 0) {
                            userState.gold = Math.max(0, Number(userState.gold || 0) + delta);
                        }
                        updateStatusGold(userState.gold);
                    } else if (id === 1002) {
                        if (count > 0) {
                            userState.coupon = count;
                        } else if (delta !== 0) {
                            userState.coupon = Math.max(0, Number(userState.coupon || 0) + delta);
                        }
                    } else if (id === 1005) {
                        if (count > 0) {
                            userState.goldBean = count;
                        } else if (delta !== 0) {
                            userState.goldBean = Math.max(0, Number(userState.goldBean || 0) + delta);
                        }
                    }
                }
            } catch {}
            return;
        }

        // 基本信息变化
        if (type.includes('BasicNotify')) {
            try {
                const notify = types.BasicNotify.decode(eventBody);
                if (notify.basic) {
                    const oldLevel = userState.level;
                    if (hasOwn(notify.basic, 'level')) {
                        const nextLevel = toNum(notify.basic.level);
                        if (Number.isFinite(nextLevel) && nextLevel > 0) userState.level = nextLevel;
                    }
                    let shouldUpdateGoldView = false;
                    if (hasOwn(notify.basic, 'gold')) {
                        const nextGold = toNum(notify.basic.gold);
                        if (Number.isFinite(nextGold) && nextGold >= 0) {
                            userState.gold = nextGold;
                            shouldUpdateGoldView = true;
                        }
                    }
                    if (hasOwn(notify.basic, 'exp')) {
                        const exp = toNum(notify.basic.exp);
                        if (Number.isFinite(exp) && exp >= 0) {
                            userState.exp = exp;
                            updateStatusLevel(userState.level, exp);
                        }
                    }
                    if (shouldUpdateGoldView) {
                        updateStatusGold(userState.gold);
                    }
                    if (userState.level !== oldLevel) {
                        recordOperation('levelUp', 1);
                    }
                }
            } catch {}
            return;
        }

        // 好友申请通知
        if (type.includes('FriendApplicationReceivedNotify')) {
            try {
                const notify = types.FriendApplicationReceivedNotify.decode(eventBody);
                const applications = notify.applications || [];
                if (applications.length > 0) {
                    networkEvents.emit('friendApplicationReceived', applications);
                }
            } catch {}
            return;
        }

        // 好友添加成功通知
        if (type.includes('FriendAddedNotify')) {
            try {
                const notify = types.FriendAddedNotify.decode(eventBody);
                const friends = notify.friends || [];
                if (friends.length > 0) {
                    const names = friends.map((f: any) => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
                    log('好友', `新好友: ${names}`);
                }
            } catch {}
            return;
        }

        // 商品解锁通知
        if (type.includes('GoodsUnlockNotify')) {
            try {
                const notify = types.GoodsUnlockNotify.decode(eventBody);
                const goods = notify.goods_list || [];
                if (goods.length > 0) {
                    networkEvents.emit('goodsUnlockNotify', goods);
                }
            } catch {}
            return;
        }

        // 任务状态变化通知
        if (type.includes('TaskInfoNotify')) {
            try {
                const notify = types.TaskInfoNotify.decode(eventBody);
                if (notify.task_info) {
                    networkEvents.emit('taskInfoNotify', notify.task_info);
                }
            } catch {}
            return;
        }

        // VIP信息更新通知
        if (type.includes('VipInfoUpdatedNTF')) {
            try {
                const notify = types.VipInfoUpdatedNTF.decode(eventBody);
                networkEvents.emit('vipInfoUpdated', notify);
            } catch {}
            return;
        }

        // 商城需求通知
        if (type.includes('NeedNotify')) {
            try {
                const notify = types.NeedNotify.decode(eventBody);
                networkEvents.emit('mallNeedNotify', notify);
            } catch {}
            return;
        }

        // 商品变更通知
        if (type.includes('ProductsHasChangedNotify')) {
            try {
                const notify = types.ProductsHasChangedNotify.decode(eventBody);
                networkEvents.emit('productsChanged', notify);
            } catch {}
            return;
        }

        // 活动变更通知
        if (type.includes('ActiviesChangeNotify')) {
            try {
                const notify = types.ActiviesChangeNotify.decode(eventBody);
                networkEvents.emit('activitiesChanged', notify);
            } catch {}
            return;
        }

        // 头像框红点通知
        if (type.includes('AvatarFrameRedDotNotify')) {
            try {
                networkEvents.emit('avatarFrameRedDot');
            } catch {}
            return;
        }

        // 图鉴奖励红点通知
        if (type.includes('IllustratedRewardRedDotNotifyV2')) {
            try {
                networkEvents.emit('illustratedRewardRedDot');
            } catch {}
            return;
        }

        // 充值信息变更通知
        if (type.includes('RechargeInfoNotify')) {
            try {
                const notify = types.RechargeInfoNotify.decode(eventBody);
                networkEvents.emit('rechargeInfoChanged', notify);
            } catch {}
            return;
        }

        // 公告板变更通知
        if (type.includes('BulletinListChangedNTF')) {
            try {
                const notify = types.BulletinListChangedNTF.decode(eventBody);
                networkEvents.emit('bulletinListChanged', notify);
            } catch {}
            return;
        }

        // 皮肤变更通知
        if (type.includes('SkinChangeNotify')) {
            try {
                const notify = types.SkinChangeNotify.decode(eventBody);
                networkEvents.emit('skinChanged', notify);
            } catch {}
            
        }
    } catch (e: any) {
        logWarn('推送', `解码失败: ${e.message}`);
    }
}

// ============ 登录 ============
async function sendLogin(context: ConnectionContext, onLoginSuccess?: () => void): Promise<void> {
    const di = CONFIG.deviceInfo || {};
    const body = types.LoginRequest.encode(types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: {
            client_version: di.clientVersion || CONFIG.clientVersion,
            sys_software: di.sysSoftware || 'Windows',
            screen_width: 0,
        },
        share_cfg_id: toLong(0),
        scene_id: '1234567',
        report_data: {
            minigame_channel: 'other-qq',
            minigame_platid: 2,
        },
    })).finish();

    await sendMsg(context, 'gamepb.userpb.UserService', 'Login', body, {
        expectedErrorCodes: new Set(),
        // 登录不走排队器（此时还没 online），按保命流量记账。
        requestClass: 'critical',
        callback: async (err, bodyBytes, _meta) => {
        if (!isCurrentConnection(context)) return;
        if (err) {
            log('登录', `失败: ${err.message}`);
            if (err.message.includes('code=')) {
                log('系统', '账号验证失败，即将停止运行...');
                networkScheduler.setTimeoutTask('login_error_exit', 1000, () => process.exit(0));
            }
            return;
        }

        let reply: any;
        try {
            reply = types.LoginReply.decode(bodyBytes!);
        } catch (e: any) {
            log('登录', `解码失败: ${e.message}`);
            return;
        }
        if (!reply.basic) {
            log('登录', '失败: 登录响应缺少账号信息');
            return;
        }

        clearWsErrorState();
        userState.gid = toNum(reply.basic.gid);
        userState.name = reply.basic.name || '未知';
        userState.level = toNum(reply.basic.level);
        userState.gold = toNum(reply.basic.gold);
        userState.exp = toNum(reply.basic.exp);
        userState.openId = String(reply.basic.open_id || '').trim();
        userState.avatarUrl = String(reply.basic.avatar_url || '').trim();

        updateStatusFromLogin({
            name: userState.name,
            level: userState.level,
            gold: userState.gold,
            exp: userState.exp,
            avatarUrl: userState.avatarUrl,
        });

        log('系统', `登录成功: ${userState.name} (Lv${userState.level})`);

        if (context.loginInitialized) return;
        context.loginInitialized = true;

        console.warn('');
        console.warn('========== 登录成功 ==========');
        console.warn(`  GID:    ${userState.gid}`);
        console.warn(`  昵称:   ${userState.name}`);
        console.warn(`  等级:   ${userState.level}`);
        console.warn(`  金币:   ${userState.gold}`);
        if (reply.time_now_millis) {
            syncServerTime(toNum(reply.time_now_millis));
            console.warn(`  时间:   ${new Date(toNum(reply.time_now_millis)).toLocaleString()}`);
        }
        console.warn('===============================');
        console.warn('');

        try {
            if (userState.openId) {
                await cryptoWasm.bindUser(userState.openId);
                const initTokenLength = gatewayTokens.stageInitToken(cryptoWasm.getEncryptedInitInfo());
                if (initTokenLength > 0) {
                    log('ACE', `TSDK 初始化凭据已就绪: ${initTokenLength} 字符，将随下一条请求发送`);
                }
            }
            if (!isCurrentConnection(context)) return;
            networkScheduler.clear('login_timeout');
            context.phase = 'online';
            startAceRuntime((service: string, method: string, body: Buffer, timeoutMs?: number) => (
                sendMsgAsync(service, method, body, { timeoutMs, priority: 'high', criticalLane: 'ace' })
            ));
            startHeartbeat(context);
            // 登录引导阶段串行完成普通请求，避免和后续活动、背包初始化同时挤入 Gateway。
            await fetchUserSettings();
            if (!isCurrentConnection(context)) return;
            if (onLoginSuccess) await onLoginSuccess();
        } catch (e: any) {
            logWarn('登录', `登录初始化失败: ${e.message}`);
            finalizeConnection(context, {
                source: 'login_init_failed',
                reason: e.message,
            });
            try { (context.socket as any).terminate(); } catch {}
        }
        },
    });
}

// ============ 心跳 ============
const HEARTBEAT_REQUEST_TIMEOUT = 20000;

function startHeartbeat(context: ConnectionContext): void {
    networkScheduler.clear('heartbeat_interval');
    lastHeartbeatResponse = Date.now();
    lastInboundAt = Date.now();
    heartbeatMissCount = 0;

    networkScheduler.setIntervalTask('heartbeat_interval', CONFIG.heartbeatInterval, async () => {
        if (!isCurrentConnection(context) || context.phase !== 'online' || !userState.gid) return;

        const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(userState.gid),
            client_version: CONFIG.clientVersion,
            field_3: toLong(0),
        })).finish();
        try {
            const { body: replyBody } = await sendMsgAsync(
                'gamepb.userpb.UserService',
                'Heartbeat',
                body,
                { timeoutMs: HEARTBEAT_REQUEST_TIMEOUT, priority: 'high', criticalLane: 'heartbeat' },
            );
            if (!isCurrentConnection(context)) return;
            lastHeartbeatResponse = Date.now();
            heartbeatMissCount = 0;
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                if (reply.server_time) syncServerTime(toNum(reply.server_time));
            } catch {}
        } catch {
            if (!isCurrentConnection(context)) return;
            heartbeatMissCount += 1;
            const now = Date.now();
            const inboundSilenceMs = Math.max(0, now - lastInboundAt);
            const heartbeatSilenceMs = Math.max(0, now - lastHeartbeatResponse);
            logWarn(
                '心跳',
                `心跳未响应 (miss=${heartbeatMissCount}/${MAX_HEARTBEAT_MISSES}, `
                + `heartbeat=${Math.round(heartbeatSilenceMs / 1000)}s, inbound=${Math.round(inboundSilenceMs / 1000)}s, `
                + `pending=${pendingCallbacks.size}, queued=${requestQueue.length}, active=${describePendingRequests()})`,
            );
            if (!shouldTerminateForHeartbeat(heartbeatMissCount, inboundSilenceMs)) return;

            log('心跳', '连续心跳超时且连接无入站数据，账号将停止运行...');
            finalizeConnection(context, {
                source: 'heartbeat_timeout',
                reason: `${Math.round(inboundSilenceMs / 1000)}s 无入站数据，连续 ${heartbeatMissCount} 次心跳失败`,
            });
            try { (context.socket as any).terminate(); } catch {}
        }
    }, { preventOverlap: true });
}

interface DisconnectDetails {
    source: string;
    code?: number;
    reason?: string;
}

function clearNetworkRuntime(reason: string): void {
    rejectAllQueuedRequests(`请求已中断: ${reason}`);
    rejectAllPendingRequests(`请求已中断: ${reason}`);
    networkScheduler.clearAll();
    stopAceRuntime(true);
    gatewayTokens.clear();
    userState.gid = 0;
    userState.openId = '';
}

function finalizeConnection(context: ConnectionContext, details: DisconnectDetails): void {
    if (context.finalized) return;
    context.finalized = true;
    const wasCurrent = currentConnection === context;
    const wasLoginReady = context.phase === 'online';
    if (wasCurrent) {
        currentConnection = null;
        ws = null;
        clearNetworkRuntime(details.reason || details.source);
    }
    if (!wasCurrent || context.intentionalClose) return;
    networkEvents.emit('disconnected', {
        connectionId: context.id,
        source: details.source,
        code: Number(details.code) || 0,
        reason: details.reason || '',
        phase: context.phase,
        wasLoginReady,
        at: Date.now(),
    });
}

// ============ WebSocket 连接 ============
function connect(code: string | null, onLoginSuccess?: () => void): void {
    const authCode = String(code || '').trim();
    if (!authCode) throw new Error('连接缺少一次性 Code');
    if (currentConnection && !currentConnection.finalized) throw new Error('WebSocket 连接已存在');

    clientSeq = 1;
    serverSeq = 0;
    const url = new URL(CONFIG.serverUrl);
    url.search = new URLSearchParams({
        platform: CONFIG.platform,
        os: CONFIG.os,
        ver: CONFIG.clientVersion,
        code: authCode,
    }).toString();
    const di = CONFIG.deviceInfo || {};
    const socket = new WebSocket(url.toString(), {
        headers: {
            'User-Agent': di.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
            'Origin': 'https://gate-obt.nqf.qq.com',
        },
    });
    const context: ConnectionContext = {
        id: nextConnectionId++,
        socket,
        phase: 'connecting',
        intentionalClose: false,
        finalized: false,
        loginInitialized: false,
    };
    currentConnection = context;
    ws = socket;
    socket.binaryType = 'arraybuffer';

    (socket as any).on('open', () => {
        if (!isCurrentConnection(context)) return;
        context.phase = 'login';
        networkScheduler.setTimeoutTask('login_timeout', 20000, () => {
            if (!isCurrentConnection(context) || context.phase !== 'login') return;
            logWarn('登录', '登录响应超时，账号将停止运行...');
            finalizeConnection(context, { source: 'login_timeout', reason: '登录响应超时' });
            try { (socket as any).terminate(); } catch {}
        });
        sendLogin(context, onLoginSuccess).catch((e: any) => {
            if (!isCurrentConnection(context)) return;
            finalizeConnection(context, { source: 'login_send_failed', reason: e.message });
            try { (socket as any).terminate(); } catch {}
        });
    });

    (socket as any).on('message', (data: any, _isBinary: any) => {
        if (!isCurrentConnection(context)) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        handleMessage(buf);
    });

    (socket as any).on('close', (closeCode: any, closeReason: any) => {
        const reason = Buffer.isBuffer(closeReason) ? closeReason.toString('utf8') : String(closeReason || '');
        console.warn(`[WS] 连接关闭 (code=${closeCode})`);
        finalizeConnection(context, { source: 'ws_close', code: Number(closeCode) || 0, reason });
    });

    (socket as any).on('error', (err: any) => {
        if (!isCurrentConnection(context)) return;
        const message = err && err.message ? String(err.message) : '';
        logWarn('系统', `[WS] 错误: ${message}`);
        const match = message.match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const errorCode = Number.parseInt(match[1], 10) || 0;
            if (errorCode) {
                setWsErrorState(errorCode, message);
                networkEvents.emit('ws_error', { code: errorCode, message });
            }
        }
    });
}

function cleanup(reason = '网络清理'): void {
    const context = currentConnection;
    if (!context) {
        clearNetworkRuntime(reason);
        return;
    }
    context.intentionalClose = true;
    finalizeConnection(context, { source: 'intentional_close', reason });
    try { context.socket.close(); } catch {}
}

function getWs(): WebSocket | null { return ws; }

module.exports = {
    connect, cleanup, getWs,
    sendMsgAsync, sendMsgNoReply,
    getGatewayLoad, isGatewayIdleForBackground, waitForGatewayIdle,
    GatewayError, GatewayBusyError,
    getUserState,
    getWsErrorState,
    networkEvents,
};
