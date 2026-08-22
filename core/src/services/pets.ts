export {};

/**
 * 宠物信息与狗粮使用。
 *
 * GetDogInfo、DeployDog、WithdrawDog 和 DogService.AddFood 均有真实抓包依据。
 * 守护记录 GetProtectLogs 也已由游戏页面实际点击抓包确认。
 */
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { getBag, getBagItems } = require('./warehouse');
const { getDogInfo } = require('./dog-skill-gifts');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, logWarn } = require('../utils/utils');

const MAX_PROTECT_DURATION_SECONDS: number = 30 * 24 * 60 * 60;
const PET_IDS: number[] = [90001, 90002, 90003, 90011, 90021];
const DOG_FOOD_DURATIONS: Map<number, number> = new Map([
    [90004, 24 * 60 * 60],
    [90005, 3 * 24 * 60 * 60],
    [90006, 5 * 24 * 60 * 60],
]);
const RARITY_LABELS: Record<number, string> = {
    1: '普通',
    2: '稀有',
    3: '珍品',
    4: '天工',
};
const PET_OBTAIN_CONDITIONS: Record<number, string> = {
    90001: '参与分享任务可获得',
    90002: '商店购买：100 点券',
    90003: '商店购买：200 点券',
    90011: '商店购买：200 点券',
    90021: '限时活动获得',
};
interface PetSkillDefinition {
    skillId?: number;
    name: string;
    description: string;
    triggerRate?: number;
    dailyLimit?: number;
    usedCount?: number;
    remainingCount?: number;
    source: 'game-config' | 'client-static';
}

