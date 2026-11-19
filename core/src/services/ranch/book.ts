import mutationRules from '../../gameConfig/ranch/MCMutantInfo.json';
import tiers from '../../gameConfig/ranch/MCRanchWeightTier.json';
import illustratedConfig from '../../gameConfig/Illustrated.json';

export {};

const { rpc } = require('./transport');
const { animalMap, mutationMap, itemDto, quantity, sumItems, signature, error } = require('./model');
const illustratedSort = new Map(illustratedConfig.map(row => [row.param, row.sort]));
const giantProducts = new Map<number, number>();
for (const [animalId, mutation] of mutationMap) {
    giantProducts.set(animalMap.get(animalId).product_item.id, mutation.giant_product_item);
}

async function getBook(): Promise<any> {
    const normal = await rpc('book', { type: 101 });
    if (normal.type !== 101) throw error('RANCH_RESPONSE_MISMATCH', '牧场图鉴类型不匹配');
    const weight = await rpc('weightBook');
    return {
        normal: { level: normal.current_level, progress: normal.total_progress, nextProgress: normal.next_level_progress,
            canClaim: normal.has_claimable_reward, rewards: normal.total_rewards.map(itemDto) },
        giant: { score: quantity(weight.total_score), calculationMode: weight.calc_mode,
            levels: weight.levels.map((level: any) => ({ id: level.id, score: quantity(level.score_condition), claimed: level.claimed, canClaim: level.can_claim && !level.claimed, rewards: level.rewards.map(itemDto) })) },
        animals: [...normal.list].sort((a: any, b: any) => (illustratedSort.get(a.fruit_id) ?? a.fruit_id) - (illustratedSort.get(b.fruit_id) ?? b.fruit_id)).map((entry: any) => {
            const item = itemDto({ id: entry.fruit_id, count: 1 });
            const giantId = giantProducts.get(item.id);
            const giantItem = giantId ? itemDto({ id: giantId, count: 1 }) : null;
            if (giantItem && giantItem.image === item.image) giantItem.image = '';
            return {
                ...item, rarity: entry.rarity, layer: entry.layer, unlocked: entry.unlocked, progress: entry.progress,
                giantItem,
                giant: entry.giant ? { unlocked: entry.giant.unlocked, tier: entry.giant.tier,
                    tierName: tiers.find(row => row.tier === entry.giant.tier)?.tier_name || '',
                    // 实机确认：best_weight_x10=1124 在官方界面显示为 11.24 kg。
                    weightKg: entry.giant.best_weight_x10 / 100, minWeightKg: entry.giant.lo_x10 / 100, maxWeightKg: entry.giant.hi_x10 / 100,
                    harvestCount: quantity(entry.giant.harvest_count), isNew: entry.giant.is_new } : null,
            };
        }),
        mutations: mutationRules.map(row => ({ type: row.mutation_type, name: row.name, description: row.tips, baseProbabilityPercent: row.pro })),
    };
}

async function prepareBookClaim(kind: string): Promise<any> {
    if (!['normal', 'giant'].includes(kind)) throw error('INVALID_ARGUMENT', '请选择普通或巨大图鉴');
    const book = await getBook();
    const levels = kind === 'giant' ? book.giant.levels.filter((level: any) => level.canClaim) : [];
    return { kind, ids: levels.map((level: any) => level.id), count: kind === 'normal' ? Number(book.normal.canClaim) : levels.length,
        rewards: kind === 'normal' ? book.normal.rewards : sumItems(levels.flatMap((level: any) => level.rewards)), levels };
}

async function claimBook(plan: any): Promise<any[]> {
    const rewards: any[] = [];
    if (plan.kind === 'normal') {
        const reply = await rpc('claimBook', { type: 101 }, true);
        if (!reply.claimed_level_ids.length || signature(reply.total_rewards) !== signature(plan.rewards)) throw error('RANCH_RESULT_UNKNOWN', '图鉴奖励回包未能确认，请刷新核对');
        rewards.push(...reply.total_rewards);
    } else {
        for (const level of plan.levels) {
            const reply = await rpc('claimWeight', { id: level.id }, true);
            if (!reply.claimed_ids.includes(level.id) || signature(reply.rewards) !== signature(level.rewards)) throw error('RANCH_RESULT_UNKNOWN', '巨大图鉴奖励回包未能确认，请刷新核对');
            rewards.push(...reply.rewards);
        }
    }
    return rewards;
}

module.exports = { getBook, prepareBookClaim, claimBook };
