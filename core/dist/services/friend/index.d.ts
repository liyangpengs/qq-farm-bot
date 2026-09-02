/**
 * 好友模块 - 统一导出
 */
export { removeKnownFriendGid, syncKnownFriendGidsFromFriends, syncKnownFriendGidsFromRecentVisitors, } from './gid-manager';
export { checkFriends, getOperationLimits, isHelpExpLimitReached, onFriendApplicationReceived, refreshFriendCheckLoop, runBadOnceOnStartup, startFriendCheckLoop, stopFriendCheckLoop, } from './scheduler';
export { clearFriendsListCache, doFriendOperation, getFriendLandsDetail, getFriendsList, } from './visit-strategy';
//# sourceMappingURL=index.d.ts.map