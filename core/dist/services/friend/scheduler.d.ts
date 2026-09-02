/**
 * 好友巡查调度 - 循环管理、每日重置、经验限制、自动接受好友、启动捣乱
 */
/**
 * 检查是否需要重置每日限制 (0点刷新)
 */
export declare function checkDailyReset(): void;
export declare function isBadOperationLimitReached(): boolean;
export declare function markBadOperationLimitReached(method?: string): boolean;
export declare function autoDisableHelpByExpLimit(): void;
/**
 * 更新操作限制状态
 */
export declare function updateOperationLimits(limits: any[]): void;
export declare function canGetExpByCandidates(opIds?: number[]): boolean;
/**
 * 检查某操作是否还能获得经验
 */
export declare function canGetExp(opId: number): boolean;
/**
 * 检查某操作是否还有次数
 */
export declare function canOperate(opId: number): boolean;
/**
 * 获取某操作剩余次数
 */
export declare function getRemainingTimes(opId: number): number;
export declare function getRemainingBadOperationTimes(): number;
/**
 * 获取操作限制详情 (供管理面板使用)
 */
export declare function getOperationLimits(): Record<string, any>;
export declare function getCanGetHelpExp(): boolean;
export declare function setCanGetHelpExp(val: boolean): void;
interface CheckFriendsOptions {
    onlyHelp?: boolean;
    onlySteal?: boolean;
    onlyBad?: boolean;
    ignoreExpLimit?: boolean;
}
export declare function isFriendCheckRunning(): boolean;
export declare function checkFriends(options?: CheckFriendsOptions): Promise<boolean>;
interface StartOptions {
    externalScheduler?: boolean;
}
export declare function startFriendCheckLoop(options?: StartOptions): void;
export declare function stopFriendCheckLoop(): void;
export declare function refreshFriendCheckLoop(delayMs?: number): void;
/**
 * 处理服务器推送的好友申请
 */
export declare function onFriendApplicationReceived(applications: any[]): void;
export declare function isHelpExpLimitReached(): boolean;
export {};
//# sourceMappingURL=scheduler.d.ts.map