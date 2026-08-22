export {};

const HEARTBEAT_STALE_AFTER_MS = 30000;
const MAX_HEARTBEAT_MISSES = 3;

function shouldTerminateForHeartbeat(missCount: number, inboundSilenceMs: number): boolean {
    return Number(missCount) >= MAX_HEARTBEAT_MISSES
        && Number(inboundSilenceMs) > HEARTBEAT_STALE_AFTER_MS;
}

module.exports = {
    HEARTBEAT_STALE_AFTER_MS,
    MAX_HEARTBEAT_MISSES,
    shouldTerminateForHeartbeat,
};
