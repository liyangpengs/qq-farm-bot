export {};

const REQUEST_CLASS_ORDER = ['critical', 'foreground', 'farm', 'friend', 'background'] as const;
type RequestClass = typeof REQUEST_CLASS_ORDER[number];

const CRITICAL_LANES = ['heartbeat', 'ace'] as const;
type CriticalLane = typeof CRITICAL_LANES[number];

const BUSINESS_CLASSES = ['foreground', 'farm', 'friend'] as const;
const MAX_BUSINESS_IN_FLIGHT = 3;
const MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT = 2;

const MAX_IN_FLIGHT_BY_CLASS: Readonly<Record<RequestClass, number>> = {
    critical: 2,
    foreground: 3,
    farm: 2,
    friend: 1,
    background: 1,
};

const MAX_QUEUED_BY_CLASS: Readonly<Record<RequestClass, number>> = {
    critical: 8,
    foreground: 60,
    farm: 40,
    friend: 30,
    background: 10,
};

const CLASS_STARVATION_MS = 4000;

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
    return typeof value === 'string'
        && (REQUEST_CLASS_ORDER as readonly string[]).includes(value);
}

function isCriticalLane(value: any): value is CriticalLane {
    return typeof value === 'string'
        && (CRITICAL_LANES as readonly string[]).includes(value);
}

function normalizeRequestClass(value: any): RequestClass | null {
    return isRequestClass(value) ? value : null;
}

function classOf(request: DispatchCandidate | DispatchInFlight | null | undefined): RequestClass {
    return normalizeRequestClass(request?.requestClass) || 'foreground';
}

function isBusinessClass(requestClass: RequestClass): boolean {
    return (BUSINESS_CLASSES as readonly string[]).includes(requestClass);
}

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

function selectDispatchIndex(
    queue: readonly DispatchCandidate[],
    inFlight: readonly DispatchInFlight[],
    now: number = Date.now(),
): number {
    const list = queue || [];
    if (list.length === 0) return -1;
    const active = inFlight || [];

    for (const lane of CRITICAL_LANES) {
        const laneBusy = countInFlight(
            active,
            (request, requestClass) => requestClass === 'critical' && request.criticalLane === lane,
        );
        if (laneBusy >= 1) continue;
        const index = list.findIndex(
            request => classOf(request) === 'critical' && request.criticalLane === lane,
        );
        if (index >= 0) return index;
    }

    const criticalInFlight = countInFlight(active, (_request, requestClass) => requestClass === 'critical');
    if (criticalInFlight < MAX_IN_FLIGHT_BY_CLASS.critical) {
        const index = list.findIndex(
            request => classOf(request) === 'critical' && !isCriticalLane(request.criticalLane),
        );
        if (index >= 0) return index;
    }

    const businessInFlight = countInFlight(active, (_request, requestClass) => isBusinessClass(requestClass));
    if (businessInFlight < MAX_BUSINESS_IN_FLIGHT) {
        const nonForegroundInFlight = countInFlight(
            active,
            (_request, requestClass) => isBusinessClass(requestClass) && requestClass !== 'foreground',
        );
        const perClassInFlight = new Map<RequestClass, number>();
        for (const request of active) {
            const requestClass = classOf(request);
            perClassInFlight.set(requestClass, (perClassInFlight.get(requestClass) || 0) + 1);
        }

        const eligible: number[] = [];
        for (let index = 0; index < list.length; index += 1) {
            const requestClass = classOf(list[index]);
            if (!isBusinessClass(requestClass)) continue;
            if ((perClassInFlight.get(requestClass) || 0) >= MAX_IN_FLIGHT_BY_CLASS[requestClass]) continue;
            if (requestClass !== 'foreground'
                && nonForegroundInFlight >= MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT) continue;
            eligible.push(index);
        }

        let starvedIndex = -1;
        let longestWaitMs = CLASS_STARVATION_MS;
        for (const index of eligible) {
            const enqueuedAt = Number(list[index].enqueuedAt);
            if (!Number.isFinite(enqueuedAt)) continue;
            const waitMs = Math.max(0, Number(now) - enqueuedAt);
            if (waitMs >= longestWaitMs) {
                longestWaitMs = waitMs;
                starvedIndex = index;
            }
        }
        if (starvedIndex >= 0) return starvedIndex;

        for (const requestClass of BUSINESS_CLASSES) {
            const index = eligible.find(candidate => classOf(list[candidate]) === requestClass);
            if (index !== undefined) return index;
        }
    }

    if (active.length > 0) return -1;
    if (list.some(request => classOf(request) !== 'background')) return -1;
    return list.findIndex(request => classOf(request) === 'background');
}

function maxQueuedForClass(requestClass: any): number {
    return MAX_QUEUED_BY_CLASS[normalizeRequestClass(requestClass) || 'foreground'];
}

function countQueuedByClass(queue: readonly DispatchCandidate[], requestClass: any): number {
    const target = normalizeRequestClass(requestClass) || 'foreground';
    let count = 0;
    for (const request of queue || []) {
        if (classOf(request) === target) count += 1;
    }
    return count;
}

function isClassQueueFull(queue: readonly DispatchCandidate[], requestClass: any): boolean {
    return countQueuedByClass(queue, requestClass) >= maxQueuedForClass(requestClass);
}

function describeRequestClassMarker(request: DispatchCandidate | null | undefined): string {
    if (request?.criticalLane === 'heartbeat') return '!H:';
    if (request?.criticalLane === 'ace') return '!A:';
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
