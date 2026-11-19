import { getRanchFriendList } from './friend-roster';

export {};

const { rpc, inScene, isUnlocked } = require('./transport');
const { animalMap, mutationMap, cubMap, canMap, facilityMap, itemMap, taskMap, itemDto, pendingOperationView, quantity, levelInfo, error } = require('./model');
const { getServerTimeSec } = require('../../utils/utils');
const { types } = require('../../utils/proto');

function bagItems(bag: any): any[] {
    return [...bag.physical_items, ...bag.virtual_items];
}

function salePrices(item: any): any[] {
    if (item.is_locked || !item.show || item.show.sell_cond.length || BigInt(quantity(item.count)) <= 0n) return [];
    const prices = item.show.sells;
    return prices.every((price: any) => BigInt(quantity(price.id)) > 0n && BigInt(quantity(price.count)) > 0n) ? prices : [];
}

function balance(bag: any, id: number): any {
    const entries = bagItems(bag).filter(item => Number(item.id) === id);
    const total = entries.reduce((sum, item) => sum + BigInt(quantity(item.count)), 0n);
    const locked = entries.filter(item => item.is_locked).reduce((sum, item) => sum + BigInt(quantity(item.count)), 0n);
    return { resourceKey: `item:${id}`, state: 'known', total: total.toString(), locked: locked.toString() };
}

async function resourceBalance(raw: any, id: number): Promise<any> {
    if (id !== 1004) return balance(raw.bag, id);
    if (!raw.diamondBalance) {
        const reply = await require('../pay').getRechargeInfo();
        const info = reply.recharge_infos[0];
        if (!info || info.balance === undefined || info.balance === null) throw error('RANCH_BALANCE_UNKNOWN', '钻石余额未能确认');
        raw.diamondBalance = { resourceKey: 'item:1004', state: 'known', total: quantity(info.balance), locked: '0' };
    }
    return raw.diamondBalance;
}

function animalDto(animal: any): any {
    const cfg = animalMap.get(Number(animal.animal_id));
    const stageNames = ['未知', '幼崽期', '成长期', '生产期', '成熟期', '可收获'];
    const nextTimes = [animal.infant_ready_at_ms, animal.grow_ready_at_ms, animal.produce_ready_at_ms, animal.mature_ready_at_ms].map(Number).filter(time => time > getServerTimeSec() * 1000);
    const mutation = animal.mutation;
    return {
        id: animal.animal_inst_id, ranchId: quantity(animal.ranch_inst_id), animalId: Number(animal.animal_id), slot: animal.slot_index,
        name: `${mutation?.mutation_type ? '巨大' : ''}${cfg?.name || `动物${animal.animal_id}`}`, image: itemDto({ id: (mutation?.mutation_type && mutationMap.get(Number(animal.animal_id))?.giant_product_item) || cfg?.product_item?.id || Number(animal.animal_id), count: 1 }).image,
        stage: animal.stage, stageName: animal.can_harvest ? '可收获' : animal.can_deliver ? '可生产' : animal.grass_blocked ? '缺少牧草' : stageNames[animal.stage],
        nextAtMs: nextTimes.length ? Math.min(...nextTimes) : null, grassBlocked: animal.grass_blocked,
        produceCount: animal.produce_count, maxProduceCount: cfg?.max_produce_count ?? null,
        canProduce: animal.can_deliver, canHarvest: animal.can_harvest, canFeed: animal.can_feed, canRelease: animal.can_donate,
        limitedCanUsed: animal.limited_can_used,
        mutation: mutation ? { type: mutation.mutation_type, source: mutation.source, weightX10: mutation.weight_display_x10, finalWeightX10: mutation.weight_final_x10, tier: mutation.tier, canStroke: mutation.strokable } : null,
    };
}

