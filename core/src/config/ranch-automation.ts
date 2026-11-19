import { animalMap, cubMap } from './ranch-animals';

export const RANCH_AUTOMATION_DEFAULTS = {
    ranch_harvest: true,
    ranch_produce: true,
    ranch_buy: true,
    ranch_upgrade: true,
    ranch_sell: true,
    ranch_market_organic: true,
    ranch_grass: true,
    ranch_grass_buy: true,
    ranch_grass_threshold_percent: 20,
    ranch_fill_cans: true,
    ranch_feed_normal: true,
    ranch_feed_organic: true,
    ranch_clean: true,
    ranch_stroke: true,
    ranch_friend_steal: true,
    ranch_friend_clean: true,
    ranch_friend_mosquito: true,
    ranch_task: true,
    ranch_illustrated: true,
    ranch_share: true,
    ranch_daily_benefit: true,
    ranch_check_minutes: 5,
    ranch_strategy: 'level' as 'level' | 'preferred' | 'bag_priority',
    ranch_bag_fallback: 'level' as 'level' | 'preferred',
    ranch_coop_animal: 0,
    ranch_shed_animal: 0,
    ranch_coop_cub_priority: [] as number[],
    ranch_shed_cub_priority: [] as number[],
};

export type RanchAutomationConfig = typeof RANCH_AUTOMATION_DEFAULTS;
export const RANCH_SWITCH_KEYS = Object.keys(RANCH_AUTOMATION_DEFAULTS).filter(key => typeof RANCH_AUTOMATION_DEFAULTS[key as keyof RanchAutomationConfig] === 'boolean');
export const RANCH_ANIMAL_OPTIONS = [...animalMap.values()].filter(animal => animal.enable_flag).map(animal => ({ value: animal.id, label: animal.name, kind: animal.husbandry_type }));

export function normalizeRanchSetting(key: string, value: unknown): boolean | number | string | number[] {
    if (key === 'ranch_strategy' || key === 'ranch_bag_fallback') {
        const allowed = key === 'ranch_strategy' ? ['level', 'preferred', 'bag_priority'] : ['level', 'preferred'];
        if (!allowed.includes(String(value))) throw Object.assign(new Error('请选择有效的养殖策略'), { code: 'INVALID_CONFIG' });
        return String(value);
    }
    if (key === 'ranch_coop_animal' || key === 'ranch_shed_animal') {
        const id = Number(value);
        if (id !== 0 && !RANCH_ANIMAL_OPTIONS.some(animal => animal.value === id && animal.kind === (key === 'ranch_coop_animal' ? '窝' : '棚'))) {
            throw Object.assign(new Error('所选动物不适用于当前窝或棚'), { code: 'INVALID_CONFIG' });
        }
        return id;
    }
    if (key === 'ranch_coop_cub_priority' || key === 'ranch_shed_cub_priority') {
        const housing = key === 'ranch_coop_cub_priority' ? '窝' : '棚';
        if (!Array.isArray(value) || value.some(id => cubMap.get(id)?.husbandry_type !== housing)) {
            throw Object.assign(new Error(`${housing}的背包顺序只能包含适用于${housing}的幼崽`), { code: 'INVALID_CONFIG' });
        }
        return [...new Set<number>(value)];
    }
    if (key === 'ranch_check_minutes') {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 60) {
            throw Object.assign(new Error('牧场巡查间隔必须是 1–60 的整数分钟'), { code: 'INVALID_CONFIG' });
        }
        return number;
    }
    if (key === 'ranch_grass_threshold_percent') {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 100) {
            throw Object.assign(new Error('牧草补充阈值必须是 1–100 的整数百分比'), { code: 'INVALID_CONFIG' });
        }
        return number;
    }
    if (typeof value !== 'boolean') throw Object.assign(new Error('牧场开关必须为布尔值'), { code: 'INVALID_CONFIG' });
    return value;
}
