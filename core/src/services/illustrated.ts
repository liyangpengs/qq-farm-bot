export {};

const {
    getItemById,
    getItemImageById,
    getPlantBySeedId,
    getPlantNameBySeedId,
    getIllustratedTypeByParam,
    getIllustratedSortByParam,
    getIllustratedBuffsByLevel,
    getIllustratedBuffs,
} = require('../config/gameConfig');
const protobuf = require('protobufjs');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');

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
    const seedId = toNum(input && input.seed_id);
    const plant = getPlantBySeedId(seedId);
    const item = getItemById(seedId);
    const name = String(item && item.name || plant && plant.name || getPlantNameBySeedId(seedId));
    return {
        seedId,
        name,
        image: getItemImageById(seedId),
        rewardCategory: toNum(input && input.reward_category),
        group: getMutantGroup(seedId),
        sort: getIllustratedSortByParam(seedId),
        cropCategory: toNum(input && input.crop_category),
        unlocked: input && input.unlocked === true,
        progress: Math.max(0, toNum(input && input.progress)),
        isNew: input && input.is_new === true,
        reward: rewardDto(input && input.reward),
        attributes: (Array.isArray(input && input.attributes) ? input.attributes : [])
            .map(attributeDto)
            .filter(Boolean),
    };
}

async function getIllustratedList(type: number): Promise<any> {
    // The game client writes refresh=false explicitly (field 1 = 0). protobufjs
    // omits proto3 defaults, so keep the request wire shape identical to capture.
    const writer = protobuf.Writer.create();
    writer.uint32(8).bool(false);
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
    const levels = (Array.isArray(levelReply && levelReply.levels) ? levelReply.levels : []).map((entry: any) => ({
        level: toNum(entry && entry.level),
        progress: Math.max(0, toNum(entry && entry.progress)),
        claimed: entry && entry.claimed === true,
        rewards: (Array.isArray(entry && entry.rewards) ? entry.rewards : []).map(rewardDto).filter(Boolean),
    }));
    const currentLevel = Math.max(toNum(listReply && listReply.level), toNum(levelReply && levelReply.level));
    const currentProgress = Math.max(toNum(listReply && listReply.progress), toNum(levelReply && levelReply.progress));
    const configuredNext = toNum(listReply && listReply.next_level_progress);
    const nextLevel = levels.find((entry: any) => entry.level > currentLevel);

    return {
        type,
        level: currentLevel,
        progress: currentProgress,
        nextLevelProgress: configuredNext || Math.max(0, toNum(nextLevel && nextLevel.progress)),
        currentBonus: rewardDto(listReply && listReply.current_bonus),
        attributeBonuses: (Array.isArray(listReply && listReply.attribute_bonuses) ? listReply.attribute_bonuses : [])
            .map(rewardDto)
            .filter(Boolean),
        buffs: type === 2 ? getIllustratedBuffs() : [],
        currentBuffs: type === 2 ? getIllustratedBuffsByLevel(Math.max(toNum(listReply && listReply.level), toNum(levelReply && levelReply.level))) : [],
        items: (Array.isArray(listReply && listReply.items) ? listReply.items : [])
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
    return {
        crop: normalizeBook(1, cropList, cropLevels),
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

module.exports = {
    getIllustratedSnapshot,
};
