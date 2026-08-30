export {};

const SYNC_BATCH_SIZE = 5;
const SYNC_GAP_MS = 2000;
const SYNC_BATCH_GAP_MS = 3000;
const SYNC_MAX_PER_ROUND_BASE = 10;
const SYNC_MAX_PER_ROUND_STEP = 5;
const SYNC_MAX_PER_ROUND_CAP = 25;
const SYNC_BUSY_COOLDOWN_MS = 30 * 60 * 1000;
const FRIEND_TASK_WAIT_MAX_MS = 10000;
const FRIEND_TASK_POLL_MS = 250;
const GATEWAY_IDLE_WAIT_MAX_MS = 8000;
const SYNC_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const SYNC_FAST_INTERVAL_MS = 3 * 60 * 1000;
const SYNC_CONTENTION_RETRY_MS = 60 * 1000;
const SYNC_STARTUP_DELAY_MS = 90 * 1000;

interface SyncResultLike {
    outcome?: string;
    reason?: string;
}

interface SyncPacingState {
    quota: number;
    rampLocked: boolean;
}

const YIELD_REASONS = new Set(['gateway_busy', 'gateway_contention', 'friend_task_busy']);

function planNextSyncPacing(
    result: SyncResultLike | null | undefined,
    current: SyncPacingState,
): SyncPacingState & { delayMs: number } {
    const reason = String(result?.reason || '');
    if (YIELD_REASONS.has(reason)) {
        return {
            delayMs: reason === 'gateway_busy' ? SYNC_CHECK_INTERVAL_MS : SYNC_CONTENTION_RETRY_MS,
            quota: SYNC_MAX_PER_ROUND_BASE,
            rampLocked: true,
        };
    }
    if (result?.outcome === 'deferred' && reason === 'round_quota') {
        return {
            delayMs: SYNC_FAST_INTERVAL_MS,
            quota: current.rampLocked
                ? current.quota
                : Math.min(SYNC_MAX_PER_ROUND_CAP, current.quota + SYNC_MAX_PER_ROUND_STEP),
            rampLocked: current.rampLocked,
        };
    }
    return {
        delayMs: SYNC_CHECK_INTERVAL_MS,
        quota: current.quota,
        rampLocked: current.rampLocked,
    };
}

const FRIEND_PET_SYNC_TUNING = {
    SYNC_BATCH_SIZE,
    SYNC_GAP_MS,
    SYNC_BATCH_GAP_MS,
    SYNC_MAX_PER_ROUND_BASE,
    SYNC_MAX_PER_ROUND_STEP,
    SYNC_MAX_PER_ROUND_CAP,
    SYNC_BUSY_COOLDOWN_MS,
    FRIEND_TASK_WAIT_MAX_MS,
    FRIEND_TASK_POLL_MS,
    GATEWAY_IDLE_WAIT_MAX_MS,
    SYNC_CHECK_INTERVAL_MS,
    SYNC_FAST_INTERVAL_MS,
    SYNC_CONTENTION_RETRY_MS,
    SYNC_STARTUP_DELAY_MS,
};

module.exports = {
    ...FRIEND_PET_SYNC_TUNING,
    FRIEND_PET_SYNC_TUNING,
    planNextSyncPacing,
};
