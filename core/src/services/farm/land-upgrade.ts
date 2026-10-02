import levels from '../../gameConfig/LandLevel.json';
import upgradeCosts from '../../gameConfig/LandLevelNeed.json';

const { getItemById, getSeedImageBySeedId } = require('../../config/gameConfig');
const number = (value: any) => Number(value?.toString?.() ?? value) || 0;
const amount = (value: any) => /^\d+$/.test(String(value)) ? String(value) : '0';

function levelInfo(level: number, buff?: any) {
    const config = levels.find(entry => entry.id === level);
    if (!config) return null;
    return {
        level, name: config.level_name, image: `/land-assets/${level}.png`,
        yieldBonus: number(buff?.plant_yield_bonus ?? config.plant_yield_bonus) / 100,
        growthReduction: number(buff?.planting_time_reduction ?? config.planting_time_reduction) / 100,
        expBonus: number(buff?.plant_exp_bonus ?? config.plant_exp_bonus) / 100,
        mutantMultiplier: number(config.plant_mutant_bonus) / 10000,
        resonanceBonus: number(config.plant_mutant_exp_bonus) / 100,
    };
}

function costs(items: any[]) {
    return items.filter(item => number(item.id) > 0 && number(item.count) > 0).map(item => ({
        id: String(item.id), count: amount(item.count),
        name: getItemById(number(item.id))?.name || `物品 ${item.id}`,
        image: getSeedImageBySeedId(number(item.id)) || '',
    }));
}

export function buildLandUpgradeDetail(land: any, landsMap: Map<number, any> = new Map()) {
    const id = number(land?.id); const level = number(land?.level);
    const maxLevel = number(land?.max_level);
    const current = land?.unlocked ? levelInfo(level, land.buff) : null;
    if (!land?.unlocked) {
        const condition = land?.unlock_condition;
        const precedingId = number(condition?.preceding_land_id);
        return { mode: 'unlock', current, next: levelInfo(1), serverAllowed: !!land?.could_unlock,
            needLevel: condition ? number(condition.need_level) : null,
            prerequisite: precedingId ? { landId: precedingId, met: !!landsMap.get(precedingId)?.unlocked } : null,
            costs: costs([{ id: 1001, count: condition?.need_gold }]), unknown: !condition };
    }
    if (maxLevel > 0 && level >= maxLevel) {
        return { mode: 'max', current, next: null, costs: [], unknown: !current };
    }
    const next = levelInfo(level + 1);
    const condition = land?.upgrade_condition;
    const config = upgradeCosts.find(entry => entry.land_id === id && entry.level === level + 1);
    const configItems = String(config?.items_need || '').split(';').filter(Boolean).map(part => {
        const [itemId, count] = part.split(':');
        return { id: itemId, count };
    });
    const conditionType = number(condition?.condition_type);
    return { mode: 'upgrade', current, next, serverAllowed: !!land?.could_upgrade,
        needLevel: condition ? (conditionType === 1 ? number(condition.condition_value) : null) : (config?.level_need ?? null),
        prerequisite: null,
        costs: costs(condition ? (condition.required_items || []) : configItems),
        unknown: !next || (condition ? conditionType !== 1 : !config),
    };
}
