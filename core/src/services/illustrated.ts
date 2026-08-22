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

async function getIllustratedSnapshot(): Promise<any> {
    const [cropList, cropLevels, mutantList, mutantLevels] = await Promise.all([
        getIllustratedList(1),
        getIllustratedLevels(1),
        getIllustratedList(2),
        getIllustratedLevels(2),
    ]);
    return {
        crop: normalizeBook(1, cropList, cropLevels),
        mutant: normalizeBook(2, mutantList, mutantLevels),
        updatedAt: Date.now(),
    };
}

module.exports = {
    getIllustratedSnapshot,
};
