export {};

const {
    getItemById,
    getItemImageById,
    getPlantBySeedId,
    getPlantByFruitId,
    getPlantNameBySeedId,
    getIllustratedTypeByParam,
    getIllustratedSortByParam,
    getIllustratedBuffsByLevel,
    getIllustratedBuffs,
    getAllSeeds,
} = require('../config/gameConfig');
const { getAvailableSeeds } = require('./farm');
const protobuf = require('protobufjs');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum } = require('../utils/utils');

const SERVICE = 'gamepb.illustratedpb.IllustratedService';

function getMutantGroup(seedId: number): 'gold' | 'decoration' | 'activity' {
    const type = getIllustratedTypeByParam(seedId);
    if (type === '装扮果实') return 'decoration';
    if (type === '活动果实') return 'activity';
    return 'gold';
}

function rewardDto(input: any): any | null {
    const itemId = toNum(input && (input.item_id ?? input.id));
    const count = Math.max(0, toNum(input && input.count));
    if (!itemId) return null;
    const item = getItemById(itemId);
    return {
        itemId,
        count,
        name: String(item && item.name || `物品${itemId}`),
        image: getItemImageById(itemId),
    };
}

function attributeDto(input: any): any | null {
    const type = toNum(input && input.type);
    const param = toNum(input && input.param);
    const value = toNum(input && (input.value ?? input.param));
    if (!type && !value) return null;
    return { type, param, value };
}

function itemDto(input: any): any {
    const seedId = toNum(input && input.fruit_id);
    const plant = getPlantBySeedId(seedId);
    const item = getItemById(seedId);
    const name = String(item && item.name || plant && plant.name || getPlantNameBySeedId(seedId));
    return {
        seedId,
        fruitId: toNum(input && input.fruit_id),
        name,
        image: getItemImageById(seedId),
        rewardCategory: toNum(input && input.rarity),
        group: getMutantGroup(seedId),
        sort: getIllustratedSortByParam(seedId),
        cropCategory: toNum(input && input.layer),
        unlocked: input && input.unlocked === true,
        progress: Math.max(0, toNum(input && input.progress)),
        isNew: input && input.is_new === true,
        reward: rewardDto(input && input.reward?.[0]),
        attributes: (Array.isArray(input && input.attributes) ? input.attributes : [])
            .map(attributeDto)
            .filter(Boolean),
    };
}

async function getIllustratedList(type: number): Promise<any> {
    // The game client writes rarity=0 explicitly (field 1 = 0). protobufjs
    // omits proto3 defaults, so keep the request wire shape identical to capture.
    const writer = protobuf.Writer.create();
    writer.uint32(8).int32(0);
    writer.uint32(16).int32(type);
    const body = writer.finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'GetIllustratedListV2', body);
    return types.GetIllustratedListV2Reply.decode(replyBody);
}

async function getIllustratedLevels(type: number): Promise<any> {
    const body = types.GetIllustratedLevelListV2Request.encode(types.GetIllustratedLevelListV2Request.create({ type })).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'GetIllustratedLevelListV2', body);
    return types.GetIllustratedLevelListV2Reply.decode(replyBody);
}

function normalizeBook(type: number, listReply: any, levelReply: any): any {
    const levels = (Array.isArray(levelReply && levelReply.level_list) ? levelReply.level_list : []).map((entry: any) => ({
        level: toNum(entry && entry.level),
        progress: Math.max(0, toNum(entry && entry.point_condition)),
        claimed: entry && entry.claimed === true,
        canClaim: entry && entry.can_claim === true && entry.claimed !== true,
        rewards: (Array.isArray(entry && entry.rewards) ? entry.rewards : []).map(rewardDto).filter(Boolean),
    }));
    const currentLevel = Math.max(toNum(listReply && listReply.current_level), toNum(levelReply && levelReply.current_level));
    const currentProgress = Math.max(toNum(listReply && listReply.total_progress), toNum(levelReply && levelReply.total_progress));
    const configuredNext = toNum(listReply && listReply.next_level_progress);
    const nextLevel = levels.find((entry: any) => entry.level > currentLevel);

    return {
        type,
        level: currentLevel,
        progress: currentProgress,
        nextLevelProgress: configuredNext || Math.max(0, toNum(nextLevel && nextLevel.progress)),
        claimable: levels.some((entry: any) => entry.canClaim),
        rewards: (listReply.total_rewards || []).map(rewardDto).filter(Boolean),
        buffs: type === 2 ? getIllustratedBuffs() : [],
        currentBuffs: type === 2 ? getIllustratedBuffsByLevel(currentLevel) : [],
        items: (Array.isArray(listReply && listReply.list) ? listReply.list : [])
            .map(itemDto)
            .sort((a: any, b: any) => Number(a.sort || 0) - Number(b.sort || 0)),
        levels,
    };
}

