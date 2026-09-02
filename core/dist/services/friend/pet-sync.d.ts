/**
 * 好友宠物每日同步 - 把护主犬探测从“每轮帮忙”改成“每天一轮”
 *
 * 护主犬只能从 VisitService.Enter 回包的 brief_dog_info 读到，所以本模块是唯一为了拿宠物
 * 信息而额外发 RPC 的地方；其余时候全靠 api.ts 里 Enter 回包的顺手写入。
 *
 * 网关约束（参见 utils/request-priority.ts 与 docs/network-concurrency.md）：
 * - 全部请求走 background 班次，只有连接彻底空闲时才会发出，在协议层就不会挤压任何业务流量；
 * - 串行 + 分批 + 固定 2 秒间隔，且一轮只探当前配额内的几位：服务端对进出好友农场有速率限制，
 *   一轮连探几十位之后网关会对所有请求彻底静默，最后心跳三连失败掉线；
 * - 轮次配额与轮间间隔自适应（planNextSyncPacing）：干净跑完一轮就加量加速，让路一次就退回基线；
 * - 进每位好友前先给好友巡查让路，等不到空闲就把剩下的好友留给下一轮（单向门控）；
 * - 进每位好友前还要等网关空闲（waitForGatewayIdle）：队列里有业务请求、或有业务请求在飞时不排队。
 *   协议层的 background 槽位只保证「不抢先」，不保证「不叠加」：209 位好友一路硬排会把队列和 pending 拉满，
 *   Enter/Leave 熬到超时刷一屏日志，最后连心跳都可能被挤到掉线。拿不到空闲窗口就整轮让路，
 *   让路时按 classifyGatewayDefer() 区分「只是被主流程占着」（短退避）和「服务端静默」（30 分钟冷却）。
 */
export interface FriendPetSyncResult {
    outcome: 'skipped' | 'fresh' | 'synced' | 'deferred' | 'error';
    reason?: string;
    checked?: number;
    failed?: number;
    deferred?: number;
    pending?: number;
}
export interface SyncPacingState {
    /** 下一轮的好友配额 */
    quota: number;
    /** 当天是否已经不再上调配额 */
    rampLocked: boolean;
}
export interface SyncPacing extends SyncPacingState {
    /** 距离下一轮的等待时间 */
    delayMs: number;
}
/**
 * 根据本轮结果决定下一轮的节奏（纯函数，便于测试）。
 *
 * - 让路收场：配额回基线并锁死上调；只是抢窗口失败就 1 分钟后重试，服务端静默则回基线间隔
 *   （此时 syncBlockedUntil 的 30 分钟冷却已经生效，下一轮会直接 skipped）；
 * - 干净跑完但好友没探完（round_quota）：说明连接扛得住，配额 +5 并用较短的间隔接上；
 * - 其余情况（当天已完成 / 没活 / 开关关闭 / 异常）：回基线间隔，配额不动。
 */
export declare function planNextSyncPacing(result: FriendPetSyncResult | null | undefined, current: SyncPacingState): SyncPacing;
export declare function collectPendingFriends(friends: any[], myGid: number, blacklist: Set<number>, invalid: Set<number>): Array<{
    gid: number;
    name: string;
}>;
/**
 * 执行一轮同步。当天已经跑完整一轮就直接返回，不会重复扫。
 * 整轮固定跑在 background 班次里：不管是定时器还是面板手动触发，都不许抢业务流量的槽位。
 */
export declare function runFriendPetSync(): Promise<FriendPetSyncResult>;
export declare function startFriendPetSyncTimer(): void;
export declare function stopFriendPetSyncTimer(): void;
export declare function isFriendPetSyncRunning(): boolean;
export declare const FRIEND_PET_SYNC_TUNING: {
    SYNC_BATCH_SIZE: number;
    SYNC_GAP_MS: number;
    SYNC_BATCH_GAP_MS: number;
    SYNC_MAX_PER_ROUND_BASE: number;
    SYNC_MAX_PER_ROUND_STEP: number;
    SYNC_MAX_PER_ROUND_CAP: number;
    SYNC_BUSY_COOLDOWN_MS: number;
    FRIEND_TASK_WAIT_MAX_MS: number;
    FRIEND_TASK_POLL_MS: number;
    GATEWAY_IDLE_WAIT_MAX_MS: number;
    SYNC_CHECK_INTERVAL_MS: number;
    SYNC_FAST_INTERVAL_MS: number;
    SYNC_CONTENTION_RETRY_MS: number;
    SYNC_STARTUP_DELAY_MS: number;
};
//# sourceMappingURL=pet-sync.d.ts.map