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
const DISPLAY_SLOT = 1;
let mutationTail: Promise<void> = Promise.resolve();
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

function conditionsMet(value: string | null, owned: Map<string, any>): boolean {
    return !value || String(value).split(';').every(id => {
        const condition = conditionConfig.find((row: any) => row.condition_id === Number(id));
        if (!condition || condition.condition_type !== 3) return false;
        const ids = itemConfig.filter((item: any) => item.series_id === condition.target_series_id).map((item: any) => String(item.item_id));
        return ids.filter((itemId: string) => Number(owned.get(itemId)?.star_level || 0) >= condition.required_star_level).length >= condition.required_count;
    });
}

function normalizeCollections(reply: any): any {
    const detail = (reply.details || []).find((row: any) => row.category === CATEGORY);
    if (!detail) throw new Error('当前账号未返回蓝晶藏品信息');
    const owned = new Map<string, any>((detail.collections || []).map((row: any) => [quantity(row.collection_id), row]));
    const display = (reply.display_slots || []).find((row: any) => row.slot_type === DISPLAY_SLOT && row.display?.category === CATEGORY)?.display;
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
                    const unlocked = conditionsMet(row.unlock_condition_ids, owned) && conditionsMet(item.unlock_condition_ids, owned);
                    const nextStarCosts = rewards(nextStar?.items_need || null, item.item_id);
                    const copiesNeeded = nextStarCosts.find(cost => cost.itemId === item.item_id)?.count;
                    return {
                        id: item.item_id, name: definition?.name || `藏品${item.item_id}`, description: definition?.desc || '',
                        image: getItemImageById(item.item_id), starLevel, maxStarLevel: 5,
                        ownCount: quantity(state?.own_count), activated: starLevel > 0, isNew: state?.is_new === true,
                        score: scores ? Number(scores.score.split(';')[row.series_rarity - 1]) : 0,
                        displayed: quantity(display?.item_id) === String(item.item_id),
                        wished: (detail.wished || []).some((wish: any) => quantity(wish.collection_id) === String(item.item_id)),
                        requirements: [...conditionText(row.unlock_condition_ids), ...conditionText(item.unlock_condition_ids)],
                        nextStarCosts, unlocked,
                        canUpgrade: unlocked && starLevel < 5 && !!copiesNeeded && BigInt(quantity(state?.own_count)) >= BigInt(copiesNeeded),
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
async function readCollectionsReply(): Promise<any> {
    const { sendMsgAsync } = require('../utils/network');
    const { types } = require('../utils/proto');
    const body = types.GetCollectionsRequest.encode({ categories: [CATEGORY] }).finish();
    const reply = await sendMsgAsync('gamepb.collectionpb.CollectionService', 'GetCollections', body);
    return types.GetCollectionsReply.decode(reply.body);
}

function getCollectionsSnapshot(options: { fresh?: boolean } = {}): Promise<any> {
    if (options.fresh) return readCollectionsReply().then(normalizeCollections);
    if (pendingSnapshot) return pendingSnapshot;
    const request = readCollectionsReply().then(normalizeCollections);
    pendingSnapshot = request;
    request.finally(() => { if (pendingSnapshot === request) pendingSnapshot = null; }).catch(() => {});
    return request;
}

function collectionError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function collectionId(value: unknown): number {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || !itemConfig.some((item: any) => item.item_id === id)) throw collectionError('INVALID_ARGUMENT', '藏品编号无效');
    return id;
}

function costSignature(costs: any[]): string {
    return costs.map(cost => `${cost?.itemId}:${cost?.count}`).sort().join('|');
}

async function bagBalance(itemId: number): Promise<any> {
    const warehouse = require('./warehouse');
    const bag = await warehouse.getBag({ fresh: true });
    let total = 0n;
    let locked = 0n;
    for (const item of warehouse.getBagItems(bag).filter((item: any) => Number(item.id) === itemId)) {
        const count = BigInt(quantity(item.count));
        if (count < 0n) throw collectionError('BALANCE_UNKNOWN', '物品余额无法确认');
        total += count;
        if (warehouse.isItemLocked(item)) locked += count;
    }
    return { resourceKey: `item:${itemId}`, state: 'known', total: String(total), locked: String(locked) };
}

async function prepareCollectionUpgrade(input: any): Promise<any> {
    const id = collectionId(input.collectionId);
    const level = input.expectedStarLevel;
    if (!Number.isInteger(level) || level < 0 || level >= 5) throw collectionError('INVALID_ARGUMENT', '请提供当前藏品星级（0–4）');
    const raw = await readCollectionsReply();
    const snapshot = normalizeCollections(raw);
    const item = snapshot.series.flatMap((series: any) => series.items).find((item: any) => item.id === id);
    if (item.starLevel !== level) throw collectionError('COLLECTION_STATE_CHANGED', '藏品星级已变化，请刷新后重新确认');
    if (!item.unlocked) throw collectionError('COLLECTION_LOCKED', '尚未满足藏品解锁条件');
    if (!item.nextStarCosts.length) throw collectionError('COLLECTION_COST_UNKNOWN', '升星材料无法确认');
    if (input.expectedCosts !== undefined && (!Array.isArray(input.expectedCosts) || costSignature(input.expectedCosts) !== costSignature(item.nextStarCosts))) {
        throw collectionError('PRICE_CHANGED', '激活或升星材料已变化，请重新确认');
    }
    const balances = [];
    for (const cost of item.nextStarCosts) {
        const balance = cost.itemId === id
            ? { resourceKey: `item:${id}`, state: 'known', total: item.ownCount, locked: '0' }
            : await bagBalance(cost.itemId);
        if (BigInt(balance.total) - BigInt(balance.locked) < BigInt(cost.count)) throw collectionError('INSUFFICIENT_BALANCE', `${cost.name}不足，需要 ${cost.count}`);
        balances.push(balance);
    }
    return { raw, snapshot, item, balances, costs: item.nextStarCosts.map((cost: any) => ({ resourceKey: `item:${cost.itemId}`, amount: cost.count })),
        expected: { starLevel: level, costs: item.nextStarCosts.map((cost: any) => ({ itemId: cost.itemId, count: cost.count })) } };
}

async function sendCollectionMutation(method: string, input: any): Promise<any> {
    const { types } = require('../utils/proto');
    const { sendMsgAsync } = require('../utils/network');
    pendingSnapshot = null;
    const body = types[`${method}Request`].encode(input).finish();
    const reply = await sendMsgAsync('gamepb.collectionpb.CollectionService', method, body);
    return types[`${method}Reply`].decode(reply.body);
}

function unconfirmed(): never {
    throw collectionError('COLLECTION_RESULT_UNKNOWN', '藏品操作结果无法确认，请刷新核对，不要重复提交');
}

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
}

