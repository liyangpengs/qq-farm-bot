export {};
export type IPCCommandType = 'start_account' | 'stop_account' | 'update_config' | 'get_status' | 'farm_operate' | 'friend_operate';
export interface IPCPayload {
    command: IPCCommandType;
    accountId: string;
    data?: any;
}
export interface IPCResponse {
    success: boolean;
    accountId: string;
    data?: any;
    error?: string;
}
//# sourceMappingURL=ipc.d.ts.map