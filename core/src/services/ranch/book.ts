import mutationRules from '../../gameConfig/ranch/MCMutantInfo.json';
import tiers from '../../gameConfig/ranch/MCRanchWeightTier.json';
import illustratedConfig from '../../gameConfig/Illustrated.json';

export {};

const { inScene, rpc } = require('./transport');
const { animalMap, mutationMap, itemDto, quantity, sumItems, signature, error } = require('./model');
const illustratedSort = new Map(illustratedConfig.map(row => [row.param, row.sort]));
const giantProducts = new Map<number, number>();
for (const [animalId, mutation] of mutationMap) {
    giantProducts.set(animalMap.get(animalId).product_item.id, mutation.giant_product_item);
}

async function readNormalBook(): Promise<any> {
    const normal = await rpc('book', { type: 101 });
    if (normal.type !== 101) throw error('RANCH_RESPONSE_MISMATCH', '牧场图鉴类型不匹配');
    return normal;
}

function weightLevelDto(level: any) {
    return { id: level.id, score: quantity(level.score_condition), claimed: level.claimed,
        canClaim: level.can_claim && !level.claimed, rewards: level.rewards.map(itemDto) };
}

async function getBook(): Promise<any> {
    const normal = await readNormalBook();
    const claim = await prepareNormalClaim(normal);
    const weight = await rpc('weightBook');
    return {
        normal: { level: normal.current_level, progress: normal.total_progress, nextProgress: normal.next_level_progress,
            canClaim: claim.count > 0, rewards: claim.count ? claim.rewards : normal.total_rewards.map(itemDto) },
        giant: { score: quantity(weight.total_score), calculationMode: weight.calc_mode,
            levels: weight.levels.map(weightLevelDto) },
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

async function clearGiantBookNew(): Promise<{ cleared: number[]; notice: string }> {
    return inScene(async () => {
        const { list } = await readNormalBook();
        // 官方请求使用普通产物 ID，scope=2 只清巨大标记。
        const unread = new Set<number>(list.filter((entry: any) => giantProducts.has(entry.fruit_id) && entry.giant?.is_new)
            .map((entry: any) => entry.fruit_id));
        if (!unread.size) return { cleared: [], notice: '没有未读的巨大图鉴' };
        let writeError: Error | undefined;
        try {
            for (const id of unread) await rpc('clearBookNew', { fruit_ids: [id], scope: 2 }, true);
        } catch (cause) {
            // 中断后只回读。先前已生效的条目仍可确认。
            writeError = cause as Error;
        }
        const updated = await readNormalBook().catch((cause: Error) => {
            throw error('RANCH_RESULT_UNKNOWN', `巨大图鉴已读结果未确认，回读失败：${cause.message}，请刷新核对`);
        });
        const cleared = updated.list.filter((entry: any) => unread.has(entry.fruit_id) && entry.giant?.is_new === false)
            .map((entry: any) => entry.fruit_id);
        if (!cleared.length) throw writeError || error('RANCH_RESULT_UNKNOWN', '未能从服务端确认巨大图鉴已读，请刷新图鉴');
        const notice = `已读 ${cleared.length} 条巨大图鉴`;
        if (cleared.length === unread.size) return { cleared, notice };
        return { cleared, notice: `${notice}，其余 ${unread.size - cleared.length} 条未确认${writeError ? `（${writeError.message}）` : ''}，请刷新核对` };
    });
}

// 可领状态以图鉴列表为准。等级列表缺少可领标记时，先显示列表奖励，实际领取以一键回包为准。
async function prepareNormalClaim(book?: any): Promise<any> {
    const normal = book || await readNormalBook();
    if (!normal.has_claimable_reward) return { kind: 'normal', ids: [], count: 0, rewards: [] };
    const { level_list } = await rpc('bookLevels', { type: 101 });
    const levels = level_list.filter((level: any) => level.can_claim && !level.claimed)
        .sort((a: any, b: any) => a.level - b.level);
    if (!levels.length) return { kind: 'normal', ids: [], count: 1, rewards: normal.total_rewards.map(itemDto) };
    return { kind: 'normal', ids: levels.map((level: any) => level.level), count: levels.length,
        rewards: sumItems(levels.flatMap((level: any) => level.rewards)) };
}

async function prepareBookClaim(kind: string): Promise<any> {
    if (kind === 'normal') return prepareNormalClaim();
    if (kind !== 'giant') throw error('INVALID_ARGUMENT', '请选择普通或巨大图鉴');
    const weight = await rpc('weightBook');
    const levels = (weight.levels as any[]).map(weightLevelDto).filter(level => level.canClaim);
    return { kind, ids: levels.map(level => level.id), count: levels.length,
        rewards: sumItems(levels.flatMap(level => level.rewards)), levels };
}

async function claimBook(plan: any): Promise<{ rewards: any[]; completed: number }> {
    if (plan.kind === 'normal') {
        const reply = await rpc('claimBook', { type: 101 }, true);
        const ids: number[] = reply.claimed_level_ids;
        const completed = ids.length;
        const rewards = reply.total_rewards;
        const knownLevels = plan.ids.length > 0;
        // 未知可领等级时，预览只显示单级奖励，ClaimAllRewardsV2 仍可能一次发放多级。
        if (!completed || new Set(ids).size !== completed || ids.some(id => id <= 0)
            || !rewards.length || rewards.some((item: any) => BigInt(quantity(item.id)) <= 0n || BigInt(quantity(item.count)) <= 0n)
            || (knownLevels && completed !== plan.count)
            || ((knownLevels || completed === 1) && signature(rewards) !== signature(plan.rewards))) {
            throw error('RANCH_RESULT_UNKNOWN', '图鉴领奖数量或奖励不匹配，请刷新核对');
        }
        // 回包中的奖励 ID 与显示等级不同（1 级实包返回 ID 2）。先按图鉴列表的可领标记确认，仍可领时再按等级核对。
        const unconfirmed = (cause: Error) => {
            throw error('RANCH_RESULT_UNKNOWN', `图鉴奖励已提交，未能读取领取后的状态：${cause.message}`);
        };
        const after = await readNormalBook().catch(unconfirmed);
        if (after.has_claimable_reward) {
            if (!knownLevels) throw error('RANCH_RESULT_UNKNOWN', '图鉴仍有可领奖励，请刷新核对');
            const { level_list } = await rpc('bookLevels', { type: 101 }).catch(unconfirmed);
            const claimed = new Set(level_list.filter((level: any) => level.claimed).map((level: any) => level.level));
            if (!plan.ids.every((id: number) => claimed.has(id))) throw error('RANCH_RESULT_UNKNOWN', '图鉴等级尚未确认已领取，请刷新核对');
        }
        return { rewards, completed };
    }
    const rewards: any[] = [];
    for (const level of plan.levels) {
        const reply = await rpc('claimWeight', { id: level.id }, true);
        if (!reply.claimed_ids.includes(level.id) || signature(reply.rewards) !== signature(level.rewards)) throw error('RANCH_RESULT_UNKNOWN', '巨大图鉴奖励回包未能确认，请刷新核对');
        rewards.push(...reply.rewards);
    }
    return { rewards, completed: plan.count };
}

module.exports = { getBook, prepareBookClaim, claimBook, clearGiantBookNew };