// 实际点击技能图标时没有产生技能查询 RPC，技能文案是客户端静态数据，
// 不应虚构 DogService 协议。忠心护主概率由 ItemInfo.json 的官方描述提供；
// 同气连枝文案与用户实际打开的技能说明一致。
const PET_SKILLS: Record<number, PetSkillDefinition[]> = {
    90001: [{ name: '忠心护主', description: '作物被偷时，有10%概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 10, source: 'game-config' }],
    90002: [{ name: '忠心护主', description: '作物被偷时，有30%概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 30, source: 'game-config' }],
    90003: [{ name: '忠心护主', description: '作物被偷时，有50%概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 50, source: 'game-config' }],
    90011: [{ name: '忠心护主', description: '作物被偷时，有50%概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 50, source: 'game-config' }],
    90021: [
        { name: '忠心护主', description: '作物被偷时，有50%概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 50, source: 'game-config' },
        {
            skillId: 2001,
            name: '同气连枝',
            description: '好友前来农场互助（浇水/除草/除虫）时，有概率掉落同气连枝礼包（每日限30次），主人与好友均可获得奖励。',
            dailyLimit: 30,
            source: 'client-static',
        },
    ],
};

function getFallbackSkills(info: any): PetSkillDefinition[] {
    return [{
        name: '看护',
        description: String(info?.desc || info?.effectDesc || '暂无技能说明'),
        source: 'game-config',
    }];
}

function getPetSkillCatalog(): any {
    return {
        source: 'client-static',
        requestVerified: true,
        requestMethod: null,
        skillsByPetId: PET_SKILLS,
    };
}

let pendingFoodUse: Promise<any> | null = null;

function normalizeId(value: any): number {
    return Math.max(0, toNum(value));
}

function getProtectDuration(reply: any): number {
    const value = reply?.protect_time
        ?? reply?.protectTime;
    return Math.max(0, normalizeId(value));
}

function getMaxProtectDuration(reply: any): number {
    const value = normalizeId(reply?.max_protect_time ?? reply?.maxProtectTime);
    return value > 0 ? value : MAX_PROTECT_DURATION_SECONDS;
}

function getRawDogs(reply: any): any[] {
    return Array.isArray(reply?.dogs) ? reply.dogs : [];
}

function getRawFoods(reply: any): any[] {
    const foods = reply?.foods ?? reply?.items;
    return Array.isArray(foods) ? foods : [];
}

function getRawSkillUsages(reply: any): any[] {
    const usages = reply?.skill_usages ?? reply?.skillUsages;
    return Array.isArray(usages) ? usages : [];
}

function getPetSkills(id: number, info: any, skillUsages: any[]): PetSkillDefinition[] {
    const definitions = PET_SKILLS[id] || getFallbackSkills(info);
    return definitions.map((definition: PetSkillDefinition) => {
        if (!definition.skillId) return { ...definition };
        const usage = skillUsages.find((entry: any) => (
            normalizeId(entry?.skill_id ?? entry?.skillId) === definition.skillId
            && normalizeId(entry?.dog_id ?? entry?.dogId) === id
        ));
        if (!usage) return { ...definition };

        const usedCount = Math.max(0, normalizeId(usage?.used_count ?? usage?.usedCount));
        const protocolLimit = Math.max(0, normalizeId(usage?.daily_limit ?? usage?.dailyLimit));
        const dailyLimit = protocolLimit || definition.dailyLimit || 0;
        return {
            ...definition,
            dailyLimit,
            usedCount,
            remainingCount: Math.max(0, dailyLimit - usedCount),
        };
    });
}

function getBagFoodCounts(bagReply: any): Map<number, number> {
    const counts = new Map<number, number>();
    for (const item of getBagItems(bagReply)) {
        const id = normalizeId(item?.id);
        if (!DOG_FOOD_DURATIONS.has(id)) continue;
        const count = Math.max(0, normalizeId(item?.count));
        counts.set(id, (counts.get(id) || 0) + count);
    }
    return counts;
}

function getDogDefinition(id: number, raw: any, currentDogId: number, skillUsages: any[]): any {
    const info: any = getItemById(id) || {};
    const price = normalizeId(raw?.price);
    const rarity = normalizeId(info?.rarity);
    const obtainCondition = PET_OBTAIN_CONDITIONS[id] || '游戏内活动或购买获得';
    const owned = normalizeId(raw?.owned ?? raw?.field_7) === 1 || id === currentDogId;

    const skills = getPetSkills(id, info, skillUsages);

    return {
        id,
        name: String(raw?.name || info?.name || `宠物#${id}`),
        image: getItemImageById(id),
        rarity,
        rarityLabel: RARITY_LABELS[rarity] || '未知',
        skills,
        skillDescription: skills[0]?.description || '暂无技能说明',
        obtainCondition,
        price,
        level: normalizeId(raw?.level),
        status: normalizeId(raw?.status),
        owned,
        active: id === currentDogId,
    };
}

function buildPetSnapshot(reply: any, bagReply: any): any {
    const rawDogs = getRawDogs(reply);
    const skillUsages = getRawSkillUsages(reply);
    const currentDogId = normalizeId(reply?.current_dog_id ?? reply?.currentDogId);
    const byId = new Map<number, any>(rawDogs.map((dog: any) => [normalizeId(dog?.id), dog]));
    const dogs = PET_IDS.map((id: number) => getDogDefinition(id, byId.get(id) || {}, currentDogId, skillUsages));

    // 保留服务端新增的宠物，避免客户端配置尚未更新时静默丢失数据。
    for (const raw of rawDogs) {
        const id = normalizeId(raw?.id);
        if (id > 0 && !PET_IDS.includes(id)) dogs.push(getDogDefinition(id, raw, currentDogId, skillUsages));
    }

    const bagCounts = getBagFoodCounts(bagReply);
    const rawFoodById = new Map<number, any>(getRawFoods(reply).map((food: any) => [normalizeId(food?.id), food]));
    const foods = Array.from(DOG_FOOD_DURATIONS.entries()).map(([id, fallbackDuration]) => {
        const raw = rawFoodById.get(id) || {};
        const info: any = getItemById(id) || {};
        return {
            id,
            name: String(info?.name || `狗粮#${id}`),
            image: getItemImageById(id),
            duration: Math.max(1, normalizeId(raw?.duration) || fallbackDuration),
            // GetDogInfo.items.field 3 是状态位，不是数量；背包是库存的唯一依据。
            count: Math.max(0, bagCounts.get(id) || 0),
        };
    });

    const protectDuration = getProtectDuration(reply);
    const maxProtectDuration = Math.max(getMaxProtectDuration(reply), protectDuration);
    return {
        dogs,
        foods,
        protectDuration,
        maxProtectDuration,
        remainingDuration: protectDuration,
        pendingGiftCount: Math.max(0, normalizeId(reply?.pending_gift_count ?? reply?.pendingGiftCount)),
        activeDogId: currentDogId,
        activeControlSupported: true,
        guardianRecordsSupported: true,
        skillCatalog: getPetSkillCatalog(),
    };
}

function decodeText(value: any): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    return String(value);
}

async function getProtectLogs(): Promise<any> {
    // 真实点击请求固定为 { field 1: 0, field 2: 100, field 3: 0 }。
    // 在没有新样本证明字段 1/3 语义前，不将它们猜测为分页或筛选。
    const offset = 0;
    const limit = 100;
    const body: Uint8Array = types.GetProtectLogsRequest.encode(
        types.GetProtectLogsRequest.create({ field_1: 0, count: limit, field_3: 0 }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.dogpb.DogService', 'GetProtectLogs', body);
    const reply = types.GetProtectLogsReply.decode(replyBody);
    const logs = Array.from(reply?.logs || []).map((entry: any, index: number) => {
        const timestamp = normalizeId(entry?.timestamp);
        const friendGid = normalizeId(entry?.friend_gid ?? entry?.friendGid);
        return {
            id: `${friendGid}-${timestamp}-${index}`,
            friendGid,
            friendName: decodeText(entry?.friend_name ?? entry?.friendName) || `用户#${friendGid}`,
            friendAvatar: String((entry?.friend_avatar ?? entry?.friendAvatar) || ''),
            timestamp,
            stolenCount: normalizeId(entry?.stolen_count ?? entry?.stolenCount),
            protectedGold: normalizeId(entry?.protected_gold ?? entry?.protectedGold),
            dogId: normalizeId(entry?.dog_id ?? entry?.dogId),
            dogName: String((entry?.dog_name ?? entry?.dogName) || ''),
        };
    });
    return { logs, total: Math.max(logs.length, normalizeId(reply?.total)), offset, limit };
}

async function getPetInfo(): Promise<any> {
    const reply = await getDogInfo();
    // GetDogInfo.field 5 只提供狗粮种类、时长及状态。抓包已证明 field 3
    // 不是数量，因此必须读取背包才能展示与校验真实库存。
    const bagReply = await getBag();
    return buildPetSnapshot(reply, bagReply);
}

async function deployDog(dogIdInput: any): Promise<any> {
    const dogId = normalizeId(dogIdInput);
    if (!dogId) throw new Error('缺少宠物 ID');

    const before = await getDogInfo();
    const dog = getRawDogs(before).find((entry: any) => normalizeId(entry?.id) === dogId);
    const owned = normalizeId(dog?.owned ?? dog?.field_7) === 1 || dogId === normalizeId(before?.current_dog_id ?? before?.currentDogId);
    if (!dog || !owned) throw new Error('未获得该宠物，无法上场');

    const body: Uint8Array = types.DeployDogRequest.encode(
        types.DeployDogRequest.create({ dog_id: dogId }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.dogpb.DogService', 'DeployDog', body);
    const reply = types.DeployDogReply.decode(replyBody);
    const snapshot = await getPetInfo();
    if (snapshot.activeDogId !== dogId) throw new Error('宠物上场状态未更新，请稍后重试');
    log('宠物', `上场${dog?.name || `宠物#${dogId}`}`, { module: 'dog', event: '上场宠物', result: 'ok', dogId });
    return { ...snapshot, operation: { type: 'deploy', dogId }, reply };
}

async function withdrawDog(): Promise<any> {
    const before = await getDogInfo();
    const currentDogId = normalizeId(before?.current_dog_id ?? before?.currentDogId);
    if (!currentDogId) return getPetInfo();

    const body: Uint8Array = types.WithdrawDogRequest.encode(
        types.WithdrawDogRequest.create({}),
    ).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.dogpb.DogService', 'WithdrawDog', body);
    const reply = types.WithdrawDogReply.decode(replyBody);
    const snapshot = await getPetInfo();
    if (snapshot.activeDogId) throw new Error('宠物收回状态未更新，请稍后重试');
    log('宠物', '收回当前宠物', { module: 'dog', event: '收回宠物', result: 'ok', dogId: currentDogId });
    return { ...snapshot, operation: { type: 'withdraw', dogId: currentDogId }, reply };
}

function getAvailableFoodCount(bagReply: any, itemId: number, uid: number): number {
    return getBagItems(bagReply)
        .filter((item: any) => normalizeId(item?.id) === itemId && (uid <= 0 || normalizeId(item?.uid) === uid))
        .filter((item: any) => !(item?.locked === true || item?.locked === 1 || item?.locked === '1'))
        .reduce((total: number, item: any) => total + Math.max(0, normalizeId(item?.count)), 0);
}

async function useDogFood(itemIdInput: any, countInput: any = 1, uidInput: any = 0): Promise<any> {
    const itemId = normalizeId(itemIdInput);
    const count = Math.max(1, Math.trunc(normalizeId(countInput) || 1));
    const uid = normalizeId(uidInput);
    const duration = DOG_FOOD_DURATIONS.get(itemId) || 0;
    if (!duration) throw new Error('该物品不是可用狗粮');
    if (pendingFoodUse) throw new Error('已有狗粮使用请求正在处理，请稍后再试');

    const request = (async () => {
        const before = await getDogInfo();
        const currentDuration = getProtectDuration(before);
        const requestedDuration = duration * count;
        const maxProtectDuration = getMaxProtectDuration(before);
        if (currentDuration + requestedDuration > maxProtectDuration) {
            const remaining = Math.max(0, maxProtectDuration - currentDuration);
            throw new Error(`狗粮使用后将超过 30 天上限，当前最多还可增加 ${Math.floor(remaining / 86400)} 天`);
        }

        const bagReply = await getBag();
        const available = getAvailableFoodCount(bagReply, itemId, uid);
        if (available < count) {
            throw new Error(`狗粮可用数量不足：需要 ${count}，当前 ${available}`);
        }

        // 真实抓包：DogService.AddFood({ field 1: item_id, field 2: count })；
        // 不能走背包 ItemService.Use，否则与游戏狗盆行为不一致。
        const body: Uint8Array = types.AddFoodRequest.encode(
            types.AddFoodRequest.create({ item_id: itemId, count }),
        ).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.dogpb.DogService', 'AddFood', body);
        const reply = types.AddFoodReply.decode(replyBody);
        const confirmedDuration = getProtectDuration(reply);
        if (confirmedDuration <= currentDuration) {
            throw new Error('狗粮剩余时间未更新，请稍后重试');
        }
        log('宠物', `使用${getItemById(itemId)?.name || `狗粮#${itemId}`} x${count}`, {
            module: 'dog',
            event: '使用狗粮',
            result: 'ok',
            itemId,
            count,
        });
        const latest = await getPetInfo();
        if (latest.protectDuration <= currentDuration) {
            throw new Error('狗粮已提交，但刷新后剩余时间未增加');
        }
        return { ...latest, used: { itemId, count, duration: requestedDuration }, reply };
    })();

    pendingFoodUse = request;
    try {
        return await request;
    } catch (error: any) {
        logWarn('宠物', `使用狗粮失败: ${error?.message || error}`, {
            module: 'dog',
            event: '使用狗粮',
            result: 'error',
            itemId,
            count,
        });
        throw error;
    } finally {
        if (pendingFoodUse === request) pendingFoodUse = null;
    }
}

module.exports = {
    MAX_PROTECT_DURATION_SECONDS,
    PET_IDS,
    DOG_FOOD_DURATIONS,
    getPetInfo,
    deployDog,
    withdrawDog,
    useDogFood,
    getProtectLogs,
    getPetSkillCatalog,
    buildPetSnapshot,
};
