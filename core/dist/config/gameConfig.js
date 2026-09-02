"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 游戏配置数据模块
 * 从 gameConfig 目录加载配置数据
 */
const fs = require('node:fs');
const path = require('node:path');
const { getResourcePath } = require('./runtime-paths');
const { isSellConditionSatisfied } = require('./sell-conditions');
// ============ 等级经验表 ============
let roleLevelConfig = null;
let levelExpTable = null;
// ============ 植物配置 ============
let plantConfig = null;
const plantMap = new Map();
const seedToPlant = new Map();
const fruitToPlant = new Map();
let itemInfoConfig = null;
const itemInfoMap = new Map();
const seedItemMap = new Map();
let landConfig = null;
const landConfigMap = new Map();
const landCoordinateMap = new Map();
let mutantEffectConfig = null;
const mutantEffectMap = new Map();
let illustratedConfig = null;
const illustratedItemMap = new Map();
let buffConfig = null;
const buffConfigMap = new Map();
// 官方活动说明确认：变异 13 为鹊羽活动效果，收获时会额外获得鹊羽。
// 运行时 MutantEffect 暂未下发 tips/description，因此在展示 DTO 层补充说明。
const MUTANT_EFFECT_DESCRIPTION_FALLBACKS = new Map([
    [13, '特殊活动变异，收获时可额外获得鹊羽。'],
]);
function getLandCoordinateKey(gridX, gridY) {
    return `${gridX},${gridY}`;
}
/**
 * 加载配置文件
 */
