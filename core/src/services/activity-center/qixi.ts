export {};
/**
 * 鹊桥寄情 - 鹊桥阶段领取与鹊羽香囊赠送。
 */

const { sendMsgAsync } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { getItemById, getEffectiveSellInfo } = require('../../config/gameConfig');
const { getServerTimeSec } = require('../../utils/utils');
const { getBag } = require('../warehouse');
const { getSellConditionContext } = require('../activity-windows');
const {
    int64String,
    int64Number,
    itemDto,
    bytesToText,
    textContent,
    businessError,
    positiveDecimal,
    activityWindowIsActive,
    configuredSellPrice,
    readBagBalances,
} = require('./shared');

const QIXI_GROUP_ID = '2026081800';
const QIXI_BRIDGE_ACTIVITY_ID = '2026081801';
const QIXI_GIFT_ACTIVITY_ID = '2026081802';
const QIXI_BRIDGE_OPERATE_TYPE = 25;
const QIXI_GIFT_OPERATE_TYPE = 26;
const QIXI_FEATHER_ITEM_ID = '1024';
const QIXI_SACHET_ITEM_ID = '1025';
const QIXI_RECEIVED_SACHET_ITEM_ID = '1026';
const QIXI_DEW_ITEM_ID = '301103';
const QIXI_DEFAULT_GIFT_MESSAGE_TEXT_ID = 15;

// snapshot 依赖本模块，写操作又要回传最新快照；延迟 require 打破循环依赖。
function getActivityCenterSnapshot(shopOverride: any = null) {
    return require('./snapshot').getActivityCenterSnapshot(shopOverride);
}

async function queryQixiGroupReply(): Promise<any> {
    const body = Buffer.from(types.GetGroupRequest.encode(types.GetGroupRequest.create({
        group_id: QIXI_GROUP_ID,
    })).finish());
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.activitypb.ActivityService',
        'GetGroup',
        body,
    );
    return types.GetGroupReply.decode(replyBody);
}

function findQixiChild(groupReply: any, activityId: string): any | null {
    const children = Array.isArray(groupReply?.group?.children) ? groupReply.group.children : [];
    return children.find((child: any) => int64String(child?.activity?.activity_id) === activityId) || null;
}

