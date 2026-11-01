export {};

const { getItemById, getItemImageById } = require('../config/gameConfig');
const fs = require('node:fs');
const { getResourcePath } = require('../config/runtime-paths');
const config = (name: string) => JSON.parse(fs.readFileSync(getResourcePath('gameConfig', 'collections', `${name}.json`), 'utf8'));
const seriesConfig = config('CollectionSeries');
const itemConfig = config('CollectionItem');
const starConfig = config('CollectionStarLevelNeed');
const scoreConfig = config('CollectionScore');
const rewardConfig = config('CollectionScoreReward');
const conditionConfig = config('CollectionCondition');
const pedestalConfig = config('CollectionPedestal');
const groupConfig = config('CollectionGroup');
const buffs = JSON.parse(fs.readFileSync(getResourcePath('gameConfig', 'BuffCfg.json'), 'utf8'));
const mutants = JSON.parse(fs.readFileSync(getResourcePath('gameConfig', 'MutantEffect.json'), 'utf8'));
const probabilities = config('MutantPublicity');

const CATEGORY = 1;
const rarityNames = ['', '普通', '稀有', '珍品', '天工'];
const quantity = (value: any): string => value == null ? '0' : String(value);

function rewards(value: string | null, collectionId?: number): any[] {
    if (!value) return [];
    return value.split(';').map(part => {
        const [id, count] = part.split(':');
        const itemId = id === '0' ? collectionId : Number(id);
        return { itemId, count, name: getItemById(itemId)?.name || `物品${itemId}`, image: getItemImageById(itemId) };
    });
}

function conditionText(value: string | null): string[] {
    if (!value) return [];
    return String(value).split(';').map(id => {
        const condition = conditionConfig.find((row: any) => row.condition_id === Number(id));
        if (!condition) return '解锁条件待确认';
        const series = seriesConfig.find((row: any) => row.series_id === condition.target_series_id);
        if (condition.condition_type === 3) return `${series?.series_name || '指定系列'}中${condition.required_count}款藏品达到${condition.required_star_level}星`;
        return '解锁条件待确认';
    });
}

function buffDto(row: any): any {
    const value = Number(row.attr_value) / 100;
    return { id: row.id, name: row.attr_id, value,
        description: row.attr_id === '节省10%肥料' ? `${value}%概率节省10%肥料` : `${row.attr_id} +${value}%` };
}

function mutationRules(seriesId: number): any[] {
    return groupConfig.filter((row: any) => row.series_id === seriesId)
        .sort((a: any, b: any) => a.display_order - b.display_order)
        .map((row: any) => ({ name: row.group_name, probability: Number((row.public_probability / 100).toFixed(1)), guarantee: row.display_guarantee }));
}