function loadConfigs() {
    const configDir = getResourcePath('gameConfig');
    // 加载等级经验配置
    try {
        const roleLevelPath = path.join(configDir, 'RoleLevel.json');
        if (fs.existsSync(roleLevelPath)) {
            roleLevelConfig = JSON.parse(fs.readFileSync(roleLevelPath, 'utf8'));
            levelExpTable = [];
            for (const item of roleLevelConfig) {
                levelExpTable[item.level] = item.exp;
            }
            console.warn(`[配置] 已加载等级经验表 (${roleLevelConfig.length} 级)`);
        }
    }
    catch (e) {
        console.warn('[配置] 加载 RoleLevel.json 失败:', e.message);
    }
    // 加载植物配置
    try {
        const plantPath = path.join(configDir, 'Plant.json');
        if (fs.existsSync(plantPath)) {
            plantConfig = JSON.parse(fs.readFileSync(plantPath, 'utf8'));
            plantMap.clear();
            seedToPlant.clear();
            fruitToPlant.clear();
            for (const plant of plantConfig) {
                plantMap.set(plant.id, plant);
                if (plant.seed_id) {
                    seedToPlant.set(plant.seed_id, plant);
                }
                if (plant.fruit && plant.fruit.id) {
                    fruitToPlant.set(plant.fruit.id, plant);
                }
            }
            console.warn(`[配置] 已加载植物配置 (${plantConfig.length} 种)`);
        }
    }
    catch (e) {
        console.warn('[配置] 加载 Plant.json 失败:', e.message);
    }
    // 加载物品配置（含种子/果实价格）
    try {
        const itemInfoPath = path.join(configDir, 'ItemInfo.json');
        if (fs.existsSync(itemInfoPath)) {
            itemInfoConfig = JSON.parse(fs.readFileSync(itemInfoPath, 'utf8'));
            itemInfoMap.clear();
            seedItemMap.clear();
            for (const item of itemInfoConfig) {
                // 兼容处理：ItemInfo.json 中 trait_id 字段名带尾部空格
                const raw = item;
                if ('trait_id ' in raw && !('trait_id' in raw)) {
                    raw.trait_id = raw['trait_id '];
                    delete raw['trait_id '];
                }
                const id = Number(item && item.id) || 0;
                if (id <= 0)
                    continue;
                itemInfoMap.set(id, item);
                if (Number(item.type) === 5) {
                    seedItemMap.set(id, item);
                }
            }
            console.warn(`[配置] 已加载物品配置 (${itemInfoConfig.length} 项)`);
        }
    }
    catch (e) {
        console.warn('[配置] 加载 ItemInfo.json 失败:', e.message);
    }
    // 加载土地网格配置（多格作物布局）
    try {
        const landPath = path.join(configDir, 'Land.json');
        if (fs.existsSync(landPath)) {
            landConfig = JSON.parse(fs.readFileSync(landPath, 'utf8'));
            landConfigMap.clear();
            landCoordinateMap.clear();
            for (const land of landConfig) {
                const id = Number(land && land.id) || 0;
                const gridX = Number(land && land.grid_x);
                const gridY = Number(land && land.grid_y);
                if (id <= 0 || !Number.isInteger(gridX) || !Number.isInteger(gridY))
                    continue;
                landConfigMap.set(id, land);
                landCoordinateMap.set(getLandCoordinateKey(gridX, gridY), land);
            }
            console.warn(`[配置] 已加载土地网格配置 (${landConfigMap.size} 块)`);
        }
    }
    catch (e) {
        console.warn('[配置] 加载 Land.json 失败:', e.message);
    }
    try {
        const mutantPath = path.join(configDir, 'MutantEffect.json');
        if (fs.existsSync(mutantPath)) {
            mutantEffectConfig = JSON.parse(fs.readFileSync(mutantPath, 'utf8'));
            mutantEffectMap.clear();
            for (const mutant of mutantEffectConfig || []) {
                const mutantId = Number(mutant && mutant.id) || 0;
                if (mutantId <= 0)
                    continue;
                mutantEffectMap.set(mutantId, mutant);
            }
            console.warn(`[配置] 已加载变异效果配置 (${mutantEffectMap.size} 种)`);
        }
    }
    catch (e) {
        console.warn('[配置] 加载 MutantEffect.json 失败:', e.message);
    }
    try {
        const illustratedPath = path.join(configDir, 'Illustrated.json');
        if (fs.existsSync(illustratedPath)) {
            illustratedConfig = JSON.parse(fs.readFileSync(illustratedPath, 'utf8'));
            illustratedItemMap.clear();
            for (const entry of illustratedConfig || []) {
                const itemId = Number(entry && entry.param) || 0;
                if (itemId > 0)
                    illustratedItemMap.set(itemId, entry);
            }
            console.warn(`[配置] 已加载图鉴配置 (${illustratedItemMap.size} 项)`);
        }
    }
    catch (e) {
        console.warn('[配置] 加载 Illustrated.json 失败:', e.message);
    }
    try {
        const buffPath = path.join(configDir, 'BuffCfg.json');
        if (fs.existsSync(buffPath)) {
            buffConfig = JSON.parse(fs.readFileSync(buffPath, 'utf8'));
            buffConfigMap.clear();
            for (const entry of buffConfig || []) {
                const id = Number(entry && entry.id) || 0;
                if (id > 0)
                    buffConfigMap.set(id, entry);
            }
            console.warn(`[配置] 已加载属性加成配置 (${buffConfigMap.size} 项)`);
        }
    }
    catch (e) {
        console.warn('[配置] 加载 BuffCfg.json 失败:', e.message);
    }
}
// ============ 等级经验相关 ============
function getLevelExpTable() {
    return levelExpTable;
}
function getLevelExpProgress(level, totalExp) {
    if (!levelExpTable || level <= 0)
        return { current: 0, needed: 0 };
    const currentLevelStart = levelExpTable[level] || 0;
    const nextLevelStart = levelExpTable[level + 1] || (currentLevelStart + 100000);
    const currentExp = Math.max(0, totalExp - currentLevelStart);
    const neededExp = nextLevelStart - currentLevelStart;
    return { current: currentExp, needed: neededExp };
}
// ============ 植物配置相关 ============
function getPlantById(plantId) {
    return plantMap.get(plantId);
}
function getPlantBySeedId(seedId) {
    return seedToPlant.get(seedId);
}
function getPlantName(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? plant.name : `植物${plantId}`;
}
function getPlantNameBySeedId(seedId) {
    const plant = seedToPlant.get(seedId);
    return plant ? plant.name : `种子${seedId}`;
}
function getPlantGrowTime(plantId) {
    const plant = plantMap.get(plantId);
    if (!plant || !plant.grow_phases)
        return 0;
    const phases = plant.grow_phases.split(';').filter(p => p);
    let totalSeconds = 0;
    for (const phase of phases) {
        const match = phase.match(/:(\d+)/);
        if (match) {
            totalSeconds += Number.parseInt(match[1]);
        }
    }
    return totalSeconds;
}
function formatGrowTime(seconds) {
    if (seconds < 60)
        return `${seconds}秒`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}分钟`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
}
function getPlantExp(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? (plant.exp || 0) : 0;
}
function getFruitName(fruitId) {
    const plant = fruitToPlant.get(fruitId);
    return plant ? plant.name : `果实${fruitId}`;
}
function getPlantByFruitId(fruitId) {
    return fruitToPlant.get(fruitId);
}
function getAllSeeds() {
    return Array.from(seedToPlant.values()).map(p => ({
        seedId: p.seed_id,
        name: p.name,
        requiredLevel: (() => { const si = seedItemMap.get(p.seed_id); return si ? (Number(si.level) || 0) : (Number(p.land_level_need) || 0); })(),
        price: getSeedPrice(p.seed_id),
        image: getSeedImageBySeedId(p.seed_id),
        seasons: Number(p.seasons) || 1,
        exp: Number(p.exp) || 0,
        growPhases: p.grow_phases || '',
        growTime: getPlantGrowTime(p.id),
        size: Number(p.size) || 0,
        harvestCount: Number(p.fruit.count) || 0,
    }));
}
function getMappedSeedImage(targetId) {
    const id = Number(targetId) || 0;
    if (id <= 0)
        return '';
    return `/game-config/seed_images_named/seed_images/${id}.png`;
}
function getSeedImageBySeedId(seedId) {
    return getMappedSeedImage(seedId);
}
function getItemImageById(itemId) {
    const id = Number(itemId) || 0;
    if (id <= 0)
        return '';
    // 直接按ID返回
    return `/game-config/seed_images_named/seed_images/${id}.png`;
}
function getItemById(itemId) {
    return itemInfoMap.get(Number(itemId) || 0);
}
/**
 * 解析 sells 字段，格式为 "货币ID:价格" 或 "货币ID1:价格1;货币ID2:价格2"
 * 返回 [{ currencyId, price }, ...]
 */
function parseSells(sells) {
    if (!sells)
        return [];
    return sells.split(';').map(part => {
        const [cid, price] = part.split(':');
        return { currencyId: Number(cid) || 0, price: Number(price) || 0 };
    });
}
/** Resolve prices whose normal or explicitly confirmed conditional sale is available. */
function getEffectiveSellInfo(itemOrId, context) {
    const item = typeof itemOrId === 'number'
        ? getItemById(itemOrId)
        : (itemOrId || undefined);
    if (!item)
        return { sellable: false, status: 'unavailable', condition: null, sells: [] };
    const normalSells = parseSells(item.sells).filter(sell => sell.currencyId > 0 && sell.price > 0);
    const condition = item.sell_cond ? String(item.sell_cond).trim() : '';
    const conditionalSells = parseSells(item.cond_sells).filter(sell => sell.currencyId > 0 && sell.price > 0);
    if (condition && conditionalSells.length > 0 && context
        && isSellConditionSatisfied(condition, context)) {
        return { sellable: true, status: 'available', condition, sells: conditionalSells };
    }
    if (normalSells.length > 0) {
        return { sellable: true, status: 'available', condition: condition || null, sells: normalSells };
    }
    if (condition && conditionalSells.length > 0) {
        return { sellable: false, status: 'conditional', condition, sells: [] };
    }
    return { sellable: false, status: 'unavailable', condition: condition || null, sells: [] };
}
function getSeedPrice(seedId) {
    const item = seedItemMap.get(Number(seedId) || 0);
    if (!item)
        return 0;
    const sellsList = parseSells(item.sells);
    if (sellsList.length > 0)
        return sellsList[0].price;
    // 回退到 cond_sells（活动道具可能 sells 为 null）
    const condList = parseSells(item.cond_sells);
    return condList.length > 0 ? condList[0].price : 0;
}
function getFruitPrice(fruitId) {
    const item = itemInfoMap.get(Number(fruitId) || 0);
    if (!item)
        return 0;
    const sellsList = parseSells(item.sells);
    if (sellsList.length > 0)
        return sellsList[0].price;
    const condList = parseSells(item.cond_sells);
    return condList.length > 0 ? condList[0].price : 0;
}
function getAllPlants() {
    return Array.from(plantMap.values());
}
function getAllFruits() {
    return Array.from(itemInfoMap.values()).filter(item => Number(item.type) === 6);
}
function getAllItems() {
    // 返回所有非种子(type=5)、非果实(type=6)的道具
    return Array.from(itemInfoMap.values()).filter(item => {
        const t = Number(item.type);
        return t !== 5 && t !== 6;
    });
}
function getItemsByType(type) {
    return Array.from(itemInfoMap.values()).filter(item => Number(item.type) === type);
}
function getItemInfoMap() {
    return itemInfoMap;
}
function getPlantMap() {
    return plantMap;
}
function getLandConfigById(landId) {
    return landConfigMap.get(Number(landId) || 0);
}
function getLandConfigByCoordinate(gridX, gridY) {
    if (!Number.isInteger(gridX) || !Number.isInteger(gridY))
        return undefined;
    return landCoordinateMap.get(getLandCoordinateKey(gridX, gridY));
}
function getAllLandConfigs() {
    return Array.from(landConfigMap.values());
}
function normalizeMutantIconName(value) {
    const raw = String(value || '').trim().replace(/\/spriteFrame$/i, '');
    return raw.split('/').filter(Boolean).pop() || '';
}
function toMutantEffectDto(effect, id) {
    const numericId = Number(id) || Number(effect?.id) || 0;
    if (!effect) {
        return {
            id: numericId,
            name: numericId > 0 ? `变异 #${numericId}` : '变异',
            icon: '',
            description: '',
            tag: '',
            activityId: 0,
        };
    }
    return {
        id: numericId,
        // 土地效果以官方运行时配置的 effect_name 为准；name 可能是“喜鹊事件”等内部事件名。
        name: String(effect.effect_name || effect.name || (numericId > 0 ? `变异 #${numericId}` : '变异')),
        icon: normalizeMutantIconName(effect.icon),
        description: String(effect.description
            || effect.tips
            || MUTANT_EFFECT_DESCRIPTION_FALLBACKS.get(numericId)
            || ''),
        tag: String(effect.tag || ''),
        activityId: Number(effect.activity_id) || 0,
    };
}
function getMutantEffectById(mutantId) {
    const id = Number(mutantId) || 0;
    if (id <= 0)
        return undefined;
    const effect = mutantEffectMap.get(id);
    return effect ? toMutantEffectDto(effect, id) : undefined;
}
function getMutantEffectsByIds(ids) {
    if (!Array.isArray(ids))
        return [];
    const seen = new Set();
    const result = [];
    for (const raw of ids) {
        const id = Number(raw) || 0;
        if (id <= 0 || seen.has(id))
            continue;
        seen.add(id);
        result.push(toMutantEffectDto(mutantEffectMap.get(id), id));
    }
    return result;
}
function getMutantTypeNames(ids) {
    return getMutantEffectsByIds(ids).map(effect => effect.name);
}
function getIllustratedTypeByParam(param) {
    const entry = illustratedItemMap.get(Number(param) || 0);
    return String(entry && entry.type || '');
}
function getIllustratedSortByParam(param) {
    const entry = illustratedItemMap.get(Number(param) || 0);
    return Number(entry && entry.sort) || 0;
}
function illustratedBuffDto(entry) {
    const value = Number(entry.attr_value) || 0;
    return {
        id: Number(entry.id) || 0,
        level: Number(entry.source_param) || 0,
        name: String(entry.attr_id || ''),
        value,
        valueType: value > 10 ? 'probability' : 'quantity',
    };
}
function getIllustratedBuffsByLevel(level) {
    const maxLevel = Math.max(0, Number(level) || 0);
    const latestByAttribute = new Map();
    [...buffConfigMap.values()]
        .filter(entry => entry.source_type === '超变升级' && Number(entry.source_param) <= maxLevel)
        .sort((a, b) => Number(a.source_param) - Number(b.source_param))
        .forEach(entry => {
        const name = String(entry.attr_id || '');
        if (name)
            latestByAttribute.set(name, illustratedBuffDto(entry));
    });
    return [...latestByAttribute.values()].sort((a, b) => a.level - b.level);
}
function getIllustratedBuffs() {
    return [...buffConfigMap.values()]
        .filter(entry => entry.source_type === '超变升级')
        .sort((a, b) => Number(a.source_param) - Number(b.source_param))
        .map(illustratedBuffDto);
}
/**
 * 根据当前变异组合解析客户端应展示的植物 ID。
 * mutant_effect_plant 格式示例：5:1120112:1;5_6:1129001:1。
 * 多效果组合优先于单效果，避免黄金+活动变异退化成普通黄金作物。
 */
