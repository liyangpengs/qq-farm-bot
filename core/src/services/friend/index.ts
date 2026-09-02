/**
 * 好友模块 - 统一导出
 */

export {
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
    isFriendCheckRunning,
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
    getFriendLandsDetail,
    getFriendsList,
    getFriendsListCacheOnly,
} from './visit-strategy';
