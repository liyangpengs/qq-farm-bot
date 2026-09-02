/**
 * 已知好友 GID 管理 + QQ 好友列表获取
 */
export declare function postToMaster(payload: any): boolean;
export declare function pruneInvalidKnownFriendGidCooldown(nowMs?: number): void;
export declare function clearInvalidKnownFriendGidMarks(gids: any[]): void;
export declare function markKnownFriendGidInvalid(friendGid: any, nowMs?: number): void;
export declare function getInvalidKnownFriendGidSet(nowMs?: number): Set<number>;
export declare function clearAllInvalidKnownFriendGidCooldowns(): void;
export declare function normalizeFriendGids(values: any[]): number[];
export declare function extractReplyFriends(reply: any): any[];
export declare function dedupeFriendsByGid(friends: any[]): any[];
export declare function buildFriendReply(friends: any[]): any;
export declare function syncKnownFriendGidsFromFriends(friends: any[]): number[];
export declare function getEffectiveKnownQqFriendGids(): number[];
export declare function syncKnownFriendGidsFromRecentVisitors(force?: boolean, priority?: 'low' | 'normal'): Promise<number[]>;
export declare function removeKnownFriendGid(friendGid: any, friendName?: string, reason?: string): boolean;
export declare function fetchQqFriendsByKnownGids(priority?: 'low' | 'normal'): Promise<any[]>;
export declare function fetchQqFriendsByLegacyMethod(priority?: 'low' | 'normal'): Promise<any[]>;
//# sourceMappingURL=gid-manager.d.ts.map