function facilityDto(facility: any, level: number): any {
    const metadata = facilityMap.get(Number(facility.facility_id));
    const next = facilityMap.get(metadata?.next_facility_id);
    const requirement = next?.upgrade_conditions?.match(/^RANCH_LEVEL:(\d+)$/);
    const costs = next?.upgrade_cost ? next.upgrade_cost.split(';').map((part: string) => {
        const [id, count] = part.split(':');
        return itemDto({ id, count });
    }) : [];
    return {
        id: quantity(facility.instance_id), facilityId: facility.facility_id,
        name: metadata?.name || `设施${facility.facility_id}`, moduleType: facility.module_type,
        state: facility.state, active: facility.state === 1,
        level: facility.level, capacity: facility.capacity, upgradeState: facility.upgrade_state,
        upgradeEndTime: Number(facility.upgrade_end_time),
        next: next ? { level: next.level, capacity: next.capacity, durationSec: next.upgrade_secs, requiredLevel: requirement ? Number(requirement[1]) : null, costs,
            available: facility.state === 1 && !!requirement && level >= Number(requirement[1]) && facility.upgrade_state === 0 } : null,
        feed: facility.feed_machine ? {
            count: facility.feed_machine.feed_count, consumeRate: facility.feed_machine.consume_rate,
            remainingSec: quantity(facility.feed_machine.remaining_secs), status: facility.feed_machine.status,
        } : null,
        ranch: facility.ranch ? {
            count: facility.ranch.animal_count, capacity: facility.ranch.capacity,
            shelves: facility.ranch.shelves.map((shelf: any) => ({ slot: shelf.slot_index, remaining: quantity(shelf.total_remain), canCollect: shelf.can_collect,
                products: shelf.lots.map((lot: any) => ({ ...itemDto({ id: lot.item_id, count: lot.remain_num }), stolen: quantity(lot.stolen_num) })) })),
            hazards: facility.ranch.hazards.map((hazard: any) => ({ id: quantity(hazard.hazard_id), type: hazard.hazard_type })),
            animals: facility.ranch.animals.map(animalDto),
        } : null,
    };
}

async function loadRaw(cells?: any): Promise<any> {
    const currentCells = cells || await rpc('cells');
    const bag = await rpc('bag', { global_scene_id: 2 });
    if (bag.global_scene_id !== 2) throw error('RANCH_RESPONSE_MISMATCH', '牧场背包场景不匹配');
    return { cells: currentCells, bag };
}

function shedAwaitingActivation(raw: any): any {
    // 达到开放条件后，服务器下发待激活的一级棚和正式实例 ID。
    return raw.cells.facilities.find((facility: any) =>
        facility.module_type === 7 && facility.facility_id === 6002001 && facility.state === 3);
}

function snapshot(raw: any): any {
    const info = levelInfo(Number(balance(raw.bag, 1102).total));
    return {
        unlocked: true, sceneId: 2, serverTime: getServerTimeSec() * 1000, ...info,
        currencies: [1007, 1002, 1005, 1008, 7002].map(id => ({ ...itemDto({ id, count: balance(raw.bag, id).total }), locked: balance(raw.bag, id).locked })),
        buckets: [7003, 7004].map(id => ({ id, seconds: balance(raw.bag, id).total })),
        grass: balance(raw.bag, 7001).total,
        facilities: raw.cells.facilities.filter((facility: any) => [6, 7, 8].includes(facility.module_type)).map((facility: any) => facilityDto(facility, info.level)),
    };
}

function inventory(raw: any): any[] {
    return raw.bag.physical_items.map((item: any) => {
        const metadata = itemMap.get(Number(item.id));
        const animal = cubMap.get(Number(item.id));
        return {
            ...itemDto(item), uid: quantity(item.uid), locked: item.is_locked, tabId: Number(item.tab_id) || Number(metadata?.show_tab_ids) || 0,
            type: metadata?.type || 0, sellPrices: item.show?.sells?.map(itemDto) || [],
            canSell: salePrices(item).length > 0,
            can: canMap.get(Number(item.id)) || null, animalId: animal?.id || null, giantCub: !!animal?.giantCubItemId,
            husbandryType: animal?.husbandry_type ?? null,
            product: item.item_detail?.ranch_product ? {
                weightX10: item.item_detail.ranch_product.weight_x10, tier: item.item_detail.ranch_product.tier,
                priceRate: quantity(item.item_detail.ranch_product.price_rate),
            } : null,
        };
    });
}

function taskList(reply: any): any[] {
    const source = reply.task_info;
    const result = new Map<string, any>();
    for (const task of [...source.growth_tasks, ...source.daily_tasks, ...source.tasks]) {
        if (![4, 5].includes(task.task_type)) continue;
        const id = quantity(task.id);
        result.set(id, {
            id, category: task.task_type === 5 ? 'daily' : 'growth', desc: task.desc || taskMap.get(Number(task.id))?.desc || `任务${id}`,
            progress: quantity(task.progress), total: quantity(task.total_progress), claimed: task.is_claimed, unlocked: task.is_unlocked,
            canClaim: task.is_unlocked && !task.is_claimed && BigInt(quantity(task.total_progress)) > 0n && BigInt(quantity(task.progress)) >= BigInt(quantity(task.total_progress)),
            shareMultiple: Number(task.share_multiple), conditionType: Number(task.cond_type), rewards: task.rewards.map(itemDto),
            entry: id === '300008' ? 'friends' : null,
        });
    }
    return [...result.values()];
}

