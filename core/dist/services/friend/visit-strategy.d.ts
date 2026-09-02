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
export type FriendPetState = 'protect' | 'other' | 'none' | 'unknown';
/**
 * 好友上场宠物的展示信息，数据全部来自按天缓存（进好友农场时顺手写入 + 每日同步补齐），
 * 为了展示不会额外发任何 RPC；当天还没确认过的好友是 unknown，交由每日同步补齐。
 */
export declare function buildFriendPetView(friendGid: any): {
    petState: FriendPetState;
    pet: any;
};
/**
 * 获取好友列表 (供面板)
 */
export declare function cacheFriendsListFromReply(reply: any): any[];
export declare function getFriendsList(forceSync?: boolean, priority?: 'low' | 'normal'): Promise<any[]>;
export declare function getFriendsListCacheOnly(): any[];
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
    status?: 'helped' | 'skipped_exp_limit' | 'protect_dog_bypass' | 'no_action' | 'enter_failed';
    protectDogBypass?: boolean;
}
/** 单次访问要做哪几件事；默认全做，保持老调用方的行为不变。 */
export interface VisitFriendOptions {
    allowSteal?: boolean;
    allowHelp?: boolean;
    allowBad?: boolean;
    ignoreExpLimit?: boolean;
}
/**
 * 进一次好友农场，把 帮助（除草/除虫/浇水）+ 偷菜 + 捣乱（放草/放虫）一次做完。
 * 三件事都不需要做时连 Enter 都不发——省下的就是以前那一屏 Enter/Leave 超时日志。
 */
export declare function visitFriend(friend: any, totalActions: any, myGid: number, accountId: string, options?: VisitFriendOptions): Promise<VisitResult>;
export declare function clearFriendsListCache(): void;
export declare function removeFriendFromFriendsListCache(friendGid: any): void;
export declare function deleteFriend(friendGid: any): Promise<{
    ok: true;
    gid: number;
}>;
export {};
//# sourceMappingURL=visit-strategy.d.ts.map