async function upgradeCollection(input: any): Promise<any> {
    return serializeMutation(async () => {
        const plan = await prepareCollectionUpgrade(input);
        const reply = await sendCollectionMutation('UpgradeCollection', { category: CATEGORY, collection_id: plan.item.id });
        const copies = plan.item.nextStarCosts.find((cost: any) => cost.itemId === plan.item.id);
        const expectedCount = BigInt(plan.item.ownCount) - BigInt(copies.count);
        if (reply.category !== CATEGORY || Number(reply.collection_id) !== plan.item.id || reply.star_level !== plan.item.starLevel + 1 || BigInt(quantity(reply.own_count)) !== expectedCount) unconfirmed();
        const series = plan.snapshot.series.find((series: any) => series.items.some((item: any) => item.id === plan.item.id));
        const score = scoreConfig.find((row: any) => Number(row.category) === CATEGORY && row.star_level === reply.star_level);
        if (!score || reply.current_score !== plan.snapshot.score - plan.item.score + Number(score.score.split(';')[series.rarity - 1])) unconfirmed();
        for (const cost of plan.item.nextStarCosts.filter((cost: any) => cost.itemId !== plan.item.id)) {
            const before = plan.balances.find((balance: any) => balance.resourceKey === `item:${cost.itemId}`);
            const after = await bagBalance(cost.itemId);
            if (BigInt(after.total) !== BigInt(before.total) - BigInt(cost.count)) unconfirmed();
        }
        const detail = plan.raw.details.find((detail: any) => detail.category === CATEGORY);
        const owned = detail.collections.find((item: any) => Number(item.collection_id) === plan.item.id);
        Object.assign(owned, { star_level: reply.star_level, own_count: reply.own_count });
        detail.current_score = reply.current_score;
        return { snapshot: normalizeCollections(plan.raw), costs: plan.costs };
    });
}