async function catalog(raw: any, shopId: number): Promise<any> {
    if (![5, 6].includes(shopId)) throw error('INVALID_ARGUMENT', '不支持的牧场商店');
    const { getShopGoodsById } = require('../../config/gameConfig');
    const reply = await rpc('shop', { shop_id: shopId });
    const now = getServerTimeSec();
    return { shopId, goods: reply.goods_list.map((good: any) => {
        const cfg = getShopGoodsById(Number(good.id));
        const valid = cfg?.shop_id === shopId && cfg.item_id === Number(good.item_id);
        const discounted = Number(good.discount_start_time) > 0 && Number(good.discount_start_time) <= now && now < Number(good.discount_end_time);
        const currencyId = valid ? cfg.price_id : 0;
        return {
            id: quantity(good.id), reward: itemDto({ id: good.item_id, count: good.item_count }),
            price: { ...itemDto({ id: currencyId, count: discounted ? good.discount_price : good.price }), balance: currencyId ? balance(raw.bag, currencyId).total : null },
            available: valid && good.unlocked && !good.owned && (Number(good.limit_count) === 0 || Number(good.bought_num) < Number(good.limit_count)),
            maxCount: cfg?.one_buy_count || 1, remaining: Number(good.limit_count) > 0 ? Number(good.limit_count) - Number(good.bought_num) : null,
            requiredLevel: good.conds.find((condition: any) => condition.type === 3)?.param?.toString() || null,
            animal: [...animalMap.values()].find(row => row.cub_item_id === Number(good.item_id)) || null,
        };
    }) };
}

async function readMarketRotation(): Promise<any> {
    const reply = await rpc('shopProfiles', { global_scene_id: 2 });
    const profile = reply.shop_profiles.find((shop: any) => Number(shop.shop_id) === 7);
    return profile?.rotation_state.length ? types.RanchRotationShopState.decode(profile.rotation_state) : null;
}

async function market(raw: any): Promise<any> {
    const reply = await rpc('market', { shop_id: 7 });
    const now = getServerTimeSec();
    const level = levelInfo(Number(balance(raw.bag, 1102).total)).level;
    return { opened: reply.opened, present: reply.present, periodDay: quantity(reply.period_day), roundIndex: reply.round_index,
        shelves: reply.shelves.map((shelf: any) => ({ id: shelf.shelf_id, name: shelf.shelf_name, sort: shelf.sort })),
        goods: reply.goods.map((card: any) => {
            const discounted = Number(card.discount_start_time) > 0 && Number(card.discount_start_time) <= now && now < Number(card.discount_end_time);
            const requirementsMet = card.buy_conds.every((condition: any) => condition.type === '最低等级' && /^\d+$/.test(condition.params) && level >= Number(condition.params));
            return { id: quantity(card.goods_id), shelfId: card.shelf_id, slot: card.slot,
                reward: itemDto({ id: card.item_id, count: card.item_count }),
                price: { ...itemDto({ id: card.cost_item_id, count: discounted ? card.discount_price : card.cost_count }), balance: balance(raw.bag, Number(card.cost_item_id)).total },
                remaining: Number(card.limit_count) > 0 ? Math.max(0, Number(card.limit_count) - Number(card.limit_used)) : null,
                requiredLevel: card.buy_conds.find((condition: any) => condition.type === '最低等级')?.params || null,
                available: reply.opened && reply.present && requirementsMet && (Number(card.limit_count) === 0 || Number(card.limit_used) < Number(card.limit_count)),
            };
        }),
    };
}

