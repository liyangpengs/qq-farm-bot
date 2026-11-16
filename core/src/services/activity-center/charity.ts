export {};

function createCharityActivityService(deps: any) {
    const {
        types,
        sendMsgAsync,
        GatewayError,
        getServerTimeSec,
        getSystemDateKey,
        createEmptyCharityRedFlowerState,
        loadCharityRedFlowerState,
        mergeCharityRedFlowerStates,
        persistCharityRedFlowerState,
        int64String,
        int64Number,
        compareInt64,
        bytesToText,
        itemDto,
        textContent,
        businessError,
        positiveDecimal,
        activityWindowIsActive,
        serializeMutation,
    } = deps;

    const CHARITY_RED_FLOWER_GROUP_ID = '2026090900';
    const CHARITY_RED_FLOWER_ACTIVITY_ID = '2026090901';
    const CLAIM_CHARITY_SEED_OPERATE_TYPE = 35;
    const DONATE_CHARITY_LOVE_OPERATE_TYPE = 36;
    const CLAIM_CHARITY_PROGRESS_REWARD_OPERATE_TYPE = 37;
    const CLAIM_CHARITY_DAILY_GIFT_OPERATE_TYPE = 38;
    const CHARITY_PROGRESS_ALREADY_CLAIMED_CODE = 1034087;
    const CHARITY_FLOW_HARVESTED = '2';
    const CHARITY_FLOW_DAILY_GIFT_CLAIMED = '3';
    const lastCharityRedFlowerState = new Map<string, any>();

    async function queryActivityListReply(): Promise<any> {
        const body = Buffer.from(types.ActivityListRequest.encode(types.ActivityListRequest.create({ game_scene_id: 1 })).finish());
        const { body: replyBody } = await sendMsgAsync(
            'gamepb.activitypb.ActivityService',
            'List',
            body,
        );
        return types.ActivityListReply.decode(replyBody);
    }

    function findActivityData(entries: any[], activityId: string): any | null {
        const queue = Array.isArray(entries) ? [...entries] : [];
        while (queue.length > 0) {
            const entry = queue.shift();
            if (int64String(entry?.activity?.activity_id) === activityId) return entry;
            if (Array.isArray(entry?.children)) queue.push(...entry.children);
        }
        return null;
    }

    function findActivityWindow(reply: any, activityId: string): any | null {
        const windows = Array.isArray(reply?.activity_windows) ? reply.activity_windows : [];
        return windows.find((window: any) => int64String(window?.id) === activityId)
            || windows.find((window: any) => int64String(window?.id) === CHARITY_RED_FLOWER_GROUP_ID)
            || null;
    }

    function charityActivityId(entry: any): string {
        const activityId = int64String(entry?.activity?.activity_id);
        return activityId !== '0' ? activityId : CHARITY_RED_FLOWER_ACTIVITY_ID;
    }

    function reconcileCharityProgressState(entry: any, stateValue: unknown = null) {
        const activityId = charityActivityId(entry);
        const state = mergeCharityRedFlowerStates(
            activityId,
            createEmptyCharityRedFlowerState(activityId),
            stateValue,
        );
        const donatedLove = int64String(entry?.charity_red_flower?.donated_love);
        const reachedTargets = (Array.isArray(entry?.charity_red_flower?.progress_rewards)
            ? entry.charity_red_flower.progress_rewards
            : [])
            .filter((reward: any) => (
                int64String(reward?.status) === '1'
                && compareInt64(donatedLove, reward?.target) >= 0
            ))
            .map((reward: any) => int64String(reward?.target))
            .filter((target: string) => target !== '0');
    
        const claimed = new Set<string>(state.claimedProgressTargets);
        const pending = new Set<string>(state.pendingProgressTargets);
        if (!state.initialized) {
            // The activity snapshot only reports whether a milestone is unlocked:
            // a successful claim leaves status=1 unchanged. For pre-upgrade state,
            // use the normal sequential claim order to recover the historical prefix.
            reachedTargets.slice(0, -1).forEach((target: string) => claimed.add(target));
            reachedTargets.slice(-1).forEach((target: string) => pending.add(target));
        } else {
            reachedTargets.forEach((target: string) => {
                if (!claimed.has(target) && !pending.has(target)) pending.add(target);
            });
        }
        claimed.forEach(target => pending.delete(target));
        return mergeCharityRedFlowerStates(activityId, {
            activityId,
            initialized: true,
            claimedProgressTargets: Array.from(claimed),
            pendingProgressTargets: Array.from(pending),
        });
    }

    function resolveCharityProgressState(entry: any) {
        const activityId = charityActivityId(entry);
        const stored = loadCharityRedFlowerState(activityId);
        const reconciled = reconcileCharityProgressState(
            entry,
            mergeCharityRedFlowerStates(activityId, stored, lastCharityRedFlowerState.get(activityId)),
        );
        lastCharityRedFlowerState.set(activityId, reconciled);
        try {
            lastCharityRedFlowerState.set(activityId, persistCharityRedFlowerState(reconciled, activityId));
        } catch {}
        return reconciled;
    }

    function rememberClaimedCharityProgressTarget(target: string) {
        const activityId = CHARITY_RED_FLOWER_ACTIVITY_ID;
        const current = mergeCharityRedFlowerStates(
            activityId,
            loadCharityRedFlowerState(activityId),
            lastCharityRedFlowerState.get(activityId),
        );
        const next = mergeCharityRedFlowerStates(activityId, current, {
            activityId,
            initialized: true,
            claimedProgressTargets: [target],
            pendingProgressTargets: [],
        });
        lastCharityRedFlowerState.set(activityId, next);
        try {
            lastCharityRedFlowerState.set(activityId, persistCharityRedFlowerState(next, activityId));
        } catch {}
    }

    function charityRedFlowerDto(entry: any, progressStateValue: unknown = null, activityWindow: any = null) {
        const activity = entry?.activity || {};
        const state = entry?.charity_red_flower;
        if (!state) throw businessError('CHARITY_RED_FLOWER_UNAVAILABLE', '服务端未发现公益小红花活动状态');
    
        const serverTime = getServerTimeSec();
        const activityStartTime = int64Number(activityWindow?.begin_time ?? activityWindow?.beginTime)
            || int64Number(activity?.begin_time);
        const activityEndTime = int64Number(activityWindow?.end_time ?? activityWindow?.endTime)
            || int64Number(activity?.end_time);
        const stateEndTime = int64Number(state?.end_time);
        const endTime = stateEndTime > 0 ? stateEndTime : activityEndTime;
        const active = activityWindowIsActive({ begin_time: activityStartTime, end_time: endTime }, serverTime);
        const loveBalance = int64String(state?.love_balance);
        const donatedLove = int64String(state?.donated_love);
        const globalDonatedLove = int64String(state?.global_donated_love);
        const globalTargetLove = int64String(state?.global_target_love);
        const seedRewardStatus = int64String(state?.seed_reward_status);
        const publicFundStatus = int64String(state?.public_fund?.status);
        const publicFundDate = int64String(state?.public_fund?.date);
        const flowStatus = int64String(state?.flow_status);
        const currentDateKey = getSystemDateKey().replace(/-/g, '');
        // public_fund is a historical record and may still contain yesterday's
        // order after the daily reset. Only today's record means today's gift was
        // claimed.
        const dailyGiftClaimed = flowStatus === CHARITY_FLOW_DAILY_GIFT_CLAIMED
            || (publicFundDate !== '0' && publicFundDate === currentDateKey);
        const dailyGiftHarvestedToday = flowStatus === CHARITY_FLOW_HARVESTED
            || flowStatus === CHARITY_FLOW_DAILY_GIFT_CLAIMED;
        const progressState = reconcileCharityProgressState(entry, progressStateValue);
        const claimedProgressTargets = new Set<string>(progressState.claimedProgressTargets);
        const pendingProgressTargets = new Set<string>(progressState.pendingProgressTargets);
        const progressRewards = (Array.isArray(state?.progress_rewards) ? state.progress_rewards : []).map((reward: any) => {
            const target = int64String(reward?.target);
            const statusCode = int64String(reward?.status);
            const reached = compareInt64(donatedLove, target) >= 0;
            const claimed = claimedProgressTargets.has(target);
            return {
                target,
                reward: itemDto(reward?.reward),
                statusCode,
                reached,
                claimed,
                // Captures before and after a successful claim both keep status=1;
                // the local state is therefore the authoritative claim history.
                claimable: active && reached && statusCode === '1' && !claimed && pendingProgressTargets.has(target),
                claimSupported: true,
            };
        });
        const globalRewardTarget = int64String(state?.global_reward?.target) !== '0'
            ? int64String(state?.global_reward?.target)
            : globalTargetLove;
        // The settlement package requires both the personal donation threshold and
        // the server-wide target. Keep the two checks separate from the activity
        // window because the mail is issued after the activity ends.
        const settlementGlobalTarget = globalRewardTarget !== '0' ? globalRewardTarget : globalTargetLove;
        const settlementGlobalReached = settlementGlobalTarget !== '0'
            && compareInt64(globalDonatedLove, settlementGlobalTarget) >= 0;
        const settlementPersonalReached = compareInt64(donatedLove, state?.settlement_required_love) >= 0;
    
        return {
            groupId: CHARITY_RED_FLOWER_GROUP_ID,
            activityId: CHARITY_RED_FLOWER_ACTIVITY_ID,
            name: bytesToText(activity?.name) || '公益小红花',
            title: bytesToText(activity?.name) || '公益小红花',
            startTime: String(activityStartTime || 0),
            endTime: String(endTime || 0),
            serverTime: String(serverTime),
            active,
            rules: textContent(activity?.extra),
            love: itemDto({ item_id: state?.love_item_id, count: loveBalance }),
            loveBalance,
            donatedLove,
            flowStatus,
            agreementStatus: int64String(state?.agreement_status),
            seedReward: {
                statusCode: seedRewardStatus,
                claimable: active && seedRewardStatus === '2',
                claimed: seedRewardStatus === '3',
                reward: itemDto(state?.seed_reward),
            },
            dailyGift: {
                statusCode: int64String(state?.daily_reward_status),
                claimed: dailyGiftClaimed,
                harvestedToday: dailyGiftHarvestedToday,
                reward: itemDto(state?.daily_reward),
                publicFund: publicFundDate !== '0' ? {
                    date: int64String(state?.public_fund?.date),
                    statusCode: publicFundStatus,
                } : null,
            },
            progressRewards,
            globalProgress: {
                donated: globalDonatedLove,
                target: globalTargetLove,
                reached: compareInt64(globalDonatedLove, globalTargetLove) >= 0,
                rewardTarget: globalRewardTarget,
                reward: itemDto(state?.global_reward?.reward),
            },
            settlement: {
                requiredLove: int64String(state?.settlement_required_love),
                eligible: settlementGlobalReached && settlementPersonalReached,
                globalReached: settlementGlobalReached,
                personalReached: settlementPersonalReached,
                reward: itemDto(state?.settlement_reward),
            },
            actions: {
                claimSeeds: {
                    enabled: active && seedRewardStatus === '2',
                    available: active && seedRewardStatus === '2',
                    availabilityKnown: true,
                },
                donateLove: {
                    enabled: active && compareInt64(loveBalance, '0') > 0,
                    available: active && compareInt64(loveBalance, '0') > 0,
                    availabilityKnown: true,
                    count: int64Number(loveBalance),
                },
                claimDailyGift: {
                    enabled: active && dailyGiftHarvestedToday && !dailyGiftClaimed,
                    available: active && dailyGiftHarvestedToday && !dailyGiftClaimed,
                    attemptable: active && dailyGiftHarvestedToday && !dailyGiftClaimed,
                    availabilityKnown: true,
                },
            },
        };
    }

    async function getCurrentCharityRedFlowerActivity() {
        const reply = await queryActivityListReply();
        const entry = findActivityData(reply?.activities, CHARITY_RED_FLOWER_ACTIVITY_ID);
        return entry?.charity_red_flower
            ? charityRedFlowerDto(entry, resolveCharityProgressState(entry), findActivityWindow(reply, CHARITY_RED_FLOWER_ACTIVITY_ID))
            : null;
    }

    async function operateCharityRedFlower(operateType: number, selector: Record<string, unknown>) {
        const request = types.CharityRedFlowerOperateRequest.create({
            activity_id: CHARITY_RED_FLOWER_ACTIVITY_ID,
            operate_type: operateType,
            ...selector,
        });
        const body = Buffer.from(types.CharityRedFlowerOperateRequest.encode(request).finish());
        const { body: replyBody } = await sendMsgAsync(
            'gamepb.activitypb.ActivityService',
            'Operate',
            body,
        );
        const reply = types.ActivityOperateReply.decode(replyBody);
        if (int64String(reply?.activity_id) !== CHARITY_RED_FLOWER_ACTIVITY_ID) {
            throw businessError('CHARITY_RED_FLOWER_RESPONSE_INVALID', '公益小红花回包的活动 ID 不匹配');
        }
        if (int64String(reply?.operate_type) !== String(operateType)) {
            throw businessError('CHARITY_RED_FLOWER_RESPONSE_INVALID', '公益小红花回包的操作类型不匹配');
        }
        return reply;
    }

    function charitySnapshotFromOperateReply(reply: any): any | null {
        const entry = reply?.data;
        if (!entry?.charity_red_flower) return null;
        return charityRedFlowerDto(entry, resolveCharityProgressState(entry));
    }
    async function claimCharityRedFlowerSeeds() {
        return serializeMutation(async () => {
            const reply = await operateCharityRedFlower(CLAIM_CHARITY_SEED_OPERATE_TYPE, { claim_seed: {} });
            const reward = reply?.charity_seed_result?.reward;
            const rewards = reward ? [itemDto(reward)] : (Array.isArray(reply?.rewards) ? reply.rewards : []).map(itemDto);
            return {
                rewards,
                message: '小红花种子领取成功',
                snapshot: charitySnapshotFromOperateReply(reply),
            };
        });
    }

    async function donateCharityRedFlowerLove() {
        return serializeMutation(async () => {
            const reply = await operateCharityRedFlower(DONATE_CHARITY_LOVE_OPERATE_TYPE, { donate_love: {} });
            const donated = int64String(reply?.charity_donate_result?.donated);
            const donatedCount = donated !== '0'
                ? donated
                : int64String(reply?.charity_donate_result?.count);
            return {
                donated: donatedCount,
                globalDonated: int64String(reply?.charity_donate_result?.global_donated),
                message: `已捐赠全部 ${donatedCount} 份爱心`,
                snapshot: charitySnapshotFromOperateReply(reply),
            };
        });
    }

    async function claimCharityRedFlowerDailyGift() {
        return serializeMutation(async () => {
            const reply = await operateCharityRedFlower(CLAIM_CHARITY_DAILY_GIFT_OPERATE_TYPE, { send_public_fund: {} });
            const reward = reply?.charity_public_fund_result?.reward;
            const rewards = reward ? [itemDto(reward)] : (Array.isArray(reply?.rewards) ? reply.rewards : []).map(itemDto);
            return {
                rewards,
                publicFund: {
                    statusCode: int64String(reply?.charity_public_fund_result?.status),
                },
                message: '今日公益礼包领取成功',
                snapshot: charitySnapshotFromOperateReply(reply),
            };
        });
    }

    async function claimCharityRedFlowerProgressReward(input: unknown) {
        return serializeMutation(async () => {
            const target = positiveDecimal(input, 'INVALID_CHARITY_PROGRESS_TARGET', 'target');
            let reply: any = null;
            let alreadyClaimed = false;
            try {
                reply = await operateCharityRedFlower(
                    CLAIM_CHARITY_PROGRESS_REWARD_OPERATE_TYPE,
                    { claim_progress_reward: { target } },
                );
            } catch (error: any) {
                if (!(error instanceof GatewayError) || error.code !== CHARITY_PROGRESS_ALREADY_CLAIMED_CODE) {
                    throw error;
                }
                alreadyClaimed = true;
            }
            rememberClaimedCharityProgressTarget(target);
            const result = reply?.charity_progress_reward_result;
            const reward = result?.reward;
            const rewards = reward
                ? [itemDto(reward)]
                : (Array.isArray(reply?.rewards) ? reply.rewards : []).map(itemDto);
            return {
                target,
                rewards,
                claimed: true,
                alreadyClaimed,
                message: alreadyClaimed
                    ? `公益进度奖励已领取（${target} 份爱心）`
                    : `公益进度奖励领取成功（${target} 份爱心）`,
                snapshot: reply ? charitySnapshotFromOperateReply(reply) : null,
            };
        });
    }

    return {
        getCurrentCharityRedFlowerActivity,
        claimCharityRedFlowerSeeds,
        donateCharityRedFlowerLove,
        claimCharityRedFlowerDailyGift,
        claimCharityRedFlowerProgressReward,
        charityRedFlowerDto,
        reconcileCharityProgressState,
    };
}

module.exports = { createCharityActivityService };
