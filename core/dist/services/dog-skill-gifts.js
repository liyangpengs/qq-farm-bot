"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { getItemById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, logWarn, toNum } = require('../utils/utils');
const DOG_SKILL_GIFT_ITEM_ID = 101351;
let pendingClaim = null;
async function getDogInfo() {
    const body = types.GetDogInfoRequest.encode(types.GetDogInfoRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.dogpb.DogService', 'GetDogInfo', body);
    return types.GetDogInfoReply.decode(replyBody);
}
async function claimSkillGifts() {
    const body = types.ClaimSkillGiftsRequest.encode(types.ClaimSkillGiftsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.dogpb.DogService', 'ClaimSkillGifts', body);
    return types.ClaimSkillGiftsReply.decode(replyBody);
}
function getPendingGiftCount(reply) {
    return Math.max(0, toNum(reply?.pending_gift_count ?? reply?.pendingGiftCount));
}
function getFarmingSkillGiftCount(reply) {
    const results = Array.isArray(reply?.results) ? reply.results : [];
    return results.reduce((total, result) => {
        const reward = result?.reward;
        return toNum(reward?.id) === DOG_SKILL_GIFT_ITEM_ID
            ? total + Math.max(0, toNum(reward?.count))
            : total;
    }, 0);
}
async function checkAndClaimDogSkillGifts(pendingCountHint) {
    if (pendingClaim)
        return pendingClaim;
    const request = (async () => {
        try {
            const hintedCount = toNum(pendingCountHint);
            const pendingCount = hintedCount > 0
                ? hintedCount
                : getPendingGiftCount(await getDogInfo());
            if (pendingCount <= 0) {
                return { claimed: 0, pending: 0, item: null };
            }
            const reply = await claimSkillGifts();
            const item = reply?.item || null;
            const itemId = toNum(item?.id);
            const itemCount = Math.max(0, toNum(item?.count));
            const claimedCount = Math.max(0, toNum(reply?.claimed_count ?? reply?.claimedCount)) || itemCount;
            const itemInfo = itemId > 0 ? getItemById(itemId) : null;
            const itemName = String(itemInfo?.name || (itemId > 0 ? `物品#${itemId}` : '宠物礼包'));
            if (claimedCount > 0) {
                log('宠物', `拾取${itemName} x${claimedCount}`, {
                    module: 'dog',
                    event: '领取同气连枝礼包',
                    result: 'ok',
                    itemId,
                    count: claimedCount,
                });
            }
            return { claimed: claimedCount, pending: Math.max(0, pendingCount - claimedCount), item };
        }
        catch (error) {
            logWarn('宠物', `拾取同气连枝礼包失败: ${error?.message || error}`, {
                module: 'dog',
                event: '领取同气连枝礼包',
                result: 'error',
            });
            return {
                claimed: 0,
                pending: Math.max(0, toNum(pendingCountHint)),
                item: null,
                error: String(error?.message || error),
            };
        }
    })();
    pendingClaim = request;
    try {
        return await request;
    }
    finally {
        if (pendingClaim === request)
            pendingClaim = null;
    }
}
module.exports = {
    DOG_SKILL_GIFT_ITEM_ID,
    getDogInfo,
    claimSkillGifts,
    getPendingGiftCount,
    getFarmingSkillGiftCount,
    checkAndClaimDogSkillGifts,
};
//# sourceMappingURL=dog-skill-gifts.js.map