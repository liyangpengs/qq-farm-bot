"use strict";
/**
 * 好友模块 - 统一导出
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFriendsList = exports.getFriendLandsDetail = exports.doFriendOperation = exports.clearFriendsListCache = exports.stopFriendCheckLoop = exports.startFriendCheckLoop = exports.runBadOnceOnStartup = exports.refreshFriendCheckLoop = exports.onFriendApplicationReceived = exports.isHelpExpLimitReached = exports.getOperationLimits = exports.checkFriends = exports.syncKnownFriendGidsFromRecentVisitors = exports.syncKnownFriendGidsFromFriends = exports.removeKnownFriendGid = void 0;
var gid_manager_1 = require("./gid-manager");
Object.defineProperty(exports, "removeKnownFriendGid", { enumerable: true, get: function () { return gid_manager_1.removeKnownFriendGid; } });
Object.defineProperty(exports, "syncKnownFriendGidsFromFriends", { enumerable: true, get: function () { return gid_manager_1.syncKnownFriendGidsFromFriends; } });
Object.defineProperty(exports, "syncKnownFriendGidsFromRecentVisitors", { enumerable: true, get: function () { return gid_manager_1.syncKnownFriendGidsFromRecentVisitors; } });
var scheduler_1 = require("./scheduler");
Object.defineProperty(exports, "checkFriends", { enumerable: true, get: function () { return scheduler_1.checkFriends; } });
Object.defineProperty(exports, "getOperationLimits", { enumerable: true, get: function () { return scheduler_1.getOperationLimits; } });
Object.defineProperty(exports, "isHelpExpLimitReached", { enumerable: true, get: function () { return scheduler_1.isHelpExpLimitReached; } });
Object.defineProperty(exports, "onFriendApplicationReceived", { enumerable: true, get: function () { return scheduler_1.onFriendApplicationReceived; } });
Object.defineProperty(exports, "refreshFriendCheckLoop", { enumerable: true, get: function () { return scheduler_1.refreshFriendCheckLoop; } });
Object.defineProperty(exports, "runBadOnceOnStartup", { enumerable: true, get: function () { return scheduler_1.runBadOnceOnStartup; } });
Object.defineProperty(exports, "startFriendCheckLoop", { enumerable: true, get: function () { return scheduler_1.startFriendCheckLoop; } });
Object.defineProperty(exports, "stopFriendCheckLoop", { enumerable: true, get: function () { return scheduler_1.stopFriendCheckLoop; } });
var visit_strategy_1 = require("./visit-strategy");
Object.defineProperty(exports, "clearFriendsListCache", { enumerable: true, get: function () { return visit_strategy_1.clearFriendsListCache; } });
Object.defineProperty(exports, "doFriendOperation", { enumerable: true, get: function () { return visit_strategy_1.doFriendOperation; } });
Object.defineProperty(exports, "getFriendLandsDetail", { enumerable: true, get: function () { return visit_strategy_1.getFriendLandsDetail; } });
Object.defineProperty(exports, "getFriendsList", { enumerable: true, get: function () { return visit_strategy_1.getFriendsList; } });
//# sourceMappingURL=index.js.map