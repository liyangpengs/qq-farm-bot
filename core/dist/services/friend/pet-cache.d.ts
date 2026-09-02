/**
 * 好友护主犬缓存 - 记录每位好友当前上场的宠物，避免每轮巡查靠 Enter 试探
 *
 * 数据只有一个来源：VisitService.Enter 回包的 brief_dog_info.dog_id（visitpb.proto field 3）。
 * 因此所有进入好友农场的调用都顺手写入这里（偷菜、帮忙、捣乱、天气扫描、面板手动操作），
 * 真正额外花 RPC 的只有 pet-sync.ts 的每日补齐。
 *
 * 新鲜度按“系统日期”判定：好友随时可以换狗或让狗粮吃完，所以跨日的记录一律视为未知，
 * 由每日同步重新确认。
 */
export declare const PROTECT_DOG_ID: number;
export type FriendDogState = 'protect' | 'other' | 'unknown';
/**
 * 记录一位好友当前上场的狗；dogId 为 0 表示没有上场狗，同样是有效结论。
 */
export declare function recordFriendDog(friendGid: any, dogId: any): void;
/**
 * 从 Enter 回包顺手记录，供所有进入好友农场的调用复用（零额外 RPC）。
 */
export declare function recordFriendDogFromEnterReply(friendGid: any, enterReply: any): void;
export declare function getFriendDogState(friendGid: any): FriendDogState;
export declare function isFriendDogKnownToday(friendGid: any): boolean;
export declare function getFriendDogId(friendGid: any): number;
export declare function forgetFriendDog(friendGid: any): void;
export declare function isFullSyncDoneToday(): boolean;
/**
 * 停机前把防抖里的待写落盘，避免丢掉当天已确认的结论。
 */
export declare function flushFriendPetCacheNow(): void;
export declare function markFullSyncDone(): void;
export declare function getFriendPetCacheStats(): {
    date: string;
    known: number;
    protect: number;
    fullSyncDone: boolean;
};
/**
 * 仅供停机与测试使用：丢掉内存态，下次访问重新从文件加载。
 */
export declare function resetFriendPetCacheMemory(): void;
//# sourceMappingURL=pet-cache.d.ts.map