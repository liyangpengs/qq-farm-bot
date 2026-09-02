export {};
export type WorkerMessageType = 'start' | 'stop' | 'status' | 'config_update' | 'farm_check' | 'friend_check' | 'log';
export interface WorkerMessage {
    type: WorkerMessageType;
    accountId: string;
    data?: any;
}
export interface WorkerState {
    accountId: string;
    running: boolean;
    farmLoopRunning: boolean;
    friendLoopRunning: boolean;
    lastFarmCheck: number;
    lastFriendCheck: number;
    error?: string;
}
export interface WorkerConfig {
    accountId: string;
    uin: string;
    qq: string;
    code: string;
    platform: string;
}
//# sourceMappingURL=worker.d.ts.map