async function claimCollectionRewards(): Promise<any> {
    return serializeMutation(async () => {
        const raw = await readCollectionsReply();
        const snapshot = normalizeCollections(raw);
        const eligible = snapshot.milestones.filter((row: any) => row.reached && !row.claimed);
        if (!eligible.length) return { snapshot, skipped: true };
        const reply = await sendCollectionMutation('ClaimCollectionReward', { category: CATEGORY });
        if (reply.current_score < snapshot.score || reply.claimed_reward_score < eligible.at(-1).score || reply.claimed_reward_score > reply.current_score) unconfirmed();
        const detail = raw.details.find((detail: any) => detail.category === CATEGORY);
        Object.assign(detail, { current_score: reply.current_score, claimed_reward_score: reply.claimed_reward_score });
        return { snapshot: normalizeCollections(raw), claimedScores: reply.claimed_scores, rewards: (reply.total_rewards || []).map((item: any) => ({ id: Number(item.id), name: getItemById(Number(item.id))?.name || `物品${item.id}`, count: quantity(item.count) })) };
    });
}

async function setCollectionDisplay(input: any): Promise<any> {
    const id = collectionId(input.collectionId);
    if (typeof input.displayed !== 'boolean') throw collectionError('INVALID_ARGUMENT', '请指定展示或取消展示');
    return serializeMutation(async () => {
        const raw = await readCollectionsReply();
        const snapshot = normalizeCollections(raw);
        const item = snapshot.series.flatMap((series: any) => series.items).find((item: any) => item.id === id);
        if (!item.activated) throw collectionError('COLLECTION_NOT_ACTIVE', '请先激活藏品');
        const current = snapshot.display?.itemId || '0';
        if (input.expectedDisplayItemId !== undefined && String(input.expectedDisplayItemId) !== current) throw collectionError('COLLECTION_STATE_CHANGED', '展示藏品已变化，请刷新后重新确认');
        if ((input.displayed && current === String(id)) || (!input.displayed && current !== String(id))) return { snapshot, skipped: true };
        const target = input.displayed ? id : 0;
        const reply = await sendCollectionMutation('SwitchSceneDisplay', { display_slot: { slot_type: DISPLAY_SLOT, display: { category: CATEGORY, item_id: target } } });
        const slot = reply.display_slot;
        if (slot?.slot_type !== DISPLAY_SLOT || slot.display?.category !== CATEGORY || Number(slot.display.item_id) !== target) unconfirmed();
        raw.display_slots = [...(raw.display_slots || []).filter((row: any) => row.slot_type !== DISPLAY_SLOT), slot];
        return { snapshot: normalizeCollections(raw) };
    });
}

function operateCollections(action: string, input: any = {}): Promise<any> {
    if (action === 'upgrade') return upgradeCollection(input);
    if (action === 'claim') return claimCollectionRewards();
    if (action === 'display') return setCollectionDisplay(input);
    throw collectionError('INVALID_ARGUMENT', '未知的藏品操作');
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

module.exports = { getCollectionsSnapshot, normalizeCollections, getMutationCatalog, prepareCollectionUpgrade, upgradeCollection, claimCollectionRewards, setCollectionDisplay, operateCollections };
