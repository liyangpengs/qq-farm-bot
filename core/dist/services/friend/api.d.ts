/**
 * 好友 API 底层操作 (protobuf 发送/接收)
 */
export declare function getAllFriends(forceSync?: boolean, priority?: 'low' | 'normal'): Promise<any>;
export declare function acceptFriends(gids: number[]): Promise<any>;
export declare function rejectFriends(gids: number[]): Promise<any>;
export declare function getApplications(): Promise<any>;
export declare function delFriend(gid: number): Promise<any>;
export declare function enterFriendFarm(friendGid: number, priority?: 'low' | 'normal'): Promise<any>;
export declare function leaveFriendFarm(friendGid: number, priority?: 'low' | 'normal'): Promise<void>;
export declare function helpWater(friendGid: number, landIds: number[], stopWhenExpLimit?: boolean): Promise<any>;
export interface HelpFarmingOutcome {
    effect: 'confirmed' | 'noop' | 'uncertain';
    operationCount: number;
    landCount: number;
    landIds: number[];
    operationLimits: any[];
    dogSkillGiftCount: number;
    code?: number;
    raw?: any;
}
export declare function helpFarming(friendGid: number, landIds: number[], stopWhenExpLimit?: boolean): Promise<HelpFarmingOutcome>;
export declare function stealHarvest(friendGid: number, landIds: number[]): Promise<any>;
export declare function putPlantItems(friendGid: number, landIds: number[], RequestType: any, ReplyType: any, method: string): Promise<number>;
export declare function putPlantItemsDetailed(friendGid: number, landIds: number[], RequestType: any, ReplyType: any, method: string): Promise<{
    ok: number;
    failed: any[];
    limitReached?: boolean;
}>;
export declare function putInsects(friendGid: number, landIds: number[]): Promise<number>;
export declare function putWeeds(friendGid: number, landIds: number[]): Promise<number>;
export declare function putInsectsDetailed(friendGid: number, landIds: number[]): Promise<{
    ok: number;
    failed: any[];
    limitReached?: boolean;
}>;
export declare function putWeedsDetailed(friendGid: number, landIds: number[]): Promise<{
    ok: number;
    failed: any[];
    limitReached?: boolean;
}>;
export declare function putSocialItem(friendGid: number, landId: number, itemId: number): Promise<any>;
//# sourceMappingURL=api.d.ts.map