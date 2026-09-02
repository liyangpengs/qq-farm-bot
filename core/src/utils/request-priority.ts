export {};

/**
 * Gateway 请求的优先级分层策略（纯函数，可单测）。
 *
 * 背景：Gateway 是单条 WebSocket 复用，所有业务共享一条连接。以前只有 low/normal/high
 * 三档，后台扫描（好友巡查、宠物同步）和用户前台操作挤在同一个 normal 档里，
 * 结果后台任务一开跑就把 normal 槽位占满，前台操作只能排队，心跳虽有保留槽位但
 * 服务端一旦变慢就整条连接被拖垮。
 *
 * 现在按「班次」分层，优先级从高到低：
 * 1. critical   —— 心跳 / ACE AntiData。掉了就直接下线，必须永远有槽位。
 * 2. foreground —— 用户在面板上的前台操作。人在等结果，优先级仅次于保命流量。
 * 3. farm       —— 自己农场的后台定时任务。
 * 4. friend     —— 好友农场的后台定时任务。
 * 5. background —— 宠物同步等「补数据」任务，只在网关完全空闲时才发。
 *
 * 容量约束：
 * - critical 的两条通道（heartbeat / ace）各自保留一个槽位，互不挤占；
 * - 业务流量（foreground/farm/friend）总在途不超过 MAX_BUSINESS_IN_FLIGHT；
 * - 其中非前台业务（farm/friend）不超过 MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT，
 *   所以前台操作永远有至少一个槽位，不会被后台定时任务饿死；
 * - background 只在连接彻底空闲（没有在途请求、队列里也没有别的班次）时才发；
 * - 低优先班次等待超过 CLASS_STARVATION_MS 时会被提升到队首，避免长期饿死。
 */

const REQUEST_CLASS_ORDER = ['critical', 'foreground', 'farm', 'friend', 'background'] as const;
type RequestClass = typeof REQUEST_CLASS_ORDER[number];

const CRITICAL_LANES = ['heartbeat', 'ace'] as const;
type CriticalLane = typeof CRITICAL_LANES[number];

/** 业务班次：会互相争抢在途预算的那几档（critical 与 background 都有独立规则）。 */
const BUSINESS_CLASSES = ['foreground', 'farm', 'friend'] as const;

/** 业务流量（前台 + 农场 + 好友）的总在途预算。 */
const MAX_BUSINESS_IN_FLIGHT = 3;
/** 非前台业务的在途上限：比总预算少 1，给前台操作永久留一个槽位。 */
const MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT = 2;

/** 每个班次自身的在途上限。 */
const MAX_IN_FLIGHT_BY_CLASS: Readonly<Record<RequestClass, number>> = {
    critical: 2,
    foreground: 3,
    farm: 2,
    friend: 1,
    background: 1,
};

/** 每个班次的排队上限：后台班次故意留得很小，队列长了就该让路而不是硬排。 */
const MAX_QUEUED_BY_CLASS: Readonly<Record<RequestClass, number>> = {
    critical: 8,
    foreground: 60,
    farm: 40,
    friend: 30,
    background: 10,
};

/** 排队超过这个时长的低优先班次会被提升，防止被高优先班次持续插队饿死。 */
const CLASS_STARVATION_MS = 4000;

/** 队列压力日志里用的班次标记。 */
const REQUEST_CLASS_MARKER: Readonly<Record<RequestClass, string>> = {
    critical: '!',
    foreground: '',
    farm: '#',
    friend: '&',
    background: '~',
};

interface RequestClassOptionsLike {
    priority?: string;
    requestClass?: string;
    criticalLane?: string;
}

interface DispatchCandidate {
    requestClass?: string;
    criticalLane?: string;
    enqueuedAt?: number;
}

interface DispatchInFlight {
    requestClass?: string;
    criticalLane?: string;
}

function isRequestClass(value: any): value is RequestClass {
    return typeof value === 'string' && (REQUEST_CLASS_ORDER as readonly string[]).includes(value);
}

function isCriticalLane(value: any): value is CriticalLane {
    return typeof value === 'string' && (CRITICAL_LANES as readonly string[]).includes(value);
}

function normalizeRequestClass(value: any): RequestClass | null {
    return isRequestClass(value) ? value : null;
}

function classOf(request: DispatchCandidate | DispatchInFlight | null | undefined): RequestClass {
    return normalizeRequestClass(request && request.requestClass) || 'foreground';
}

function isBusinessClass(requestClass: RequestClass): boolean {
    return (BUSINESS_CLASSES as readonly string[]).includes(requestClass);
}

/**
 * 决定一个请求属于哪个班次。
 *
 * 注意 priority:'normal' 被视为「调用方没表态」：项目里大量 API 层默认传 'normal'，
 * 如果把它当成明确的前台声明，后台定时任务发出的请求就会全部伪装成前台流量。
 * 这种情况回落到 AsyncLocalStorage 里的环境班次（由调度器按命名空间注入）。
 */
function resolveRequestClass(
    options: RequestClassOptionsLike | null | undefined,
    ambientClass?: any,
): RequestClass {
    const opts = options || {};
    if (isCriticalLane(opts.criticalLane) || opts.priority === 'high') return 'critical';
    const explicit = normalizeRequestClass(opts.requestClass);
    if (explicit) return explicit;
    if (opts.priority === 'low') return 'background';
    return normalizeRequestClass(ambientClass) || 'foreground';
}

