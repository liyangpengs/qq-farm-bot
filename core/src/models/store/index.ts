export {};
const sharedState = require('./shared-state');
const globalConfig = require('./global-config');
const accountConfig = require('./account-config');
const accounts = require('./accounts');

module.exports = {
    // Account config
    getConfigSnapshot: accountConfig.getConfigSnapshot,
    applyConfigSnapshot: accountConfig.applyConfigSnapshot,
    getAutomation: accountConfig.getAutomation,
    setAutomation: accountConfig.setAutomation,
    isAutomationOn: accountConfig.isAutomationOn,
    getPreferredSeed: accountConfig.getPreferredSeed,
    getPlantingStrategy: accountConfig.getPlantingStrategy,
    getBagSeedPriority: accountConfig.getBagSeedPriority,
    getBagSeedFallbackStrategy: accountConfig.getBagSeedFallbackStrategy,
    getIntervals: accountConfig.getIntervals,
    getFriendQuietHours: accountConfig.getFriendQuietHours,
    getKnownFriendGids: accountConfig.getKnownFriendGids,
    setKnownFriendGids: accountConfig.setKnownFriendGids,
    getKnownFriendGidSyncCooldownSec: accountConfig.getKnownFriendGidSyncCooldownSec,
    setKnownFriendGidSyncCooldownSec: accountConfig.setKnownFriendGidSyncCooldownSec,
    getFriendsListCacheTtlSec: accountConfig.getFriendsListCacheTtlSec,
    setFriendsListCacheTtlSec: accountConfig.setFriendsListCacheTtlSec,
    getFriendBlacklist: accountConfig.getFriendBlacklist,
    setFriendBlacklist: accountConfig.setFriendBlacklist,
    addFriendToBlacklist: accountConfig.addFriendToBlacklist,
    getStealDelaySeconds: accountConfig.getStealDelaySeconds,
    getPlantOrderRandom: accountConfig.getPlantOrderRandom,
    getPlantDelaySeconds: accountConfig.getPlantDelaySeconds,
    getFertilizerBuyOrganicCount: accountConfig.getFertilizerBuyOrganicCount,
    getFertilizerBuyOrganicThresholdHours: accountConfig.getFertilizerBuyOrganicThresholdHours,
    getFertilizerBuyNormalCount: accountConfig.getFertilizerBuyNormalCount,
    getFertilizerBuyNormalThresholdHours: accountConfig.getFertilizerBuyNormalThresholdHours,
    getFertilizerBuyCheckIntervalMinutes: accountConfig.getFertilizerBuyCheckIntervalMinutes,
    getPlantBlacklist: accountConfig.getPlantBlacklist,
    setPlantBlacklist: accountConfig.setPlantBlacklist,
    getDefaultAccountConfig: accountConfig.getDefaultAccountConfig,

    // Global config
    getUI: globalConfig.getUI,
    setUITheme: globalConfig.setUITheme,
    getOfflineReminder: globalConfig.getOfflineReminder,
    setOfflineReminder: globalConfig.setOfflineReminder,

    // Accounts
    getAccounts: accounts.getAccounts,
    addOrUpdateAccount: accounts.addOrUpdateAccount,
    deleteAccount: accounts.deleteAccount,

    // System config
    getSystemConfig: globalConfig.getSystemConfig,
    setSystemConfig: globalConfig.setSystemConfig,
};
