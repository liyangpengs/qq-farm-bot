"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { findAccountByRef, normalizeAccountRef, resolveAccountId: resolveAccountIdByList } = require('../services/account-resolver');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');
function createDataProvider(options) {
    const { workers, globalLogs, accountLogs, store, getAccounts, callWorkerApi, buildDefaultStatus, normalizeStatusForPanel, filterLogs, addAccountLog, nextConfigRevision, broadcastConfigToWorkers, buildConfigSnapshotForAccount, broadcastGameConfigReload: broadcastGameConfigReloadOpt, startWorker, stopWorker, restartWorker, } = options;
    function getStoredAccountsList() {
        const data = getAccounts();
        return Array.isArray(data.accounts) ? data.accounts : [];
    }
    function resolveAccountRefId(accountRef) {
        const raw = normalizeAccountRef(accountRef);
        if (!raw)
            return '';
        const resolved = resolveAccountIdByList(getStoredAccountsList(), raw);
        return resolved || raw;
    }
    function findAccountByAnyRef(accountRef) {
        return findAccountByRef(getStoredAccountsList(), accountRef);
    }
    return {
        resolveAccountId: (accountRef) => resolveAccountRefId(accountRef),
        getStatus: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId)
                return buildDefaultStatus('');
            const w = workers[accountId];
            if (!w || !w.status)
                return buildDefaultStatus(accountId);
            return {
                ...buildDefaultStatus(accountId),
                ...normalizeStatusForPanel(w.status, accountId, w.name),
                wsError: w.wsError || null,
            };
        },
        getLogs: (accountRef, optionsOrLimit) => {
            const opts = (typeof optionsOrLimit === 'object' && optionsOrLimit) ? optionsOrLimit : { limit: optionsOrLimit };
            const max = Math.max(1, Number(opts.limit) || 100);
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);
            if (!rawRef || rawRef === 'all') {
                return filterLogs(globalLogs, opts).slice(-max);
            }
            if (!accountId)
                return [];
            const accId = String(accountId || '');
            return filterLogs(globalLogs.filter(l => String(l.accountId || '') === accId), opts).slice(-max);
        },
        getAccountLogs: (limit) => accountLogs.slice(-limit).reverse(),
        addAccountLog: (action, msg, accountId, accountName, extra) => addAccountLog(action, msg, accountId, accountName, extra),
        clearLogs: (accountRef) => {
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);
            if (!rawRef || rawRef === 'all') {
                globalLogs.length = 0;
                return { cleared: 'all' };
            }
            if (!accountId)
                return { cleared: 0 };
            const accId = String(accountId || '');
            const before = globalLogs.length;
            for (let i = globalLogs.length - 1; i >= 0; i--) {
                if (String(globalLogs[i].accountId || '') === accId) {
                    globalLogs.splice(i, 1);
                }
            }
            const after = globalLogs.length;
            return { cleared: before - after, accountId };
        },
        getLands: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getLands'),
        getIllustratedSnapshot: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getIllustratedSnapshot'),
        getFriends: (accountRef, forceSync = false) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriends', forceSync),
        getFriendsCache: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendsCache'),
        clearFriendsCache: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'clearFriendsCache'),
        getInteractRecords: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getInteractRecords'),
        getFriendLands: (accountRef, gid) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendLands', gid),
        getFriendInteractionItems: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'getFriendInteractionItems')),
        useFriendInteractionItemBatch: (accountRef, gid, itemId, landIds) => (callWorkerApi(resolveAccountRefId(accountRef), 'useFriendInteractionItemBatch', gid, itemId, landIds)),
        useFriendFarmInteractionItem: (accountRef, gid, itemId) => (callWorkerApi(resolveAccountRefId(accountRef), 'useFriendFarmInteractionItem', gid, itemId)),
        getSelfInteractionItems: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'getSelfInteractionItems')),
        useSelfInteractionItemBatch: (accountRef, itemId, landIds) => (callWorkerApi(resolveAccountRefId(accountRef), 'useSelfInteractionItemBatch', itemId, landIds)),
        doFriendOp: (accountRef, gid, opType) => callWorkerApi(resolveAccountRefId(accountRef), 'doFriendOp', gid, opType),
        delFriend: (accountRef, gid) => callWorkerApi(resolveAccountRefId(accountRef), 'delFriend', gid),
        getBag: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getBag'),
        getBagSeeds: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getBagSeeds'),
        getDiamondBalance: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDiamondBalance'),
        useItem: (accountRef, itemId, count, uid = 0) => callWorkerApi(resolveAccountRefId(accountRef), 'useItem', itemId, count, uid),
        sellItems: (accountRef, items) => callWorkerApi(resolveAccountRefId(accountRef), 'sellItems', items),
        setItemsLocked: (accountRef, itemUids, locked) => (callWorkerApi(resolveAccountRefId(accountRef), 'setItemsLocked', itemUids, locked)),
        getDogSkillGiftStatus: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'getDogSkillGiftStatus')),
        claimDogSkillGifts: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'claimDogSkillGifts')),
        getPetInfo: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'getPetInfo')),
        deployDog: (accountRef, dogId) => (callWorkerApi(resolveAccountRefId(accountRef), 'deployDog', dogId)),
        withdrawDog: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'withdrawDog')),
        useDogFood: (accountRef, itemId, count = 1, uid = 0) => (callWorkerApi(resolveAccountRefId(accountRef), 'useDogFood', itemId, count, uid)),
        getPetProtectLogs: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'getPetProtectLogs')),
        getDailyGifts: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDailyGiftOverview'),
        getActivityDirectorySnapshot: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getActivityDirectorySnapshot'),
        getActivityCenterSnapshot: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getActivityCenterSnapshot'),
        getCurrentSeasonEvent: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSeasonEvent'),
        getCurrentStellarActivity: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentStellarActivity'),
        getCurrentStarSandShop: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentStarSandShop'),
        getCurrentSolarTerms: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSolarTerms'),
        getCurrentQixiActivity: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentQixiActivity'),
        getCurrentCharityRedFlowerActivity: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentCharityRedFlowerActivity'),
        claimCharityRedFlowerSeeds: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityRedFlowerSeeds'),
        donateCharityRedFlowerLove: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'donateCharityRedFlowerLove'),
        claimCharityRedFlowerDailyGift: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityRedFlowerDailyGift'),
        getCurrentWeatherActivity: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentWeatherActivity'),
        buyWeatherBottle: (accountRef, count) => callWorkerApi(resolveAccountRefId(accountRef), 'buyWeatherBottle', count),
        collectWeatherBottle: (accountRef, targetGid) => callWorkerApi(resolveAccountRefId(accountRef), 'collectWeatherBottle', targetGid),
        lightWeatherResearch: (accountRef, nodeId) => callWorkerApi(resolveAccountRefId(accountRef), 'lightWeatherResearch', nodeId),
        summonWeatherRain: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'summonWeatherRain'),
        claimBattlePassRewards: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimBattlePassRewards'),
        exchangeStarSandGoods: (accountRef, goodsId, count) => (callWorkerApi(resolveAccountRefId(accountRef), 'exchangeStarSandGoods', goodsId, count)),
        lightConstellation: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'lightConstellation'),
        claimSolarTerm: (accountRef, termId) => callWorkerApi(resolveAccountRefId(accountRef), 'claimSolarTerm', termId),
        getCurrentQingMeiActivity: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentQingMeiActivity'),
        claimQingMeiDailySeed: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimQingMeiDailySeed'),
        startQingMeiBrew: (accountRef, ingredients) => callWorkerApi(resolveAccountRefId(accountRef), 'startQingMeiBrew', ingredients),
        continueQingMeiBrew: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'continueQingMeiBrew'),
        settleQingMeiBrew: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'settleQingMeiBrew'),
        claimQixiBridgeRewards: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimQixiBridgeRewards'),
        giftQixiSachet: (accountRef, friendGid, messageTextId = 15) => (callWorkerApi(resolveAccountRefId(accountRef), 'giftQixiSachet', friendGid, messageTextId)),
        exchangeWeatherCollectorBottle: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'exchangeWeatherCollectorBottle')),
        getWeatherFriends: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'getWeatherFriends')),
        scanWeatherFriends: (accountRef, friendGids) => (callWorkerApi(resolveAccountRefId(accountRef), 'scanWeatherFriends', friendGids)),
        useWeatherCollectorBottle: (accountRef, friendGid) => (callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherCollectorBottle', friendGid)),
        useWeatherSummonBottle: (accountRef) => (callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherSummonBottle')),
        useWeatherFrogBottle: (accountRef, friendGid) => (callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherFrogBottle', friendGid)),
        useWeatherCloudBottle: (accountRef, friendGid, landId) => (callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherCloudBottle', friendGid, landId)),
        advanceWeatherResearch: (accountRef, nodeId) => (callWorkerApi(resolveAccountRefId(accountRef), 'advanceWeatherResearch', nodeId)),
        getMallCatalog: (accountRef, slotType, subSlotType) => (callWorkerApi(resolveAccountRefId(accountRef), 'getMallCatalog', slotType, subSlotType)),
        purchaseMallProduct: (accountRef, goodsId, count) => (callWorkerApi(resolveAccountRefId(accountRef), 'purchaseMallProduct', goodsId, count)),
        getMysteryShop: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getMysteryShop'),
        purchaseMysteryOffer: (accountRef, npcId) => (callWorkerApi(resolveAccountRefId(accountRef), 'purchaseMysteryOffer', npcId)),
        getSeeds: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getSeeds'),
        setAutomation: async (accountRef, key, value) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            store.setAutomation(key, value, accountId);
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(accountId);
            return { automation: store.getAutomation(accountId), configRevision: rev };
        },
        doFarmOp: (accountRef, opType, targetLandId = null) => (callWorkerApi(resolveAccountRefId(accountRef), 'doFarmOp', opType, targetLandId)),
        fertilizeOwnLand: (accountRef, landId, fertilizerType) => (callWorkerApi(resolveAccountRefId(accountRef), 'fertilizeOwnLand', landId, fertilizerType)),
        doAnalytics: (accountRef, sortBy) => callWorkerApi(resolveAccountRefId(accountRef), 'getAnalytics', sortBy),
        buyFertilizer: (accountRef, type, count) => callWorkerApi(resolveAccountRefId(accountRef), 'buyFertilizer', type, count),
        checkAndBuyFertilizer: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'checkAndBuyFertilizer', options),
        saveSettings: async (accountRef, payload) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            const body = (payload && typeof payload === 'object') ? payload : {};
            const snapshot = {};
            const copyIfPresent = (sourceKey, targetKey = sourceKey) => {
                if (Object.hasOwn(body, sourceKey)) {
                    snapshot[targetKey] = body[sourceKey];
                }
            };
            copyIfPresent('plantingStrategy');
            if (!Object.hasOwn(snapshot, 'plantingStrategy'))
                copyIfPresent('strategy', 'plantingStrategy');
            copyIfPresent('preferredSeedId');
            if (!Object.hasOwn(snapshot, 'preferredSeedId'))
                copyIfPresent('seedId', 'preferredSeedId');
            for (const key of [
                'automation',
                'intervals',
                'friendQuietHours',
                'stealDelaySeconds',
                'plantOrderRandom',
                'plantDelaySeconds',
                'fertilizerBuyOrganicCount',
                'fertilizerBuyOrganicThresholdHours',
                'fertilizerBuyNormalCount',
                'fertilizerBuyNormalThresholdHours',
                'fertilizerBuyCheckIntervalMinutes',
                'bagSeedPriority',
                'bagSeedLandTypes',
                'bagSeedFallbackStrategy',
                'autoAcceptFriendMinLevel',
                'autoAcceptRequireOwnLevel',
                'autoAcceptHarvestStealEnabled',
                'autoAcceptHarvestStealHarvest',
                'autoAcceptHarvestStealSteal',
            ]) {
                copyIfPresent(key);
            }
            // One apply performs the only persistence for this save request.
            store.applyConfigSnapshot(snapshot, { accountId });
            const rev = nextConfigRevision();
            const config = buildConfigSnapshotForAccount(accountId);
            const { ui: _ui, ...savedConfig } = store.getConfigSnapshot(accountId);
            const result = {
                ...savedConfig,
                strategy: savedConfig.plantingStrategy,
                preferredSeed: savedConfig.preferredSeedId,
                saved: true,
                configRevision: rev,
            };
            const targetWorker = workers[accountId];
            if (!targetWorker || targetWorker.stopping || targetWorker.terminalHandled) {
                return {
                    ...result,
                    status: 'stopped',
                    stopped: true,
                    confirmed: false,
                    appliedRevision: null,
                };
            }
            try {
                const ack = await callWorkerApi(accountId, 'applyRuntimeConfigSnapshot', config);
                const appliedRevision = Number(ack && ack.appliedRevision);
                if (!Number.isFinite(appliedRevision) || appliedRevision < rev) {
                    const error = new Error(`Worker applied revision ${appliedRevision || 0}, expected at least ${rev}`);
                    error.code = 'CONFIG_ACK_REVISION_MISMATCH';
                    throw error;
                }
                return {
                    ...result,
                    status: 'confirmed',
                    stopped: false,
                    confirmed: true,
                    appliedRevision,
                };
            }
            catch (e) {
                const message = String(e?.message || e || 'Worker configuration ACK failed');
                const code = e?.code || (message === 'API Timeout' ? 'CONFIG_ACK_TIMEOUT' : 'CONFIG_ACK_FAILED');
                return {
                    ...result,
                    status: 'unconfirmed',
                    stopped: false,
                    confirmed: false,
                    unconfirmed: true,
                    appliedRevision: null,
                    confirmationError: {
                        code: String(code),
                        message,
                    },
                };
            }
        },
        setUITheme: async (theme) => {
            const snapshot = store.setUITheme(theme);
            return { ui: snapshot.ui || store.getUI() };
        },
        broadcastConfig: (accountId) => {
            broadcastConfigToWorkers(accountId);
        },
        broadcastGameConfigReload: () => {
            if (typeof broadcastGameConfigReloadOpt === 'function')
                broadcastGameConfigReloadOpt();
        },
        setRuntimeAccountName: (accountRef, accountName) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId)
                return;
            const worker = workers[accountId];
            if (worker) {
                worker.name = String(accountName || worker.name || accountId);
            }
        },
        getAccounts: (owner) => {
            const data = getAccounts();
            const ownerKey = owner ? String(owner) : '';
            let accounts = Array.isArray(data.accounts) ? data.accounts : [];
            if (ownerKey) {
                accounts = accounts.filter((a) => String(a.owner || '') === ownerKey);
            }
            accounts.forEach((a) => {
                const worker = workers[a.id];
                a.running = !!worker;
                if (worker && worker.status && worker.status.status && worker.status.status.name) {
                    a.nick = worker.status.status.name;
                }
                if (worker && worker.status && worker.status.status && worker.status.status.avatarUrl) {
                    a.avatar = worker.status.status.avatarUrl;
                }
            });
            return { ...data, accounts };
        },
        startAccount: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc)
                return false;
            startWorker(acc);
            return true;
        },
        stopAccount: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc)
                return false;
            if (accountId)
                stopWorker(accountId);
            return true;
        },
        restartAccount: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc)
                return false;
            restartWorker(acc);
            return true;
        },
        isAccountRunning: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            return !!(accountId && workers[accountId]);
        },
        getSchedulerStatus: async (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const runtime = getSchedulerRegistrySnapshot();
            let worker = null;
            let workerError = '';
            if (!accountId) {
                return { accountId: '', runtime, worker, workerError };
            }
            if (!workers[accountId]) {
                return { accountId, runtime, worker, workerError: '账号未运行' };
            }
            try {
                worker = await callWorkerApi(accountId, 'getSchedulers');
            }
            catch (e) {
                workerError = (e && e.message) ? e.message : String(e || 'unknown');
            }
            return { accountId, runtime, worker, workerError };
        },
    };
}
module.exports = {
    createDataProvider,
};
//# sourceMappingURL=data-provider.js.map