function countInFlight(
    inFlight: readonly DispatchInFlight[],
    predicate: (request: DispatchInFlight, requestClass: RequestClass) => boolean,
): number {
    let count = 0;
    for (const request of inFlight) {
        if (predicate(request, classOf(request))) count += 1;
    }
    return count;
}

/**
 * 从队列里挑出下一个可以发送的请求下标；没有可发送的就返回 -1。
 * 只读入参，由调用方负责把选中的请求移出队列。
 */
function selectDispatchIndex(
    queue: readonly DispatchCandidate[],
    inFlight: readonly DispatchInFlight[],
    now: number = Date.now(),
): number {
    const list = queue || [];
    if (list.length === 0) return -1;
    const active = inFlight || [];

    // 1) 心跳 / ACE 各占一个独立保留槽位，谁也挤不掉谁。
    for (const lane of CRITICAL_LANES) {
        const laneBusy = countInFlight(active, (request, cls) => cls === 'critical' && request.criticalLane === lane);
        if (laneBusy >= 1) continue;
        const laneIndex = list.findIndex(request => classOf(request) === 'critical' && request.criticalLane === lane);
        if (laneIndex >= 0) return laneIndex;
    }

    // 2) 没有标记通道的 critical 请求（目前业务里没有）只吃 critical 的普通预算。
    const criticalInFlight = countInFlight(active, (_request, cls) => cls === 'critical');
    if (criticalInFlight < MAX_IN_FLIGHT_BY_CLASS.critical) {
        const plainIndex = list.findIndex(request => classOf(request) === 'critical' && !isCriticalLane(request.criticalLane));
        if (plainIndex >= 0) return plainIndex;
    }

    // 3) 业务班次：总预算 + 每班次上限 + 前台保留槽位三重约束。
    const businessInFlight = countInFlight(active, (_request, cls) => isBusinessClass(cls));
    if (businessInFlight < MAX_BUSINESS_IN_FLIGHT) {
        const nonForegroundInFlight = countInFlight(active, (_request, cls) => isBusinessClass(cls) && cls !== 'foreground');
        const perClassInFlight = new Map<RequestClass, number>();
        for (const request of active) {
            const cls = classOf(request);
            perClassInFlight.set(cls, (perClassInFlight.get(cls) || 0) + 1);
        }

        const eligible: number[] = [];
        for (let index = 0; index < list.length; index++) {
            const cls = classOf(list[index]);
            if (!isBusinessClass(cls)) continue;
            if ((perClassInFlight.get(cls) || 0) >= MAX_IN_FLIGHT_BY_CLASS[cls]) continue;
            if (cls !== 'foreground' && nonForegroundInFlight >= MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT) continue;
            eligible.push(index);
        }

        if (eligible.length > 0) {
            // 先救被插队太久的：等待最长且已超阈值的优先发送。
            let starvedIndex = -1;
            let starvedWaitMs = CLASS_STARVATION_MS;
            for (const index of eligible) {
                const enqueuedAt = Number(list[index].enqueuedAt);
                if (!Number.isFinite(enqueuedAt)) continue;
                const waitedMs = Math.max(0, Number(now) - enqueuedAt);
                if (waitedMs >= starvedWaitMs) {
                    starvedWaitMs = waitedMs;
                    starvedIndex = index;
                }
            }
            if (starvedIndex >= 0) return starvedIndex;

            // 否则按班次优先级、同班次内 FIFO。
            for (const cls of REQUEST_CLASS_ORDER) {
                if (!isBusinessClass(cls)) continue;
                for (const index of eligible) {
                    if (classOf(list[index]) === cls) return index;
                }
            }
        }
    }

    // 4) background 是「补数据」：只在连接彻底空闲、且队列里没有别的班次时才发。
    if (active.length > 0) return -1;
    if (list.some(request => classOf(request) !== 'background')) return -1;
    return list.findIndex(request => classOf(request) === 'background');
}

/** 某班次的排队上限，用于在入队前直接拒绝而不是让请求熬到超时。 */
function maxQueuedForClass(requestClass: any): number {
    const cls = normalizeRequestClass(requestClass) || 'foreground';
    return MAX_QUEUED_BY_CLASS[cls];
}

function countQueuedByClass(queue: readonly DispatchCandidate[], requestClass: any): number {
    const cls = normalizeRequestClass(requestClass) || 'foreground';
    let count = 0;
    for (const request of queue || []) {
        if (classOf(request) === cls) count += 1;
    }
    return count;
}

/** 队列已满判定：按班次各自的配额，互不影响。 */
function isClassQueueFull(queue: readonly DispatchCandidate[], requestClass: any): boolean {
    return countQueuedByClass(queue, requestClass) >= maxQueuedForClass(requestClass);
}

function describeRequestClassMarker(request: DispatchCandidate | null | undefined): string {
    if (request && request.criticalLane === 'heartbeat') return '!H:';
    if (request && request.criticalLane === 'ace') return '!A:';
    return REQUEST_CLASS_MARKER[classOf(request)];
}

module.exports = {
    REQUEST_CLASS_ORDER,
    CRITICAL_LANES,
    BUSINESS_CLASSES,
    MAX_BUSINESS_IN_FLIGHT,
    MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT,
    MAX_IN_FLIGHT_BY_CLASS,
    MAX_QUEUED_BY_CLASS,
    CLASS_STARVATION_MS,
    isRequestClass,
    isCriticalLane,
    normalizeRequestClass,
    resolveRequestClass,
    selectDispatchIndex,
    maxQueuedForClass,
    countQueuedByClass,
    isClassQueueFull,
    describeRequestClassMarker,
};