function qixiDto(groupReply: any, balances: Map<string, string> | null = null, sellContext: any = null) {
    const bridgeChild = findQixiChild(groupReply, QIXI_BRIDGE_ACTIVITY_ID);
    const giftChild = findQixiChild(groupReply, QIXI_GIFT_ACTIVITY_ID);
    const bridgeActivity = bridgeChild?.activity || null;
    const giftActivity = giftChild?.activity || bridgeActivity;
    if (!bridgeActivity || !giftActivity) {
        throw businessError('QIXI_UNAVAILABLE', '服务端未发现鹊桥寄情活动');
    }

    const config = bridgeChild?.qixi_bridge || {};
    const gift = giftChild?.qixi_gift || {};
    const currentStage = int64Number(config.current_stage);
    const bridgeClaimable = int64String(bridgeActivity.field_23) !== '0';
    const stages = (Array.isArray(config.stages) ? config.stages : []).map((stage: any) => {
        const stageNumber = int64Number(stage?.stage);
        const statusCode = int64String(stage?.status);
        const completed = statusCode === '2' || (currentStage > 0 && stageNumber > 0 && stageNumber <= currentStage);
        const claimable = bridgeClaimable && stageNumber === currentStage;
        return {
            id: String(stageNumber),
            stage: stageNumber,
            statusCode,
            completed,
            claimed: completed && !claimable,
            claimable,
            current: stageNumber === currentStage,
            cost: itemDto(stage?.cost),
            rewards: (Array.isArray(stage?.rewards) ? stage.rewards : []).map(itemDto),
        };
    });

    const readBalance = (itemId: string): string => balances?.get(itemId) || '0';
    const featherBalance = balances ? readBalance(QIXI_FEATHER_ITEM_ID) : null;
    const sachetBalance = balances ? readBalance(QIXI_SACHET_ITEM_ID) : null;
    const receivedSachetBalance = balances ? readBalance(QIXI_RECEIVED_SACHET_ITEM_ID) : null;
    const dewBalance = balances ? readBalance(QIXI_DEW_ITEM_ID) : null;
    const active = activityWindowIsActive(bridgeActivity);
    const rules = textContent(bridgeActivity.extra);
    const dewMetadata = getItemById(Number(QIXI_DEW_ITEM_ID));
    const dewSellInfo = getEffectiveSellInfo(dewMetadata, sellContext || undefined);
    const giftExchanges = (Array.isArray(gift.gifts) ? gift.gifts : []).map((entry: any) => ({
        costItems: (Array.isArray(entry?.cost_items) ? entry.cost_items : []).map(itemDto),
        receiveItems: (Array.isArray(entry?.receive_items) ? entry.receive_items : []).map(itemDto),
        giftType: int64String(entry?.gift_type),
        content: int64String(entry?.content),
    }));

    return {
        groupId: QIXI_GROUP_ID,
        bridgeActivityId: QIXI_BRIDGE_ACTIVITY_ID,
        giftActivityId: QIXI_GIFT_ACTIVITY_ID,
        activityId: QIXI_BRIDGE_ACTIVITY_ID,
        name: bytesToText(bridgeActivity.name) || '鹊桥寄情',
        title: bytesToText(bridgeActivity.name) || '鹊桥寄情',
        startTime: int64String(bridgeActivity.begin_time),
        endTime: int64String(bridgeActivity.end_time),
        serverTime: String(getServerTimeSec()),
        active,
        rules,
        feather: itemDto({ item_id: QIXI_FEATHER_ITEM_ID, count: featherBalance || '0' }),
        sachet: itemDto({ item_id: QIXI_SACHET_ITEM_ID, count: sachetBalance || '0' }),
        receivedSachet: itemDto({ item_id: QIXI_RECEIVED_SACHET_ITEM_ID, count: receivedSachetBalance || '0' }),
        dew: {
            ...itemDto({ item_id: QIXI_DEW_ITEM_ID, count: dewBalance || '0' }),
            balance: dewBalance,
            balanceKnown: balances !== null,
            usable: active && (balances === null || BigInt(dewBalance || '0') > 0n),
            sellable: !!dewSellInfo.sellable,
            sellStatus: String(dewSellInfo.status || 'unavailable'),
            sellCondition: String(dewSellInfo.condition || dewMetadata?.sell_cond || ''),
            sellPrice: configuredSellPrice(dewMetadata, dewSellInfo),
        },
        balances: {
            feather: featherBalance,
            sachet: sachetBalance,
            receivedSachet: receivedSachetBalance,
            dew: dewBalance,
            known: balances !== null,
        },
        bridge: {
            currentStage,
            stages,
            claimable: bridgeClaimable,
            rewardRedDot: bridgeClaimable,
            displayItems: (Array.isArray(config.display_items) ? config.display_items : []).map(itemDto),
        },
        gift: {
            sentCount: int64String(gift.total_send_count),
            sendLimit: int64String(gift.total_send_limit),
            receiveLimit: int64String(gift.total_receive_limit),
            exchanges: giftExchanges,
            messageTextId: String(QIXI_DEFAULT_GIFT_MESSAGE_TEXT_ID),
        },
        actions: {
            bridge: {
                enabled: active && bridgeClaimable,
                available: active && bridgeClaimable,
                availabilityKnown: true,
            },
            gift: {
                enabled: active && (balances === null || BigInt(sachetBalance || '0') > 0n),
                available: active && (balances === null || BigInt(sachetBalance || '0') > 0n),
                availabilityKnown: balances !== null,
            },
            dew: {
                enabled: active && (balances === null || BigInt(dewBalance || '0') > 0n),
                available: active && (balances === null || BigInt(dewBalance || '0') > 0n),
                availabilityKnown: balances !== null,
            },
        },
    };
}

async function getCurrentQixiActivity() {
    const groupReply = await queryQixiGroupReply();
    let balances: Map<string, string> | null = null;
    let sellContext: any = null;
    try {
        balances = readBagBalances(await getBag(), [QIXI_FEATHER_ITEM_ID, QIXI_SACHET_ITEM_ID, QIXI_RECEIVED_SACHET_ITEM_ID, QIXI_DEW_ITEM_ID]);
    } catch {}
    try {
        sellContext = await getSellConditionContext();
    } catch {}
    return qixiDto(groupReply, balances, sellContext);
}