function normalizeCollections(reply: any): any {
    const detail = (reply.details || []).find((row: any) => row.category === CATEGORY);
    if (!detail) throw new Error('当前账号未返回蓝晶藏品信息');
    const owned = new Map((detail.collections || []).map((row: any) => [quantity(row.collection_id), row]));
    const display = (reply.display_slots || []).find((row: any) => row.display?.category === CATEGORY)?.display;
    const score = detail.current_score;
    const claimedScore = detail.claimed_reward_score;
    const series = seriesConfig.filter((row: any) => Number(row.category) === CATEGORY)
        .sort((a: any, b: any) => a.display_order - b.display_order).map((row: any) => {
            const items = itemConfig.filter((item: any) => item.series_id === row.series_id)
                .sort((a: any, b: any) => a.display_order - b.display_order).map((item: any) => {
                    const state: any = owned.get(String(item.item_id));
                    const starLevel = state?.star_level || 0;
                    const definition = getItemById(item.item_id);
                    const nextStar = starConfig.find((entry: any) => entry.series_id === row.series_id && entry.star_level === starLevel + 1);
                    const scores = scoreConfig.find((entry: any) => entry.star_level === starLevel && Number(entry.category) === CATEGORY);
                    return {
                        id: item.item_id, name: definition?.name || `藏品${item.item_id}`, description: definition?.desc || '',
                        image: getItemImageById(item.item_id), starLevel, maxStarLevel: 5,
                        ownCount: quantity(state?.own_count), activated: starLevel > 0, isNew: state?.is_new === true,
                        score: scores ? Number(scores.score.split(';')[row.series_rarity - 1]) : 0,
                        displayed: quantity(display?.item_id) === String(item.item_id),
                        wished: (detail.wished || []).some((wish: any) => quantity(wish.collection_id) === String(item.item_id)),
                        requirements: conditionText(item.unlock_condition_ids),
                        nextStarCosts: rewards(nextStar?.items_need || null, item.item_id),
                    };
                });
            return { id: row.series_id, name: row.series_name, rarity: row.series_rarity, rarityName: rarityNames[row.series_rarity],
                description: row.desc || '', requirements: conditionText(row.unlock_condition_ids), mutationRules: mutationRules(row.series_id), items,
                activatedCount: items.filter((item: any) => item.activated).length, totalCount: items.length };
        });
    const milestones = rewardConfig.filter((row: any) => Number(row.category) === CATEGORY)
        .sort((a: any, b: any) => a.score - b.score).map((row: any) => ({
            level: row.level, score: row.score, claimed: row.score <= claimedScore, reached: row.score <= score,
            rewards: rewards(row.rewards), buffs: buffs.filter((buff: any) => buff.source_type === '藏品属性' && Number(buff.source_param) === row.level).map(buffDto),
        }));
    const currentBuffs = new Map<string, any>();
    for (const milestone of milestones.filter((row: any) => row.claimed)) {
        for (const buff of milestone.buffs) currentBuffs.set(buff.name, buff);
    }
    return {
        category: CATEGORY, score, claimedScore,
        activatedCount: series.reduce((sum: number, row: any) => sum + row.activatedCount, 0),
        totalCount: series.reduce((sum: number, row: any) => sum + row.totalCount, 0),
        nextRewardScore: milestones.find((row: any) => !row.claimed)?.score ?? null,
        currentBuffs: [...currentBuffs.values()], milestones, series,
        display: display && Number(display.item_id) > 0 ? { itemId: quantity(display.item_id), pedestalId: quantity(display.pedestal_id) } : null,
        pedestals: pedestalConfig.filter((row: any) => Number(row.category) === CATEGORY).map((row: any) => ({
            id: row.pedestal_id, name: getItemById(row.pedestal_id)?.name || '展台', image: getItemImageById(row.pedestal_id),
            owned: row.is_default === 1 || (detail.pedestals || []).some((item: any) => quantity(item.pedestal_id) === String(row.pedestal_id)),
        })),
        updatedAt: Date.now(),
    };
}

let pendingSnapshot: Promise<any> | null = null;
function getCollectionsSnapshot(): Promise<any> {
    if (pendingSnapshot) return pendingSnapshot;
    const request = (async () => {
        const { sendMsgAsync } = require('../utils/network');
        const { types } = require('../utils/proto');
        const body = types.GetCollectionsRequest.encode({ categories: [CATEGORY] }).finish();
        const reply = await sendMsgAsync('gamepb.collectionpb.CollectionService', 'GetCollections', body);
        return normalizeCollections(types.GetCollectionsReply.decode(reply.body));
    })();
    pendingSnapshot = request;
    request.finally(() => { if (pendingSnapshot === request) pendingSnapshot = null; }).catch(() => {});
    return request;
}

function getMutationCatalog(): any {
    const effects = mutants.filter((row: any) => !row.hide_ui).sort((a: any, b: any) => a.sort - b.sort).map((row: any) => {
        const [action, value] = String(row.actions).split(':').map(Number);
        const effect = action === 2 ? `数量 ×${value}` : action === 3 ? `售价 ×${value}` : action === 4 ? `产出 ${row.fruit_name}` : '';
        return { id: row.id, name: row.effect_name, tag: row.tag, image: `/game-config/seed_images_named/mutant/${row.id}.png`,
            effect, description: row.tips || '', probabilities: probabilities.filter((entry: any) => entry.mutant_id === row.id)
                .map((entry: any) => ({ rarity: entry.rarity, percent: entry.public_probability / 100 })) };
    });
    return {
        normal: effects.filter((row: any) => row.tag === '无'),
        decoration: effects.filter((row: any) => row.tag === '装扮'),
        collections: seriesConfig.filter((row: any) => Number(row.category) === CATEGORY && !row.display)
            .sort((a: any, b: any) => a.display_order - b.display_order).map((row: any) => ({
                id: row.series_id, name: row.series_name, rarityName: rarityNames[row.series_rarity], description: row.desc, mutationRules: mutationRules(row.series_id),
                items: itemConfig.filter((item: any) => item.series_id === row.series_id)
                    .sort((a: any, b: any) => a.display_order - b.display_order).map((item: any) => ({
                        id: item.item_id, name: getItemById(item.item_id)?.name || `藏品${item.item_id}`, image: getItemImageById(item.item_id),
                    })),
            })),
    };
}

module.exports = { getCollectionsSnapshot, normalizeCollections, getMutationCatalog };
