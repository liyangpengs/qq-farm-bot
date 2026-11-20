export {};
const { findAccountByRef, normalizeAccountRef, resolveAccountId: resolveAccountIdByList } = require('../services/account-resolver');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { getAccountRuntimeState, setAccountRuntimeState } = require('../services/account-runtime-state');

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
    /**
     * 撤销账号「掉线后等待重登」的定时器，由 runtime-engine 注入
     * （`wx-keepalive.cancelPendingRelogin`）。用注入而不是在这里 require，
     * 是为了让 data-provider 不反向依赖保活模块——保活模块顶层会加载凭证服务，
     * 测试里靠 Module._load 注入假实现，多一条静态依赖就会提前把真模块钉进缓存。
     */
    cancelPendingRelogin?: (accountId: string) => void;
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
        cancelPendingRelogin,
    } = options;

    /**
     * 用户手动「停止」/「启动」/「重启」都是明确的人工意图，必须让自动重登让位：
     * 等待期内账号没有子进程，`stopWorker` 停不掉这条定时器，到点会把它重新拉起，
     * 用户看到的就是「点了停止却自己启动了」。
     */
    function cancelPendingReloginSafe(accountId: string): void {
        if (!accountId || typeof cancelPendingRelogin !== 'function') return;
        try {
            cancelPendingRelogin(accountId);
        }
        catch {
            // 撤销失败不能影响停止 / 启动流程本身
        }
    }

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

        getLands: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getLands', true),
        getIllustratedSnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getIllustratedSnapshot'),
        getCollectionsSnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCollectionsSnapshot'),
        operateCollections: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateCollections', action, input),
        getRanchState: (accountRef: string, view: string, shopId?: number, hostGid?: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getRanchState', view, shopId, hostGid),
        prepareRanchAction: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'prepareRanchAction', action, input),
        operateRanch: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateRanch', action, input),
        claimIllustratedRewards: (accountRef: string, type: number) => callWorkerApi(resolveAccountRefId(accountRef), 'claimIllustratedRewards', type),
        clearIllustratedNew: (accountRef: string, fruitIds: number[]) => callWorkerApi(resolveAccountRefId(accountRef), 'clearIllustratedNew', fruitIds),
        getSolarCalendar: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getSolarCalendar'),
        operateSolarCalendar: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateSolarCalendar', action, input),
        getFriends: (accountRef: string, forceSync = false) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriends', forceSync, true),
        getFriendsCache: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendsCache'),
        clearFriendsCache: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'clearFriendsCache'),
        getInteractRecords: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getInteractRecords'),
        getFriendLands: (accountRef: string, gid: number) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendLands', gid, true),
        getFriendInteractionItems: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getFriendInteractionItems', true)
        ),
        useFriendInteractionItemBatch: (accountRef: string, gid: unknown, itemId: unknown, landIds: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useFriendInteractionItemBatch', gid, itemId, landIds, true)
        ),
        useFriendFarmInteractionItem: (accountRef: string, gid: unknown, itemId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useFriendFarmInteractionItem', gid, itemId, true)
        ),
        getSelfInteractionItems: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getSelfInteractionItems', true)
        ),
        useSelfInteractionItemBatch: (accountRef: string, itemId: unknown, landIds: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useSelfInteractionItemBatch', itemId, landIds, true)
        ),
        doFriendOp: (accountRef: string, gid: number, opType: string) => callWorkerApi(resolveAccountRefId(accountRef), 'doFriendOp', gid, opType, true),
        delFriend: (accountRef: string, gid: number) => callWorkerApi(resolveAccountRefId(accountRef), 'delFriend', gid),
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
        activateDog: (accountRef: string, dogId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'activateDog', dogId)
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
        getDailyGifts: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getDailyGiftOverview', true),
        getActivityDirectorySnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getActivityDirectorySnapshot'),
        getRanchActivityDirectorySnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getRanchActivityDirectorySnapshot'),
        getActivityCenterSnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getActivityCenterSnapshot'),
        getCurrentSeasonEvent: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSeasonEvent'),
        getCurrentStellarActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentStellarActivity'),
        getCurrentStarSandShop: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentStarSandShop'),
        getCurrentSolarTerms: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSolarTerms'),
        getCurrentQixiActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentQixiActivity'),
        getCurrentCharityRedFlowerActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentCharityRedFlowerActivity'),
        getPetDiary: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getPetDiary'),
        operatePetDiary: (accountRef: string, action: unknown, params: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'operatePetDiary', action, params),
        getPetDiaryRecords: (accountRef: string, kind: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'getPetDiaryRecords', kind),
        getPetDiaryFriend: (accountRef: string, gid: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'getPetDiaryFriend', gid),
        claimCharityRedFlowerSeeds: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityRedFlowerSeeds'),
        donateCharityRedFlowerLove: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'donateCharityRedFlowerLove'),
        claimCharityRedFlowerDailyGift: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityRedFlowerDailyGift'),
        claimCharityRedFlowerProgressReward: (accountRef: string, target: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityRedFlowerProgressReward', target),
        getCurrentWeatherActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentWeatherActivity'),
        buyWeatherBottle: (accountRef: string, count: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'buyWeatherBottle', count),
        collectWeatherBottle: (accountRef: string, targetGid: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'collectWeatherBottle', targetGid),
        lightWeatherResearch: (accountRef: string, nodeId: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'lightWeatherResearch', nodeId),
        summonWeatherRain: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'summonWeatherRain'),
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
        exchangeWeatherCollectorBottle: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'exchangeWeatherCollectorBottle')
        ),
        getWeatherFriends: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getWeatherFriends')
        ),
        scanWeatherFriends: (accountRef: string, friendGids: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'scanWeatherFriends', friendGids)
        ),
        useWeatherCollectorBottle: (accountRef: string, friendGid: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherCollectorBottle', friendGid)
        ),
        useWeatherSummonBottle: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherSummonBottle')
        ),
        useWeatherFrogBottle: (accountRef: string, friendGid: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherFrogBottle', friendGid)
        ),
        useWeatherCloudBottle: (accountRef: string, friendGid: unknown, landId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherCloudBottle', friendGid, landId)
        ),
        advanceWeatherResearch: (accountRef: string, nodeId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'advanceWeatherResearch', nodeId)
        ),
        getMugeActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getMugeActivity'),
        operateMugeActivity: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateMugeActivity', action, input),
        getMilkTeaActivity: (accountRef: string, page: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'getMilkTeaActivity', page, input),
        operateMilkTeaActivity: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateMilkTeaActivity', action, input),
        getShareRewardActivity: (accountRef: string, activityId: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getShareRewardActivity', activityId),
        operateShareRewardActivity: (accountRef: string, activityId: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateShareRewardActivity', activityId, action, input),
        getAutumnActivity: (accountRef: string, key: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getAutumnActivity', key),
        operateAutumnActivity: (accountRef: string, key: string, action: string, input: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'operateAutumnActivity', key, action, input),
        getPropsShop: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getPropsShop'),
        purchaseProps: (accountRef: string, goodsId: unknown, count: unknown, expectedOffer: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'purchaseProps', goodsId, count, expectedOffer)
        ),
        getMallCatalog: (accountRef: string, slotType: unknown, subSlotType: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getMallCatalog', slotType, subSlotType)
        ),
        purchaseMallProduct: (accountRef: string, goodsId: unknown, count: unknown, slotType: unknown, expectedPrice?: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'purchaseMallProduct', goodsId, count, slotType, expectedPrice)
        ),
        getMysteryShop: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getMysteryShop'),
        purchaseMysteryOffer: (accountRef: string, npcId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'purchaseMysteryOffer', npcId)
        ),
        getSeeds: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getSeeds', true),
        purchaseSeed: (accountRef: string, goodsId: unknown, count: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'purchaseSeed', goodsId, count),

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

        doFarmOp: (accountRef: string, opType: string, targetLandId: unknown = null) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'doFarmOp', opType, targetLandId, true)
        ),
        fertilizeOwnLand: (accountRef: string, landId: unknown, fertilizerType: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'fertilizeOwnLand', landId, fertilizerType)
        ),
        fertilizeAllOwnLands: (accountRef: string, fertilizerType: unknown, landIds?: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'fertilizeAllOwnLands', fertilizerType, landIds)
        ),

        doAnalytics: (accountRef: string, sortBy: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getAnalytics', sortBy),
        buyFertilizer: (accountRef: string, type: string, count: number) => callWorkerApi(resolveAccountRefId(accountRef), 'buyFertilizer', type, count, true),
        checkAndBuyFertilizer: (accountRef: string, options: any) => callWorkerApi(resolveAccountRefId(accountRef), 'checkAndBuyFertilizer', options, true),
        saveSettings: async (accountRef: string, payload: any) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            const body = (payload && typeof payload === 'object') ? payload : {};
            const snapshot: Record<string, any> = {};
            const copyIfPresent = (sourceKey: string, targetKey: string = sourceKey): void => {
                if (Object.hasOwn(body, sourceKey)) {
                    snapshot[targetKey] = body[sourceKey];
                }
            };

            copyIfPresent('plantingStrategy');
            if (!Object.hasOwn(snapshot, 'plantingStrategy')) copyIfPresent('strategy', 'plantingStrategy');
            copyIfPresent('preferredSeedId');
            if (!Object.hasOwn(snapshot, 'preferredSeedId')) copyIfPresent('seedId', 'preferredSeedId');
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
                'emailClaimHour',
                'bagSeedPriority',
                'bagSeedMultiLandReservationEnabled',
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
                // 账号维度的真实状态：登录中 / 等待重登（带倒计时）/ 运行中 / 已掉线 /
                // 停止中 / 已停止。账本里没有记录时（本次进程还没碰过这个账号）按
                // 有无子进程回落到「运行中 / 已停止」，与旧版字段语义保持一致。
                const runtime = getAccountRuntimeState(a.id);
                if (runtime) {
                    a.runtimeState = runtime.state;
                    a.reloginAt = runtime.state === 'relogin_waiting' ? runtime.reloginAt : 0;
                }
                else {
                    a.runtimeState = a.running ? 'running' : 'stopped';
                    a.reloginAt = 0;
                }
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
            // 用户点了「启动」：自动重登的等待应当立即作废，改走这次人工启动。
            cancelPendingReloginSafe(String(acc.id || accountId || ''));
            startWorker(acc);
            return true;
        },

        stopAccount: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            if (accountId) {
                // 用户主动停止 = 明确不想再自动拉起。等待重登阶段账号本身没有子进程，
                // 只靠 stopWorker 停不掉那条定时器，到点会把它重新启动。
                cancelPendingReloginSafe(accountId);
                const hadWorker = !!workers[accountId];
                stopWorker(accountId);
                if (!hadWorker) {
                    // 本来就没在跑：不会有进程退出事件来收尾，直接把状态落成「已停止」。
                    setAccountRuntimeState(accountId, 'stopped');
                }
            }
            return true;
        },

        restartAccount: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            // 手动重启要走确定的路径，别让一条还没到点的自动重登定时器在背后
            // 再来一次「换码 + 重启」，把刚起来的连接又打断。
            cancelPendingReloginSafe(accountId);
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