async function claimQixiBridgeRewards() {
    const activity = await getCurrentQixiActivity();
    if (!activity.actions.bridge.enabled) {
        throw businessError('QIXI_BRIDGE_UNAVAILABLE', '当前没有可领取的鹊桥奖励');
    }

    const request = types.ClaimQixiBridgeRewardsRequest.create({
        activity_id: activity.bridgeActivityId,
        operate_type: QIXI_BRIDGE_OPERATE_TYPE,
        params: { step: 0 },
    });
    const body = Buffer.from(types.ClaimQixiBridgeRewardsRequest.encode(request).finish());
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.activitypb.ActivityService',
        'Operate',
        body,
    );
    const reply = types.ActivityOperateReply.decode(replyBody);
    if (int64String(reply.activity_id) !== activity.bridgeActivityId) {
        throw businessError('QIXI_RESPONSE_INVALID', '鹊桥奖励回包的活动 ID 不匹配');
    }
    if (int64String(reply.operate_type) !== String(QIXI_BRIDGE_OPERATE_TYPE)) {
        throw businessError('QIXI_RESPONSE_INVALID', '鹊桥奖励回包的操作类型不匹配');
    }
    const result = reply.qixi_bridge_result;
    const rewards = (Array.isArray(result?.awards) ? result.awards : (Array.isArray(reply.rewards) ? reply.rewards : []))
        .map(itemDto);
    const claimedStages = (Array.isArray(result?.unlocked_steps) ? result.unlocked_steps : []).map(int64String);
    return {
        claimedStages,
        rewards,
        completed: !!result?.completed,
        message: claimedStages.length > 0
            ? `已完成第 ${claimedStages.join('、')} 阶段鹊桥并领取奖励`
            : '鹊桥奖励领取成功',
        snapshot: await getActivityCenterSnapshot(),
    };
}

async function giftQixiSachet(friendGidInput: unknown, messageTextIdInput: unknown = QIXI_DEFAULT_GIFT_MESSAGE_TEXT_ID) {
    const friendGid = positiveDecimal(friendGidInput, 'INVALID_QIXI_FRIEND_GID', 'friendGid');
    const messageTextId = positiveDecimal(
        messageTextIdInput ?? QIXI_DEFAULT_GIFT_MESSAGE_TEXT_ID,
        'INVALID_QIXI_MESSAGE_TEXT_ID',
        'messageTextId',
    );

    const activity = await getCurrentQixiActivity();
    if (!activity.actions.gift.enabled) {
        throw businessError('QIXI_GIFT_UNAVAILABLE', '当前无法赠送鹊羽香囊');
    }
    if (activity.balances.known && BigInt(activity.balances.sachet || '0') < 1n) {
        throw businessError('INSUFFICIENT_QIXI_SACHET', '鹊羽香囊数量不足');
    }

    const request = types.GiftQixiSachetRequest.create({
        activity_id: activity.giftActivityId,
        operate_type: QIXI_GIFT_OPERATE_TYPE,
        params: {
            target_gid: friendGid,
            msg_text_id: messageTextId,
        },
    });
    const body = Buffer.from(types.GiftQixiSachetRequest.encode(request).finish());
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.activitypb.ActivityService',
        'Operate',
        body,
    );
    const reply = types.ActivityOperateReply.decode(replyBody);
    if (int64String(reply.activity_id) !== activity.giftActivityId) {
        throw businessError('QIXI_RESPONSE_INVALID', '鹊羽香囊回包的活动 ID 不匹配');
    }
    if (int64String(reply.operate_type) !== String(QIXI_GIFT_OPERATE_TYPE)) {
        throw businessError('QIXI_RESPONSE_INVALID', '鹊羽香囊回包的操作类型不匹配');
    }
    return {
        friendGid,
        count: 1,
        messageTextId,
        totalSendCount: int64String(reply.qixi_gift_result?.total_send_count),
        message: `已向好友 ${friendGid} 赠送 1 个鹊羽香囊`,
        snapshot: await getActivityCenterSnapshot(),
    };
}

module.exports = {
    getCurrentQixiActivity,
    claimQixiBridgeRewards,
    giftQixiSachet,
};
