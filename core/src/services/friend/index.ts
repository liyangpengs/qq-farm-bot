/**
 * 好友模块 - 统一导出
 */

export {
    acknowledgeKnownFriendGids,
    flushPendingKnownFriendGids,
    reapplyPendingKnownFriendGids,
    removeKnownFriendGid,
    syncKnownFriendGidsFromFriends,
    syncKnownFriendGidsFromRecentVisitors,
} from './gid-manager';

export {
    getFriendDogState,
    getFriendPetCacheStats,
} from './pet-cache';

export {
    isFriendPetSyncRunning,
    runFriendPetSync,
    startFriendPetSyncTimer,
    stopFriendPetSyncTimer,
} from './pet-sync';

export {
    checkFriends,
    getOperationLimits,
    isHelpExpLimitReached,
    onFriendApplicationReceived,
    refreshFriendCheckLoop,
    startFriendCheckLoop,
    stopFriendCheckLoop,
} from './scheduler';

export {
    cacheFriendsListFromReply,
    clearFriendsListCache,
    deleteFriend,
    doFriendOperation,
    getFreshFriendsListCacheOnly,
    getFriendLandsDetail,
    getFriendsList,
    getFriendsListCacheOnly,
} from './visit-strategy';
