"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const HEARTBEAT_STALE_AFTER_MS = 30000;
const MAX_HEARTBEAT_MISSES = 3;
function shouldTerminateForHeartbeat(missCount, inboundSilenceMs) {
    return Number(missCount) >= MAX_HEARTBEAT_MISSES
        && Number(inboundSilenceMs) > HEARTBEAT_STALE_AFTER_MS;
}
module.exports = {
    HEARTBEAT_STALE_AFTER_MS,
    MAX_HEARTBEAT_MISSES,
    shouldTerminateForHeartbeat,
};
//# sourceMappingURL=keepalive-policy.js.map