async function canCatalog(raw: any, slotType = 6): Promise<any> {
    if (![6, 7].includes(slotType)) throw error('INVALID_ARGUMENT', '未知牧场罐头商城');
    const reply = await rpc('canShop', { slot_type: slotType, is_manual_open: true, global_scene_id: 2 });
    const now = getServerTimeSec();
    const goods: any[] = [];
    for (const good of reply.goods_list) {
        if (!good.reward_items.length || good.reward_items.some((item: any) => !canMap.has(Number(item.id)))) continue;
        const promotion = Number(good.discount_price) > 0 && Number(good.promotion_start_time) <= now && now < Number(good.promotion_end_time);
        const price = itemDto({ id: good.price.id, count: promotion ? good.discount_price : good.price.count });
        const free = good.is_free && BigInt(price.count) === 0n;
        const remaining = good.purchase_limit?.limit_type ? Math.max(0, Number(good.purchase_limit.limit_count) - Number(good.purchase_limit.bought_count)) : null;
        const rewards = good.reward_items.map(itemDto);
        goods.push({ id: quantity(good.goods_id), name: good.name, reward: rewards[0], rewards, free,
            price: { ...price, balance: free ? null : (await resourceBalance(raw, price.id)).total },
            remaining, maxCount: 999,
            available: !good.is_owned && !good.ad_only && !(good.share?.share_only && good.share.share_status !== 2)
                && (remaining === null || remaining > 0) && (good.is_available || !good.purchase_limit)
                && (free || price.id > 0 && BigInt(price.count) > 0n) });
    }
    return { slotType, goods };
}

async function getState(view = 'animals', shopId?: number, hostGid?: string): Promise<any> {
    if (!['animals', 'facilities', 'bag', 'shop', 'market', 'tasks', 'friends', 'illustrated', 'activities', 'cans'].includes(view)) throw error('INVALID_ARGUMENT', '未知牧场页面');
    if (!isUnlocked()) return { unlocked: false, sceneId: 2, reason: '牧场尚未解锁，请先在游戏中完成开启条件' };
    return inScene(async (cells: any) => {
        const raw = await loadRaw(cells);
        const state = snapshot(raw);
        state.pendingOperations = require('./operation-state').forCurrentAccount().pending().map(pendingOperationView);
        if (view === 'bag') state.bag = inventory(raw);
        if (view === 'shop') state.shop = await catalog(raw, Number(shopId ?? 5));
        if (view === 'market') state.market = await market(raw);
        if (view === 'cans') state.canShop = await canCatalog(raw, Number(shopId ?? 6));
        if (view === 'tasks') {
            state.tasks = taskList(await rpc('tasks', { global_scene_id: 2 }));
            // 每日首次分享状态随任务和活动页面返回。
            state.dailyShare = require('./daily-share').getState();
            state.dailyBenefit = await require('./daily-benefit').read();
        }
        if (view === 'illustrated') state.book = await require('./book').getBook();
        if (view === 'activities') {
            state.dailyShare = require('./daily-share').getState();
            const reply = await rpc('activities', { game_scene_id: 2 });
            state.activities = reply.activities.map((group: any) => ({ id: quantity(group.activity.activity_id), name: group.activity.name,
                startTime: Number(group.activity.begin_time) * 1000, endTime: Number(group.activity.end_time) * 1000 }));
        }
        if (view === 'friends') {
            if (hostGid !== undefined) state.friendRanch = await require('./friends').getFriend(hostGid);
            else state.friends = (await getRanchFriendList()).map(friend => ({ ...friend, gid: String(friend.gid) }));
        }
        return state;
    });
}

function isRanchResource(id: number): boolean {
    return [1007, 1008, 7001, 7002, 7003, 7004].includes(id) || [102, 105, 106, 107, 108, 109, 110, 111].includes(itemMap.get(id)?.type);
}

async function resourceBalances(keys: string[]): Promise<any[]> {
    if (!isUnlocked()) return keys.map(key => ({ resourceKey: key, name: itemDto({ id: key.slice(5), count: 0 }).name, source: 'ranch-bag', state: 'unavailable', total: null, locked: null, asOfMs: null, reason: '牧场尚未解锁' }));
    return inScene(async () => {
        const raw = await loadRaw();
        return keys.map(key => ({ ...balance(raw.bag, Number(key.slice(5))), name: itemDto({ id: key.slice(5), count: 0 }).name, source: 'ranch-bag', asOfMs: Date.now() }));
    });
}

module.exports = { getState, loadRaw, shedAwaitingActivation, snapshot, balance, bagItems, inventory, salePrices, taskList, catalog, market, readMarketRotation, canCatalog, resourceBalance, isRanchResource, resourceBalances, animalDto };
