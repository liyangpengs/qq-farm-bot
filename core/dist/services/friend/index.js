"use strict";
/**
 * 好友模块 - 统一导出
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFriendsListCacheOnly = exports.getFriendsList = exports.getFriendLandsDetail = exports.doFriendOperation = exports.deleteFriend = exports.clearFriendsListCache = exports.cacheFriendsListFromReply = exports.stopFriendCheckLoop = exports.startFriendCheckLoop = exports.refreshFriendCheckLoop = exports.onFriendApplicationReceived = exports.isHelpExpLimitReached = exports.isFriendCheckRunning = exports.getOperationLimits = exports.checkFriends = exports.stopFriendPetSyncTimer = exports.startFriendPetSyncTimer = exports.runFriendPetSync = exports.isFriendPetSyncRunning = exports.getFriendPetCacheStats = exports.getFriendDogState = exports.syncKnownFriendGidsFromRecentVisitors = exports.syncKnownFriendGidsFromFriends = exports.removeKnownFriendGid = void 0;
var gid_manager_1 = require("./gid-manager");
Object.defineProperty(exports, "removeKnownFriendGid", { enumerable: true, get: function () { return gid_manager_1.removeKnownFriendGid; } });
Object.defineProperty(exports, "syncKnownFriendGidsFromFriends", { enumerable: true, get: function () { return gid_manager_1.syncKnownFriendGidsFromFriends; } });
Object.defineProperty(exports, "syncKnownFriendGidsFromRecentVisitors", { enumerable: true, get: function () { return gid_manager_1.syncKnownFriendGidsFromRecentVisitors; } });
var pet_cache_1 = require("./pet-cache");
Object.defineProperty(exports, "getFriendDogState", { enumerable: true, get: function () { return pet_cache_1.getFriendDogState; } });
Object.defineProperty(exports, "getFriendPetCacheStats", { enumerable: true, get: function () { return pet_cache_1.getFriendPetCacheStats; } });
var pet_sync_1 = require("./pet-sync");
Object.defineProperty(exports, "isFriendPetSyncRunning", { enumerable: true, get: function () { return pet_sync_1.isFriendPetSyncRunning; } });
Object.defineProperty(exports, "runFriendPetSync", { enumerable: true, get: function () { return pet_sync_1.runFriendPetSync; } });
Object.defineProperty(exports, "startFriendPetSyncTimer", { enumerable: true, get: function () { return pet_sync_1.startFriendPetSyncTimer; } });
Object.defineProperty(exports, "stopFriendPetSyncTimer", { enumerable: true, get: function () { return pet_sync_1.stopFriendPetSyncTimer; } });
var scheduler_1 = require("./scheduler");
Object.defineProperty(exports, "checkFriends", { enumerable: true, get: function () { return scheduler_1.checkFriends; } });
Object.defineProperty(exports, "getOperationLimits", { enumerable: true, get: function () { return scheduler_1.getOperationLimits; } });
Object.defineProperty(exports, "isFriendCheckRunning", { enumerable: true, get: function () { return scheduler_1.isFriendCheckRunning; } });
Object.defineProperty(exports, "isHelpExpLimitReached", { enumerable: true, get: function () { return scheduler_1.isHelpExpLimitReached; } });
Object.defineProperty(exports, "onFriendApplicationReceived", { enumerable: true, get: function () { return scheduler_1.onFriendApplicationReceived; } });
Object.defineProperty(exports, "refreshFriendCheckLoop", { enumerable: true, get: function () { return scheduler_1.refreshFriendCheckLoop; } });
Object.defineProperty(exports, "startFriendCheckLoop", { enumerable: true, get: function () { return scheduler_1.startFriendCheckLoop; } });
Object.defineProperty(exports, "stopFriendCheckLoop", { enumerable: true, get: function () { return scheduler_1.stopFriendCheckLoop; } });
var visit_strategy_1 = require("./visit-strategy");
Object.defineProperty(exports, "cacheFriendsListFromReply", { enumerable: true, get: function () { return visit_strategy_1.cacheFriendsListFromReply; } });
Object.defineProperty(exports, "clearFriendsListCache", { enumerable: true, get: function () { return visit_strategy_1.clearFriendsListCache; } });
Object.defineProperty(exports, "deleteFriend", { enumerable: true, get: function () { return visit_strategy_1.deleteFriend; } });
Object.defineProperty(exports, "doFriendOperation", { enumerable: true, get: function () { return visit_strategy_1.doFriendOperation; } });
Object.defineProperty(exports, "getFriendLandsDetail", { enumerable: true, get: function () { return visit_strategy_1.getFriendLandsDetail; } });
Object.defineProperty(exports, "getFriendsList", { enumerable: true, get: function () { return visit_strategy_1.getFriendsList; } });
Object.defineProperty(exports, "getFriendsListCacheOnly", { enumerable: true, get: function () { return visit_strategy_1.getFriendsListCacheOnly; } });
//# sourceMappingURL=index.js.map