let pendingSnapshot: Promise<any> | null = null;

async function buildIllustratedSnapshot(): Promise<any> {
    // 按官方客户端顺序串行请求：normal 优先级只有 2 个并发槽，一次性并发 4 个请求
    // 会把自己的请求挤进队列并触发网关压力告警。
    const cropList = await getIllustratedList(1);
    const cropLevels = await getIllustratedLevels(1);
    const mutantList = await getIllustratedList(2);
    const mutantLevels = await getIllustratedLevels(2);
    const crop = normalizeBook(1, cropList, cropLevels);
    const seeds = await getAvailableSeeds();
    const seedById = new Map(seeds.map((seed: any) => [toNum(seed.seedId), seed]));
    const localSeeds = new Map(getAllSeeds().map((seed: any) => [toNum(seed.seedId), seed]));
    crop.items = crop.items.map((item: any) => {
        const itemId = toNum(item.seedId);
        const plant = getPlantBySeedId(itemId) || getPlantByFruitId(itemId);
        const seedId = toNum(plant && plant.seed_id) || itemId;
        const shopSeed: any = seedById.get(seedId);
        const localSeed: any = localSeeds.get(seedId);
        return { ...item, seedId, shopSeed: shopSeed || (localSeed ? { ...localSeed, goodsId: 0, price: null, unknownMeta: true, requiresUnlockCard: false } : null) };
    });
    return {
        crop,
        mutant: normalizeBook(2, mutantList, mutantLevels),
        updatedAt: Date.now(),
    };
}

// 面板重复打开或多个请求并发时合并为同一轮读取，避免重复发起 4 个 RPC。
function getIllustratedSnapshot(): Promise<any> {
    if (pendingSnapshot) return pendingSnapshot;
    const request = buildIllustratedSnapshot();
    pendingSnapshot = request;
    request.finally(() => {
        if (pendingSnapshot === request) pendingSnapshot = null;
    }).catch(() => {});
    return request;
}

let claimTail: Promise<any> = Promise.resolve();
function claimIllustratedRewards(type: number) {
    const request = claimTail.then(async () => {
        if (type !== 1 && type !== 2) throw new Error('图鉴类型无效');
        const levels = await getIllustratedLevels(type);
        if (!(levels.level_list || []).some((v: any) => v.can_claim && !v.claimed)) throw new Error('暂无可领取奖励');
        const body = types.ClaimAllRewardsV2Request.encode({ type }).finish();
        const reply = await sendMsgAsync(SERVICE, 'ClaimAllRewardsV2', body);
        const decoded = types.ClaimAllRewardsV2Reply.decode(reply.body);
        if (!decoded.claimed_level_ids?.length) throw new Error('领取结果未确认，请刷新图鉴后查看');
        const result = { rewards: (decoded.total_rewards || []).map(rewardDto).filter(Boolean), claimedLevels: decoded.claimed_level_ids };
        if (pendingSnapshot) await pendingSnapshot.catch(() => {});
        try { return { ...result, snapshot: await getIllustratedSnapshot() }; }
        catch { return { ...result, snapshot: null, refreshRequired: true }; }
    });
    claimTail = request.catch(() => {});
    return request;
}

async function clearIllustratedNew(fruitIds: number[]): Promise<{ cleared: number[] }> {
    const ids: number[] = (Array.isArray(fruitIds) ? fruitIds : []).map((id: any) => toNum(id)).filter((id: number) => id > 0);
    if (!ids.length) return { cleared: [] };
    const body = types.ClearNewUnlockedFruitsV2Request.encode(types.ClearNewUnlockedFruitsV2Request.create({
        fruit_ids: ids.map((id: number) => toLong(id)),
        scope: 1,
    })).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'ClearNewUnlockedFruitsV2', body);
    return { cleared: (types.ClearNewUnlockedFruitsV2Reply.decode(replyBody).cleared_fruit_ids || []).map((id: any) => toNum(id)) };
}

module.exports = {
    getIllustratedSnapshot,
    claimIllustratedRewards,
    clearIllustratedNew,
};
