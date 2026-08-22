export {};
const { findAccountByRef, normalizeAccountRef, resolveAccountId: resolveAccountIdByList } = require('../services/account-resolver');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');

interface DataProviderOptions {
    workers: Record<string, any>;
    globalLogs: any[];
    accountLogs: any[];
    store: any;
    getAccounts: () => any;
    callWorkerApi: (accountId: string, method: string, ...args: any[]) => Promise<any>;
    buildDefaultStatus: (accountId: string) => any;
    normalizeStatusForPanel: (data: any, accountId: string, accountName: string) => any;
    filterLogs: (list: any[], filters?: any) => any[];
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    nextConfigRevision: () => number;
    broadcastConfigToWorkers: (accountId?: string) => void;
    buildConfigSnapshotForAccount: (accountId: string) => any;
    broadcastGameConfigReload?: () => void;
    startWorker: (account: any) => boolean;
    stopWorker: (accountId: string) => void;
    restartWorker: (account: any) => void;
}

function createDataProvider(options: DataProviderOptions) {
    const {
        workers,
        globalLogs,
        accountLogs,
        store,
        getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        buildConfigSnapshotForAccount,
        broadcastGameConfigReload: broadcastGameConfigReloadOpt,
        startWorker,
        stopWorker,
        restartWorker,
    } = options;

    function getStoredAccountsList(): any[] {
        const data = getAccounts();
        return Array.isArray(data.accounts) ? data.accounts : [];
    }

    function resolveAccountRefId(accountRef: string): string {
        const raw = normalizeAccountRef(accountRef);
        if (!raw) return '';
        const resolved = resolveAccountIdByList(getStoredAccountsList(), raw);
        return resolved || raw;
    }

    function findAccountByAnyRef(accountRef: string): any {
        return findAccountByRef(getStoredAccountsList(), accountRef);
    }

    return {
        resolveAccountId: (accountRef: string) => resolveAccountRefId(accountRef),

        getStatus: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) return buildDefaultStatus('');
            const w = workers[accountId];
            if (!w || !w.status) return buildDefaultStatus(accountId);
            return {
                ...buildDefaultStatus(accountId),
                ...normalizeStatusForPanel(w.status, accountId, w.name),
                wsError: w.wsError || null,
            };
        },

        getLogs: (accountRef: string, optionsOrLimit?: any) => {
            const opts = (typeof optionsOrLimit === 'object' && optionsOrLimit) ? optionsOrLimit : { limit: optionsOrLimit };
            const max = Math.max(1, Number(opts.limit) || 100);
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);
            if (!rawRef || rawRef === 'all') {
                return filterLogs(globalLogs, opts).slice(-max);
            }
            if (!accountId) return [];
            const accId = String(accountId || '');
            return filterLogs(globalLogs.filter(l => String(l.accountId || '') === accId), opts).slice(-max);
        },

        getAccountLogs: (limit: number) => accountLogs.slice(-limit).reverse(),
        addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => addAccountLog(action, msg, accountId, accountName, extra),

        clearLogs: (accountRef: string) => {
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);

            if (!rawRef || rawRef === 'all') {
                globalLogs.length = 0;
                return { cleared: 'all' };
            }

            if (!accountId) return { cleared: 0 };

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

        getLands: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getLands'),
        getIllustratedSnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getIllustratedSnapshot'),
        getFriends: (accountRef: string, forceSync = false) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriends', forceSync),
        clearFriendsCache: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'clearFriendsCache'),
        getInteractRecords: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getInteractRecords'),
        getFriendLands: (accountRef: string, gid: number) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendLands', gid),
        getFriendInteractionItems: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getFriendInteractionItems')
        ),
        useFriendInteractionItemBatch: (accountRef: string, gid: unknown, itemId: unknown, landIds: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useFriendInteractionItemBatch', gid, itemId, landIds)
        ),
        getSelfInteractionItems: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getSelfInteractionItems')
        ),
        useSelfInteractionItemBatch: (accountRef: string, itemId: unknown, landIds: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useSelfInteractionItemBatch', itemId, landIds)
        ),
        doFriendOp: (accountRef: string, gid: number, opType: string) => callWorkerApi(resolveAccountRefId(accountRef), 'doFriendOp', gid, opType),
        getBag: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getBag'),
        getBagSeeds: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getBagSeeds'),
        getDiamondBalance: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getDiamondBalance'),
        useItem: (accountRef: string, itemId: number, count: number, uid = 0) => callWorkerApi(resolveAccountRefId(accountRef), 'useItem', itemId, count, uid),
        sellItems: (accountRef: string, items: any[]) => callWorkerApi(resolveAccountRefId(accountRef), 'sellItems', items),
        setItemsLocked: (accountRef: string, itemUids: unknown, locked: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'setItemsLocked', itemUids, locked)
        ),
        getDogSkillGiftStatus: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getDogSkillGiftStatus')
        ),
        claimDogSkillGifts: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'claimDogSkillGifts')
        ),
        getPetInfo: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getPetInfo')
        ),
        deployDog: (accountRef: string, dogId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'deployDog', dogId)
        ),
        withdrawDog: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'withdrawDog')
        ),
        useDogFood: (accountRef: string, itemId: unknown, count: unknown = 1, uid: unknown = 0) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useDogFood', itemId, count, uid)
        ),
        getPetProtectLogs: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getPetProtectLogs')
        ),
        getDailyGifts: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getDailyGiftOverview'),
        getActivityCenterSnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getActivityCenterSnapshot'),
        getCurrentSeasonEvent: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSeasonEvent'),
        getCurrentStarSandShop: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentStarSandShop'),
        getCurrentSolarTerms: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSolarTerms'),
        getCurrentQixiActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentQixiActivity'),
        claimBattlePassRewards: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimBattlePassRewards'),
        exchangeStarSandGoods: (accountRef: string, goodsId: unknown, count: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'exchangeStarSandGoods', goodsId, count)
        ),
        lightConstellation: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'lightConstellation'),
        claimSolarTerm: (accountRef: string, termId: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimSolarTerm', termId),
        getCurrentQingMeiActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentQingMeiActivity'),
        claimQingMeiDailySeed: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimQingMeiDailySeed'),
        startQingMeiBrew: (accountRef: string, ingredients: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'startQingMeiBrew', ingredients),
        continueQingMeiBrew: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'continueQingMeiBrew'),
        settleQingMeiBrew: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'settleQingMeiBrew'),
        claimQixiBridgeRewards: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimQixiBridgeRewards'),
        giftQixiSachet: (accountRef: string, friendGid: unknown, messageTextId: unknown = 15) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'giftQixiSachet', friendGid, messageTextId)
        ),
        getMallCatalog: (accountRef: string, slotType: unknown, subSlotType: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getMallCatalog', slotType, subSlotType)
        ),
        purchaseMallProduct: (accountRef: string, goodsId: unknown, count: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'purchaseMallProduct', goodsId, count)
        ),
        getMysteryShop: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getMysteryShop'),
        purchaseMysteryOffer: (accountRef: string, npcId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'purchaseMysteryOffer', npcId)
        ),
        getSeeds: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getSeeds'),

        setAutomation: async (accountRef: string, key: string, value: any) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            store.setAutomation(key, value, accountId);
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(accountId);
            return { automation: store.getAutomation(accountId), configRevision: rev };
        },

        doFarmOp: (accountRef: string, opType: string) => callWorkerApi(resolveAccountRefId(accountRef), 'doFarmOp', opType),

        doAnalytics: (accountRef: string, sortBy: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getAnalytics', sortBy),
        buyFertilizer: (accountRef: string, type: string, count: number) => callWorkerApi(resolveAccountRefId(accountRef), 'buyFertilizer', type, count),
        checkAndBuyFertilizer: (accountRef: string, options: any) => callWorkerApi(resolveAccountRefId(accountRef), 'checkAndBuyFertilizer', options),
        saveSettings: async (accountRef: string, payload: any) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            const body = (payload && typeof payload === 'object') ? payload : {};
            const snapshot: Record<string, any> = {};
            const copyIfPresent = (sourceKey: string, targetKey: string = sourceKey): void => {
                if (Object.prototype.hasOwnProperty.call(body, sourceKey)) {
                    snapshot[targetKey] = body[sourceKey];
                }
            };

            copyIfPresent('plantingStrategy');
            if (!Object.prototype.hasOwnProperty.call(snapshot, 'plantingStrategy')) copyIfPresent('strategy', 'plantingStrategy');
            copyIfPresent('preferredSeedId');
            if (!Object.prototype.hasOwnProperty.call(snapshot, 'preferredSeedId')) copyIfPresent('seedId', 'preferredSeedId');
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
                'bagSeedFallbackStrategy',
            ]) {
                copyIfPresent(key);
            }

            // One apply performs the only persistence for this save request.
            store.applyConfigSnapshot(snapshot, { accountId });
            const rev = nextConfigRevision();
            const config = buildConfigSnapshotForAccount(accountId);
            const { ui: _ui, ...savedConfig } = store.getConfigSnapshot(accountId);
            const result: Record<string, any> = {
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
                    const error: any = new Error(`Worker applied revision ${appliedRevision || 0}, expected at least ${rev}`);
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
            } catch (e: any) {
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

        setUITheme: async (theme: string) => {
            const snapshot = store.setUITheme(theme);
            return { ui: snapshot.ui || store.getUI() };
        },

        broadcastConfig: (accountId: string) => {
            broadcastConfigToWorkers(accountId);
        },

        broadcastGameConfigReload: () => {
            if (typeof broadcastGameConfigReloadOpt === 'function') broadcastGameConfigReloadOpt();
        },

        setRuntimeAccountName: (accountRef: string, accountName: string) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) return;
            const worker = workers[accountId];
            if (worker) {
                worker.name = String(accountName || worker.name || accountId);
            }
        },

        getAccounts: () => {
            const data = getAccounts();
            data.accounts.forEach((a: any) => {
                const worker = workers[a.id];
                a.running = !!worker;
                if (worker && worker.status && worker.status.status && worker.status.status.name) {
                    a.nick = worker.status.status.name;
                }
                if (worker && worker.status && worker.status.status && worker.status.status.avatarUrl) {
                    a.avatar = worker.status.status.avatarUrl;
                }
            });
            return data;
        },

        startAccount: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            startWorker(acc);
            return true;
        },

        stopAccount: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            if (accountId) stopWorker(accountId);
            return true;
        },

        restartAccount: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            restartWorker(acc);
            return true;
        },

        isAccountRunning: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            return !!(accountId && workers[accountId]);
        },

        getSchedulerStatus: async (accountRef: string) => {
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
            } catch (e: any) {
                workerError = (e && e.message) ? e.message : String(e || 'unknown');
            }
            return { accountId, runtime, worker, workerError };
        },
    };
}

module.exports = {
    createDataProvider,
};
