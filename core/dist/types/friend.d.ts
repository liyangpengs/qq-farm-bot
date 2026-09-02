export {};
export interface FriendInfo {
    gid: number;
    qq: string;
    nickname: string;
    level: number;
    avatar: string;
}
export interface FriendLandData {
    landId: number;
    plantId: number;
    plantPhase: string;
    waterTime: number;
    fertilizerTime: number;
    harvestTime: number;
    status: number;
}
export interface FriendFarmStatus {
    friendGid: number;
    lands: FriendLandData[];
}
export type FriendOperation = 'water' | 'weed' | 'insecticide' | 'steal' | 'fertilize';
export interface OperationLimits {
    water: {
        used: number;
        max: number;
    };
    weed: {
        used: number;
        max: number;
    };
    insecticide: {
        used: number;
        max: number;
    };
    steal: {
        used: number;
        max: number;
    };
}
export interface FriendCheckResult {
    success: boolean;
    operation: FriendOperation;
    friendGid: number;
    message?: string;
}
//# sourceMappingURL=friend.d.ts.map