function getMutantDisplayPlantId(plantId, mutantIds) {
    const numericPlantId = Number(plantId) || 0;
    if (!Array.isArray(mutantIds) || mutantIds.length === 0)
        return numericPlantId;
    const activeIds = new Set(mutantIds.map(id => Number(id) || 0).filter(id => id > 0));
    let currentPlantId = numericPlantId;
    const visited = new Set([currentPlantId]);
    for (let depth = 0; depth < 4; depth += 1) {
        const plant = plantMap.get(currentPlantId);
        const mapping = String(plant && plant.mutant_effect_plant || '').trim();
        if (!mapping)
            break;
        let bestMatch = null;
        for (const entry of mapping.split(';')) {
            const [effectKey, targetIdText] = entry.split(':');
            const effectIds = String(effectKey || '')
                .split('_')
                .map(id => Number(id) || 0)
                .filter(id => id > 0);
            const targetId = Number(targetIdText) || 0;
            if (!targetId || effectIds.length === 0 || !effectIds.every(id => activeIds.has(id)))
                continue;
            if (!bestMatch || effectIds.length > bestMatch.effectCount) {
                bestMatch = { effectCount: effectIds.length, targetId };
            }
        }
        if (!bestMatch || visited.has(bestMatch.targetId))
            break;
        currentPlantId = bestMatch.targetId;
        visited.add(currentPlantId);
    }
    return currentPlantId;
}
// 启动时加载配置
loadConfigs();
module.exports = {
    loadConfigs,
    getAllPlants,
    getAllSeeds,
    // 等级经验
    getLevelExpTable,
    getLevelExpProgress,
    // 植物配置
    getPlantById,
    getPlantBySeedId,
    getPlantName,
    getPlantNameBySeedId,
    getPlantGrowTime,
    getPlantExp,
    formatGrowTime,
    // 果实配置
    getFruitName,
    getPlantByFruitId,
    getItemById,
    getItemImageById,
    getSeedPrice,
    getFruitPrice,
    parseSells,
    getEffectiveSellInfo,
    getSeedImageBySeedId,
    // 配置管理查询
    getAllFruits,
    getAllItems,
    getItemsByType,
    getItemInfoMap,
    getPlantMap,
    getLandConfigById,
    getLandConfigByCoordinate,
    getAllLandConfigs,
    getMutantEffectById,
    getMutantEffectsByIds,
    getMutantTypeNames,
    getIllustratedTypeByParam,
    getIllustratedSortByParam,
    getIllustratedBuffsByLevel,
    getIllustratedBuffs,
    getMutantDisplayPlantId,
};
//# sourceMappingURL=gameConfig.js.map