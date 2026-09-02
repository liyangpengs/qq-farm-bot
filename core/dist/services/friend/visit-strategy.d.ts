/**
 * 拜访好友策略 - 访问逻辑、好友分析、错误处理、安静时段
 */
export declare function handleFriendEnterError(friendGid: any, friendName: string, error: any): {
    handled: boolean;
    kind: string;
};
export declare function parseTimeToMinutes(timeStr: string): number | null;
export declare function inFriendQuietHours(now?: Date): boolean;
export declare function inFarmQuietHours(now?: Date): boolean;
interface AnalyzeResult {
    stealable: number[];
    stealableInfo: any[];
    needWater: number[];
    needWeed: number[];
    needBug: number[];
    canPutWeed: number[];
    canPutBug: number[];
}
interface AnalyzeOptions {
    plantBlacklist?: number[] | null;
}
export declare function analyzeFriendLands(lands: any[], myGid: number, friendName?: string, options?: AnalyzeOptions): AnalyzeResult;
/**
 * 获取好友列表 (供面板)
 */
export declare function getFriendsList(forceSync?: boolean): Promise<any[]>;
/**
 * 获取指定好友的农田详情 (进入-获取-离开)
 */
export declare function getFriendLandsDetail(friendGid: number): Promise<any>;
export declare function runBatchWithFallback(ids: number[], batchFn: (ids: number[]) => Promise<any>, singleFn: (ids: number[]) => Promise<any>): Promise<number>;
/**
 * 面板手动好友操作（单个好友）
 * opType: 'steal' | 'water' | 'weed' | 'bug' | 'bad'
 */
export declare function doFriendOperation(friendGid: any, opType: string): Promise<any>;
interface VisitResult {
    acted: boolean;
    entered: boolean;
}
export declare function visitFriend(friend: any, totalActions: any, myGid: number, accountId: string): Promise<VisitResult>;
export declare function visitFriendForSteal(friend: any, totalActions: any, myGid: number, accountId: string): Promise<VisitResult | undefined>;
export declare function visitFriendForHelp(friend: any, totalActions: any, myGid: number, accountId: string, ignoreExpLimit?: boolean): Promise<VisitResult | undefined>;
export declare function clearFriendsListCache(): void;
export {};
//# sourceMappingURL=visit-strategy.d.ts.map