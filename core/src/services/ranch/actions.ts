export {};

const { rpc, inScene } = require('./transport');
const { loadRaw, snapshot, balance, taskList, catalog, market, canCatalog, resourceBalance, salePrices, shedAwaitingActivation } = require('./state');
const { animalMap, cubMap, canMap, facilityMap, itemMap, taskMap, error, positiveId, positiveCount, quantity, itemDto, sumItems, signature } = require('./model');
const reservations = require('./operation-state');
const { getServerTimeSec } = require('../../utils/utils');
const { setTimeout: wait } = require('node:timers/promises');

const { ACTIONS } = require('./contract');
const DIRECT_ACTIONS = new Set(['feed', 'produce', 'harvest', 'clean']);
const LABELS: Record<string, string> = {
    buy: '购买牧场商品', place: '放养幼崽', addGrass: '补充牧草', useCan: '添加罐头', feed: '喂养动物',
    produce: '牧场生产', harvest: '牧场收获', sell: '出售牧场产物', clean: '清理牧场', upgrade: '升级牧场设施',
    completeUpgrade: '完成牧场升级', claimTasks: '领取牧场任务', reportEntry: '完成牧场引导', exchange: '集市兑换',
    activateShed: '解锁牧场棚',
    claimIllustrated: '领取牧场图鉴奖励',
    claimDailyShare: '领取每日首次分享礼包',
    buyCan: '购买牧场罐头',
    release: '放生动物',
};

function selectedAnimals(raw: any, input: any, eligible: (animal: any) => boolean): any[] {
    const all = raw.cells.facilities.flatMap((facility: any) => facility.ranch?.animals || []);
    if (input.all === true) return all.filter(eligible);
    const ranchId = positiveId(input.ranchId, '牧场设施');
    const animalId = positiveCount(input.animalId);
    const animal = all.find((entry: any) => quantity(entry.ranch_inst_id) === ranchId && entry.animal_inst_id === animalId);
    if (!animal || !eligible(animal)) throw error('RANCH_STATE_CHANGED', '动物状态已变化，请刷新后重新操作');
    return [animal];
}

function animalRefs(animals: any[]): any[] {
    return animals.map(animal => ({ ranch_inst_id: quantity(animal.ranch_inst_id), animal_inst_id: animal.animal_inst_id }));
}

function isClientReportedTask(task: any): boolean {
    if (!task?.unlocked || task.claimed) return false;
    if (BigInt(task.total) <= 0n || BigInt(task.progress) >= BigInt(task.total)) return false;
    return taskMap.get(Number(task.id))?.condition === '客户端上报进度';
}

async function planAction(action: string, input: any, raw: any, produceTargets?: any[]): Promise<any> {
    if (!ACTIONS.includes(action)) throw error('INVALID_ARGUMENT', '不支持的牧场操作');
    const plan: any = { action, label: LABELS[action], route: action, payload: {}, costItems: [], marker: null, expectedRewards: [], count: 1 };
    if (action === 'buy') {
        const goodsId = positiveId(input.goodsId, '商品');
        const count = positiveCount(input.count);
        const shop = await catalog(raw, Number(input.shopId));
        const good = shop.goods.find((entry: any) => entry.id === goodsId);
        if (!good?.available) throw error('GOODS_UNAVAILABLE', '商品尚未解锁、已售罄或配置未确认');
        if (count > good.maxCount || (good.remaining !== null && count > good.remaining)) throw error('PURCHASE_LIMIT_EXCEEDED', '数量超过本次购买或限购上限');
        if (input.autoPlace === true && !good.animal) throw error('INVALID_ARGUMENT', '只有幼崽可以自动放养');
        if (input.autoPlace === true) {
            const kind = good.animal.husbandry_type === '窝' ? 1 : 2;
            const room = raw.cells.facilities.filter((f: any) => f.ranch?.husbandry_type === kind).reduce((sum: number, f: any) => sum + f.ranch.capacity - f.ranch.animal_count, 0);
            if (room < count) throw error('RANCH_FULL', '窝或棚的空位不足，请减少数量或先放入背包');
            plan.autoPlaceAnimalId = good.animal.id;
        }
        plan.payload = { goods_id: goodsId, num: count, price: good.price.count, auto_add: input.autoPlace === true };
        plan.costItems = [itemDto({ id: good.price.id, count: BigInt(good.price.count) * BigInt(count) })];
        plan.expectedRewards = [itemDto({ id: good.reward.id, count: BigInt(good.reward.count) * BigInt(count) })];
        plan.label = `购买${plan.expectedRewards[0].name} ×${plan.expectedRewards[0].count}`;
        plan.marker = shop.shopId;
    } else if (action === 'buyCan') {
        const current = await canCatalog(raw, Number(input.slotType ?? 6));
        const id = positiveId(input.goodsId, '罐头商品');
        const count = positiveCount(input.count);
        const good = current.goods.find((row: any) => row.id === id);
        if (!good?.available || count > good.maxCount || good.remaining !== null && count > good.remaining) throw error('GOODS_UNAVAILABLE', '罐头商品不可购买或超过限购数量');
        plan.payload = { goods_id: id, count };
        plan.costItems = good.free ? [] : [itemDto({ id: good.price.id, count: BigInt(good.price.count) * BigInt(count) })];
        plan.expectedRewards = good.rewards.map((item: any) => itemDto({ id: item.id, count: BigInt(item.count) * BigInt(count) }));
        plan.marker = { slotType: current.slotType, free: good.free };
        plan.label = `${good.free ? '领取' : '购买'}${good.name} ×${count}`;
    } else if (action === 'place') {
        const ranchId = positiveId(input.ranchId, '牧场设施');
        const itemId = Number(positiveId(input.itemId, '幼崽'));
        const count = positiveCount(input.count);
        const animal = cubMap.get(itemId);
        const ranch = raw.cells.facilities.find((facility: any) => quantity(facility.instance_id) === ranchId)?.ranch;
        if (!animal || !ranch || ranch.husbandry_type !== (animal.husbandry_type === '窝' ? 1 : 2)) throw error('RANCH_ANIMAL_MISMATCH', '幼崽与窝或棚不匹配');
        if (count > ranch.capacity - ranch.animal_count) throw error('RANCH_FULL', '窝或棚的空位不足');
        plan.payload = { items: Array.from({ length: count }, () => ({ ranch_inst_id: ranchId, animal_id: animal.id, giant_cub_item_id: animal.giantCubItemId })) };
        plan.costItems = [itemDto({ id: itemId, count })];
        plan.label = `放养${plan.costItems[0].name} ×${count}`;
        plan.marker = { ranchId, animalId: animal.id, capacity: ranch.capacity, occupied: ranch.animal_count };
        plan.count = count;
    } else if (action === 'addGrass') {
        const facilityId = positiveId(input.facilityId, '牧草机');
        const count = positiveCount(input.count);
        const facility = raw.cells.facilities.find((entry: any) => quantity(entry.instance_id) === facilityId && entry.module_type === 8);
        if (!facility?.feed_machine || count > facility.capacity - facility.feed_machine.feed_count) throw error('RANCH_GRASS_CAPACITY', '牧草机剩余容量不足');
        plan.payload = { instance_id: facilityId, add_count: count, use_gold: false };
        plan.costItems = [itemDto({ id: 7001, count })];
        plan.marker = { capacity: facility.capacity, level: facility.level };
    } else if (action === 'useCan') {
        const uid = positiveId(input.uid, '罐头批次');
        const count = positiveCount(input.count);
        const item = raw.bag.physical_items.find((entry: any) => quantity(entry.uid) === uid);
        const config = item && canMap.get(Number(item.id));
        if (!config || item.is_locked || BigInt(quantity(item.count)) < BigInt(count)) throw error('RANCH_CAN_UNAVAILABLE', '罐头库存不足或已锁定');
        plan.payload = { item: { id: quantity(item.id), uid, count } };
        plan.costItems = [itemDto({ id: item.id, count })];
        plan.bucketId = config.feed_type === '有机罐头' ? 7004 : 7003;
        plan.marker = { uid, bucketId: plan.bucketId, seconds: config.speed_up_secs };
        plan.expectedSeconds = BigInt(config.speed_up_secs) * BigInt(count);
    } else if (action === 'feed') {
        const bucketType = Number(input.bucketType);
        if (![1, 2].includes(bucketType)) throw error('INVALID_ARGUMENT', '请选择有机或普通罐头');
        const feedable = selectedAnimals(raw, input, () => true).filter(animal => animal.can_feed);
        const animals = feedable.filter(animal => bucketType === 1 || !animal.limited_can_used);
        if (!animals.length) plan.message = feedable.length ? '普通罐头本轮已使用' : '当前没有可喂养的动物';
        plan.payload = { targets: animalRefs(animals), bucket_type: bucketType };
        const maxSeconds = animals.reduce((sum, animal) => {
            const config = animalMap.get(Number(animal.animal_id));
            if (!config) throw error('RANCH_CONFIG_UNKNOWN', '动物阶段配置尚未同步');
            const durations = [0, config.infant_sec, config.grow_sec, config.product_round_sec, config.mature_sec];
            const deadlines = [0, animal.infant_ready_at_ms, animal.grow_ready_at_ms, animal.produce_ready_at_ms, animal.mature_ready_at_ms];
            const remaining = Math.max(0, Math.ceil(Number(deadlines[animal.stage]) / 1000) - getServerTimeSec());
            const upperBound = Math.max(durations[animal.stage] || 0, Math.ceil(remaining / 3600) * 3600);
            if (!upperBound) throw error('RANCH_PRICE_UNKNOWN', '当前阶段的罐头消耗无法确认');
            return sum + BigInt(upperBound);
        }, 0n);
        const bucketId = bucketType === 1 ? 7004 : 7003;
        const available = BigInt(balance(raw.bag, bucketId).total);
        if (animals.length && available <= 0n) throw error('RANCH_BUCKET_EMPTY', `${bucketType === 1 ? '有机罐头' : '普通罐头'}不足，请先添加罐头`);
        if (animals.length) plan.costItems = [itemDto({ id: bucketId, count: available < maxSeconds ? available : maxSeconds })];
        plan.bucketId = bucketId;
        plan.marker = animals.map(animal => [quantity(animal.ranch_inst_id), animal.animal_inst_id, animal.stage, animal.limited_can_used, quantity(animal.grow_ready_at_ms), quantity(animal.mature_ready_at_ms)]);
        plan.count = animals.length;
    } else if (action === 'release') {
        if (input.all === true) throw error('INVALID_ARGUMENT', '请逐只确认需要放生的动物');
        const animals = selectedAnimals(raw, input, animal => animal.can_donate);
        if ((await require('./friends').getInteractionTimes()).release <= 0) throw error('RANCH_INTERACTION_LIMIT', '今日放生次数已用完');
        const animal = animals[0];
        const name = `${animal.mutation?.mutation_type ? '巨大' : ''}${animalMap.get(Number(animal.animal_id))?.name || '动物'}`;
        plan.payload = { targets: animalRefs(animals) };
        plan.marker = { animalId: quantity(animal.animal_id), stage: animal.stage, mutation: animal.mutation?.mutation_type || 0 };
        plan.label = `放生${name}`;
        plan.message = `确定放生「${name}」吗？放生后动物将离开栏舍，已产出的产物会保留。`;
        plan.resultKeys = [`${quantity(animal.ranch_inst_id)}:1:${animal.animal_inst_id}`];
    } else if (action === 'produce' || action === 'harvest') {
        const animals = produceTargets ?? selectedAnimals(raw, input, animal => action === 'produce' ? animal.can_deliver : animal.can_harvest);
        const shelves = action === 'harvest' && input.all === true ? raw.cells.facilities.flatMap((f: any) => (f.ranch?.shelves || []).filter((s: any) => s.can_collect).map((s: any) => ({ ranch_inst_id: quantity(f.instance_id), slot_index: s.slot_index }))) : [];
        plan.payload = action === 'produce' ? { targets: input.all === true ? [] : animalRefs(animals) }
            : input.all === true ? { op: 1 } : { op: 4, animals: animalRefs(animals) };
        plan.marker = { animals: animalRefs(animals), shelves };
        plan.resultKeys = [...animals.map(animal => `${quantity(animal.ranch_inst_id)}:1:${animal.animal_inst_id}`), ...shelves.map(shelf => `${shelf.ranch_inst_id}:2:${shelf.slot_index}`)];
        plan.count = animals.length + shelves.length;
    } else if (action === 'clean') {
        const ids = raw.cells.facilities.filter((facility: any) => facility.ranch?.hazards.length).map((facility: any) => quantity(facility.instance_id));
        plan.payload = { ranch_inst_ids: ids };
        plan.marker = raw.cells.facilities.flatMap((f: any) => f.ranch?.hazards.map((hazard: any) => `${quantity(f.instance_id)}:3:${quantity(hazard.hazard_id)}`) || []);
        plan.resultKeys = plan.marker;
        plan.count = plan.marker.length;
    } else if (action === 'sell') {
        let requested: Array<{ item: any; count: string | number; prices: any[] }>;
        if (input.all === true) {
            requested = raw.bag.physical_items.filter((item: any) => [106, 107].includes(itemMap.get(Number(item.id))?.type))
                .map((item: any) => ({ item, count: quantity(item.count), prices: salePrices(item) }))
                .filter((entry: any) => entry.prices.length);
        } else {
            const uid = positiveId(input.uid, '物品批次');
            const count = positiveCount(input.count);
            const item = raw.bag.physical_items.find((row: any) => quantity(row.uid) === uid);
            const prices = item && salePrices(item);
            if (!prices?.length || BigInt(quantity(item.count)) < BigInt(count)) throw error('RANCH_ITEM_UNAVAILABLE', '物品库存、锁定或出售条件已变化');
            requested = [{ item, count, prices }];
        }
        plan.payload.items = requested.map(({ item, count, prices }) => {
            plan.expectedRewards.push(...prices.map((price: any) => itemDto({ id: price.id, count: BigInt(quantity(price.count)) * BigInt(count) })));
            return { id: quantity(item.id), uid: quantity(item.uid), count };
        });
        plan.costItems = plan.payload.items.map(itemDto);
        plan.count = requested.length;
        if (input.all !== true) plan.label = `出售${plan.costItems[0].name} ×${plan.costItems[0].count}`;
    } else if (action === 'activateShed') {
        const id = positiveId(input.facilityId, '牧场棚');
        const shed = shedAwaitingActivation(raw);
        plan.count = Number(quantity(shed?.instance_id) === id);
        plan.payload = { instance_id: id };
        plan.marker = shed?.facility_id;
    } else if (action === 'upgrade' || action === 'completeUpgrade') {
        const id = positiveId(input.facilityId, '牧场设施');
        const facility = raw.cells.facilities.find((row: any) => quantity(row.instance_id) === id && [6, 7, 8].includes(row.module_type));
        if (!facility || facility.state !== 1) throw error('RANCH_FACILITY_NOT_FOUND', '牧场设施尚未建造或未就绪');
        plan.payload = { inst_id: id };
        plan.marker = { facilityId: facility.facility_id, level: facility.level };
        if (action === 'upgrade') {
            const current = facilityMap.get(facility.facility_id); const next = facilityMap.get(current?.next_facility_id);
            const requirement = next?.upgrade_conditions?.match(/^RANCH_LEVEL:(\d+)$/);
            if (!next || !requirement || snapshot(raw).level < Number(requirement[1]) || facility.upgrade_state !== 0) throw error('RANCH_UPGRADE_UNAVAILABLE', '尚未满足等级要求、已满级或正在升级');
            const details = (await rpc('facility', { instance_id: id })).info;
            if (details.facility_id !== facility.facility_id || details.level !== facility.level) throw error('RANCH_STATE_CHANGED', '建筑等级已变化');
            plan.costItems = details.upgrade_cost.map(itemDto);
            if (!plan.costItems.length) throw error('RANCH_PRICE_UNKNOWN', '升级费用尚未确认');
            plan.next = next;
            plan.label = `升级${current.name}至${next.level}级（${next.upgrade_secs}秒）`;
        } else if (!facility.upgrade_state) {
            plan.count = 0;
        } else {
            const end = Number(facility.upgrade_end_time);
            const endMs = end < 100_000_000_000 ? end * 1000 : end;
            if (facility.upgrade_state !== 2 && endMs > getServerTimeSec() * 1000) throw error('RANCH_UPGRADE_PENDING', '设施仍在升级中');
            plan.next = facilityMap.get(facilityMap.get(facility.facility_id)?.next_facility_id);
            if (!plan.next) throw error('RANCH_CONFIG_UNKNOWN', '建筑目标等级配置尚未同步');
        }
    } else if (action === 'claimTasks') {
        const tasks = taskList(await rpc('tasks', { global_scene_id: 2 }));
        const wanted = input.all === true ? tasks.filter((task: any) => task.canClaim) : [tasks.find((task: any) => task.id === positiveId(input.taskId, '任务'))];
        if (wanted.some((task: any) => !task?.canClaim)) throw error('RANCH_TASK_UNAVAILABLE', '任务尚未完成或已领取');
        plan.tasks = wanted;
        plan.marker = wanted.map((task: any) => ({ id: task.id, multiple: input.double === false ? 1 : Math.max(1, task.shareMultiple), rewards: task.rewards }));
        plan.count = wanted.length;
        for (const task of plan.marker) plan.expectedRewards.push(...task.rewards.map((item: any) => itemDto({ id: item.id, count: BigInt(item.count) * BigInt(task.multiple) })));
    } else if (action === 'reportEntry') {
        if (input.entry !== 'friends') throw error('INVALID_ARGUMENT', '该任务入口尚未验证');
        const tasks = taskList(await rpc('tasks', { global_scene_id: 2 }));
        plan.reportTasks = tasks.filter((task: any) => isClientReportedTask(task))
            .map((task: any) => ({ id: task.id, progress: task.total }));
        plan.payload = plan.reportTasks.map((task: any) => ({ task_id: task.id, progress: task.progress }));
        plan.route = 'reportTask';
        plan.marker = plan.reportTasks.map((task: any) => task.id);
        plan.count = plan.reportTasks.length;
    } else if (action === 'claimIllustrated') {
        plan.bookClaim = await require('./book').prepareBookClaim(input.kind);
        plan.label = plan.bookClaim.kind === 'normal' ? '领取牧场普通图鉴奖励' : '领取牧场巨大图鉴奖励';
        plan.marker = { kind: plan.bookClaim.kind, ids: plan.bookClaim.ids, rewards: plan.bookClaim.rewards };
        plan.expectedRewards = plan.bookClaim.rewards;
        plan.count = plan.bookClaim.count;
    } else if (action === 'claimDailyShare') {
        const state = await require('./daily-share').prepare();
        plan.count = state.claimed ? 0 : 1;
        plan.marker = { dateKey: state.dateKey };
        plan.expectedRewards = state.claimed ? [] : state.rewards;
    } else if (action === 'exchange') {
        const current = await market(raw);
        if (input.marketRotation && (current.periodDay !== input.marketRotation.periodDay
            || current.roundIndex !== input.marketRotation.roundIndex || getServerTimeSec() >= input.marketRotation.endsAt)) {
            throw error('RANCH_OFFER_CHANGED', '集市场次已变化或已结束');
        }
        const id = positiveId(input.goodsId, '兑换商品');
        const count = positiveCount(input.count);
        const good = current.goods.find((entry: any) => entry.id === id);
        if (!good?.available || (good.remaining !== null && count > good.remaining)) throw error('RANCH_EXCHANGE_UNAVAILABLE', '集市已离场、商品受限或限购已用完');
        plan.payload = { goods_id: id, count, period_day: current.periodDay, round_index: current.roundIndex };
        plan.costItems = [itemDto({ id: good.price.id, count: BigInt(good.price.count) * BigInt(count) })];
        plan.expectedRewards = [itemDto({ id: good.reward.id, count: BigInt(good.reward.count) * BigInt(count) })];
    }
    plan.costItems = sumItems(plan.costItems).filter((item: any) => BigInt(item.count) > 0n);
    plan.expectedRewards = sumItems(plan.expectedRewards);
    plan.costs = plan.costItems.map((item: any) => ({ resourceKey: `item:${item.id}`, amount: item.count }));
    plan.balances = [];
    for (const item of plan.costItems) plan.balances.push(await resourceBalance(raw, item.id));
    for (let index = 0; index < plan.costs.length; index++) {
        const available = BigInt(plan.balances[index].total) - BigInt(plan.balances[index].locked);
        if (available < BigInt(plan.costs[index].amount)) throw error('INSUFFICIENT_BALANCE', `${plan.costItems[index].name}不足`);
    }
    plan.signature = JSON.stringify({ action, payload: plan.payload, costs: plan.costs, rewards: plan.expectedRewards, marker: plan.marker });
    return plan;
}

async function prepareAction(action: string, input: any = {}): Promise<any> {
    if (action === 'steal') return require('./friends').prepareSteal(input);
    if (['stroke', 'putMosquito', 'cleanFriend'].includes(action)) return require('./friends').prepareInteraction(action, input);
    return inScene(async (cells: any) => {
        const plan = await planAction(action, input, action === 'claimIllustrated' ? null : await loadRaw(cells));
        return { action, label: plan.label, costs: plan.costs, costItems: plan.costItems, rewards: plan.expectedRewards, count: plan.count,
            expected: { signature: plan.signature }, skipped: plan.count === 0, message: plan.message };
    });
}

function unknown(action: string, reason: string): never {
    throw error('RANCH_RESULT_UNKNOWN', `${LABELS[action]}结果未能确认：${reason}，请刷新核对，勿重复提交`);
}

function cellsFromReceipt(cells: any, reply: any): any {
    const ranches = new Map<string, any>(reply.ranches.map((ranch: any) => [quantity(ranch.ranch_inst_id), ranch]));
    if (!ranches.size || reply.op_results.some((row: any) => !ranches.has(quantity(row.facility_inst_id)))) return undefined;
    let matched = 0;
    const facilities = cells.facilities.map((facility: any) => {
        const ranch = ranches.get(quantity(facility.instance_id));
        if (!ranch) return facility;
        matched++;
        return { ...facility, ranch };
    });
    return matched === ranches.size ? { ...cells, facilities } : undefined;
}

function animalsInResults(ranches: any[], rows: any[]): any[] {
    const ids = new Set(rows.filter(row => row.kind === 1).map(row => `${quantity(row.facility_inst_id)}:${quantity(row.target_id)}`));
    return ranches.flatMap(ranch => ranch.animals.filter((animal: any) => ids.has(`${quantity(ranch.ranch_inst_id)}:${animal.animal_inst_id}`)));
}

async function operate(action: string, input: any = {}): Promise<any> {
    if (['stroke', 'putMosquito', 'cleanFriend'].includes(action)) return require('./friends').interact(action, input);
    if (action === 'acknowledge') return inScene(async () => {
        reservations.forCurrentAccount().acknowledge(String(input.id));
        require('./automation').resetSchedule();
        return { status: 'confirmed', refreshRequired: true, costs: [], rewards: [] };
    });
    if (action === 'steal') return require('./friends').steal(input);

    async function run(action: string, input: any, before: any, produceTargets?: any[]): Promise<any> {
        const direct = input.direct === true && input.expected === undefined && DIRECT_ACTIONS.has(action);
        const plan = await planAction(action, input, before, produceTargets);
        if (plan.count === 0) return { status: 'skipped', snapshot: snapshot(before), costs: [], rewards: [], notice: plan.message };
        if (!direct && input.expected?.signature !== plan.signature) throw error('RANCH_OFFER_CHANGED', '牧场状态、商品或费用已变化，请重新确认');
        let after: any = null;
        let fedResults: any[] = [];
        const result = await reservations.forCurrentAccount().spend({ target: `ranch:${action}:${input.goodsId || input.facilityId || input.uid || input.taskId || input.ranchId || 'all'}`, label: plan.label, costs: plan.costs, balances: plan.balances }, async () => {
            let reply: any; let rewards: any[] = []; let actualCosts = plan.costItems;
            let completed = plan.count;
            if (action === 'claimDailyShare') {
                const claimed = await require('./daily-share').claim();
                rewards = claimed.rewards;
                reply = { alreadyClaimed: claimed.skipped };
            } else if (action === 'claimIllustrated') {
                const claimed = await require('./book').claimBook(plan.bookClaim);
                rewards = claimed.rewards;
                completed = claimed.completed;
                reply = {};
            } else if (action === 'reportEntry') {
                for (const entry of plan.reportTasks) {
                    reply = await rpc('reportTask', { task_id: entry.id, progress: entry.progress }, true);
                    if (!taskList(reply).find((task: any) => task.id === entry.id)?.canClaim) unknown(action, '引导任务未完成');
                }
            } else if (action === 'claimTasks') {
                const allOrdinary = plan.marker.every((task: any) => task.multiple === 1);
                if (plan.tasks.length > 1 && allOrdinary) {
                    reply = await rpc('claimTasks', { ids: plan.tasks.map((task: any) => task.id) }, true);
                    if (taskList(reply).some((task: any) => plan.tasks.some((chosen: any) => chosen.id === task.id) && !task.claimed)) unknown(action, '任务仍显示未领取');
                    rewards.push(...reply.items);
                } else {
                    for (const task of plan.marker) {
                        if (task.multiple > 1) {
                            const shared = await rpc('reportShare', { share_id: 103, params: [task.id], doc_id: 2104 }, true);
                            require('../../utils/network').applyShareInfos(shared.share_infos);
                        }
                        reply = await rpc('claimTask', { id: task.id, do_shared: task.multiple > 1 }, true);
                        const remaining = taskList(reply).find((row: any) => row.id === task.id);
                        if (remaining && !remaining.claimed) unknown(action, '任务仍显示未领取');
                        rewards.push(...reply.items);
                    }
                }
                if (signature(rewards) !== signature(plan.expectedRewards)) unknown(action, '任务奖励不匹配');
            } else {
                reply = await rpc(plan.route, plan.payload, true);
                if (action === 'buyCan') {
                    if (!reply.success || quantity(reply.goods_id) !== plan.payload.goods_id || signature(reply.reward_items) !== signature(plan.expectedRewards)) unknown(action, '商品或奖励不匹配');
                    rewards = reply.reward_items;
                } else if (action === 'buy') {
                    if (quantity(reply.goods?.id) !== plan.payload.goods_id || signature(reply.cost_items) !== signature(plan.costItems)) unknown(action, '商品或扣费不匹配');
                    // 自动放养返回放养经验，幼崽是否到账通过后续栏位状态确认。
                    if (!plan.autoPlaceAnimalId && signature(reply.get_items) !== signature(plan.expectedRewards)) unknown(action, '入包物品不匹配');
                    rewards = reply.get_items;
                } else if (action === 'sell') {
                    const sold = (items: any[]) => items.map(item => `${quantity(item.id)}:${quantity(item.uid)}:${quantity(item.count)}`).sort().join('|');
                    if (sold(reply.sell_items) !== sold(plan.payload.items) || signature(reply.get_items) !== signature(plan.expectedRewards)) unknown(action, '出售物品或收益不匹配');
                    rewards = reply.get_items;
                } else if (action === 'exchange') {
                    if (quantity(reply.card?.goods_id) !== plan.payload.goods_id || signature(reply.awards) !== signature(plan.expectedRewards)) unknown(action, '兑换商品或奖励不匹配');
                    rewards = reply.awards;
                } else if (action === 'feed') {
                    const used = BigInt(quantity(reply.deduct_secs));
                    const cap = BigInt(plan.costItems[0].count);
                    if (used <= 0n || used > cap || BigInt(quantity(reply.bucket_remain_secs)) !== BigInt(balance(before.bag, plan.bucketId).total) - used) unknown(action, '罐头消耗或余量不匹配');
                    actualCosts = [itemDto({ id: plan.bucketId, count: used })];
                    fedResults = reply.op_results;
                } else if (action === 'activateShed') {
                    const shed = reply.facility;
                    if (quantity(shed?.instance_id) !== plan.payload.instance_id || shed.facility_id !== plan.marker
                        || shed.module_type !== 7 || shed.state !== 1 || !shed.ranch) unknown(action, '棚的激活状态不匹配');
                } else if (action === 'upgrade') {
                    if (quantity(reply.upgrade?.inst_id) !== plan.payload.inst_id || reply.upgrade.target_level !== plan.next.level || reply.upgrade.target_facility_id !== plan.next.facility_id) unknown(action, '建筑升级目标不匹配');
                } else if (action === 'completeUpgrade') {
                    if (quantity(reply.facility?.instance_id) !== plan.payload.inst_id || reply.facility.level !== plan.next.level || reply.facility.facility_id !== plan.next.facility_id) unknown(action, '建筑等级不匹配');
                } else if (action === 'release') {
                    const target = plan.payload.targets[0];
                    const result = reply.op_results[0];
                    const ranch = reply.ranches.find((row: any) => quantity(row.ranch_inst_id) === target.ranch_inst_id);
                    if (reply.op_results.length !== 1 || !result || result.kind !== 1 || quantity(result.facility_inst_id) !== target.ranch_inst_id
                        || quantity(result.target_id) !== String(target.animal_inst_id) || result.costs.length
                        || !ranch || ranch.animals.some((animal: any) => animal.animal_inst_id === target.animal_inst_id)
                        || result.rewards.some((item: any) => BigInt(quantity(item.count)) <= 0n)) unknown(action, '放生目标或栏位变化不匹配');
                    rewards = result.rewards;
                } else if (reply.op_results) {
                    rewards = reply.op_results.flatMap((result: any) => result.rewards);
                    if (action === 'place' && reply.op_results.length !== plan.count) unknown(action, '放养数量不匹配');
                    if (plan.resultKeys) {
                        const keys = reply.op_results.map((row: any) => `${quantity(row.facility_inst_id)}:${row.kind}:${quantity(row.target_id)}`);
                        if (new Set(keys).size !== keys.length) unknown(action, '回包包含重复目标');
                        for (const [index, key] of keys.entries()) {
                            if (plan.resultKeys.includes(key)) continue;
                            const row = reply.op_results[index];
                            const facilityId = quantity(row.facility_inst_id);
                            const targetId = quantity(row.target_id);
                            // 一键操作以服务端执行时的状态为准，可能包含读取后刚成熟的动物、产物或新污物。
                            if (action === 'clean' && row.kind === 3 && BigInt(targetId) > 0n && plan.payload.ranch_inst_ids.includes(facilityId)) continue;
                            if (input.all === true && (action === 'harvest' || action === 'produce')) {
                                const ranch = before.cells.facilities.find((f: any) => quantity(f.instance_id) === facilityId)?.ranch;
                                if (row.kind === 1 && ranch?.animals.some((animal: any) => quantity(animal.animal_inst_id) === targetId)) continue;
                                if (action === 'harvest' && row.kind === 2 && ranch && BigInt(targetId) > 0n && BigInt(targetId) <= BigInt(ranch.capacity)) continue;
                            }
                            unknown(action, '回包目标超出本次操作范围');
                        }
                    }
                }
            }
            let receiptCells = direct ? cellsFromReceipt(before.cells, reply) : undefined;
            if (direct && action === 'produce') {
                const produced = animalsInResults(reply.ranches, reply.op_results);
                const deadline = Math.max(0, ...produced.map(animal => Number(animal.delivering_until_ms)));
                if (deadline > 0) {
                    // 货架上架晚于生产回包，在原场景等待交付后读一次格子。
                    await wait(Math.min(2500, Math.max(0, deadline - getServerTimeSec() * 1000)));
                    receiptCells = undefined;
                }
            }
            try { after = await loadRaw(receiptCells); } catch { /* Confirmed receipts remain useful if the view refresh fails. */ }
            if (plan.autoPlaceAnimalId) {
                if (!after) unknown(action, '自动放养后的栏位状态未能读取');
                const previous = new Set(before.cells.facilities.flatMap((f: any) => (f.ranch?.animals || []).map((animal: any) => `${quantity(f.instance_id)}:${animal.animal_inst_id}`)));
                const placed = after.cells.facilities.flatMap((f: any) => (f.ranch?.animals || []).filter((animal: any) => !previous.has(`${quantity(f.instance_id)}:${animal.animal_inst_id}`)));
                if (placed.length !== plan.payload.num || placed.some((animal: any) => Number(animal.animal_id) !== plan.autoPlaceAnimalId)) unknown(action, '自动放养的动物或数量不匹配');
            }
            if (['place', 'addGrass', 'useCan', 'exchange', 'buyCan'].includes(action)) {
                if (!after) unknown(action, '操作后的库存未能读取');
                for (const cost of plan.costItems) {
                    const actual = BigInt((await resourceBalance(before, cost.id)).total) - BigInt((await resourceBalance(after, cost.id)).total);
                    if (actual !== BigInt(cost.count)) unknown(action, '库存扣减与费用不匹配');
                }
                if (action === 'useCan' && BigInt(balance(after.bag, plan.bucketId).total) - BigInt(balance(before.bag, plan.bucketId).total) !== plan.expectedSeconds) unknown(action, '罐头桶增加时长不匹配');
            }
            completed = reply.op_results?.length ?? completed;
            const skipped = reply.alreadyClaimed || direct && plan.resultKeys && !completed;
            const notice = action === 'release' || action === 'sell' && input.all !== true ? `${plan.label}完成${rewards.length ? `，获得 ${sumItems(rewards).map((item: any) => `${item.name} ×${item.count}`).join('、')}` : ''}`
                : plan.resultKeys && completed < plan.count ? `已完成 ${completed} / ${plan.count} 项，其余状态已变化，请刷新核对` : undefined;
            return { status: skipped ? 'skipped' : 'confirmed', snapshot: after ? snapshot(after) : null, refreshRequired: !after, costs: actualCosts, notice,
                rewards: sumItems(rewards), completed,
                bucketRemainingSeconds: action === 'feed' ? quantity(reply.bucket_remain_secs) : undefined,
                harvestedAnimals: action === 'harvest' ? reply.op_results.filter((entry: any) => entry.kind === 1).length : 0,
                harvestedGiant: action === 'harvest' && animalsInResults(before.cells.facilities.flatMap((f: any) => f.ranch ? [f.ranch] : []), reply.op_results)
                    .some(animal => animal.mutation?.mutation_type > 0) };
        });

        if (result.harvestedGiant) require('../../utils/network').networkEvents.emit('ranchBookReward', 'giant', true);
        if (!direct || action !== 'feed' || input.produceAfterFeed !== true || result.status !== 'confirmed') return result;
        if (!after) throw error('RANCH_STATE_CHANGED', '喂养已完成，未能读取栏舍状态，未发起生产');
        const fedTargets = new Set(plan.payload.targets.map((target: any) => `${target.ranch_inst_id}:${target.animal_inst_id}`));
        const ready = animalsInResults(after.cells.facilities.flatMap((facility: any) => facility.ranch ? [facility.ranch] : []), fedResults)
            .filter((animal: any) => animal.can_deliver && fedTargets.has(`${quantity(animal.ranch_inst_id)}:${animal.animal_inst_id}`));
        if (!ready.length) return result;

        // 喂养已独立确认。沿用当前场景，只为本次喂养后进入可生产状态的动物发起生产。
        try {
            const production = await run('produce', { direct: true }, after, ready);
            return { ...result, snapshot: production.snapshot || result.snapshot, refreshRequired: production.refreshRequired,
                autoProduced: production.completed, autoProductionNotice: production.notice };
        } catch (cause: any) {
            const status = cause.outcomeUnknown || cause.code === 'RANCH_RESULT_UNKNOWN' ? '生产结果未知' : '生产未完成';
            const reason = cause.name === 'GatewayError' ? cause.errorMessage || '游戏服务拒绝生产' : cause.message;
            const message = `喂养已完成，${status}：${reason}。请刷新核对，勿重复喂养`;
            throw Object.assign(error(cause.code || 'RANCH_PRODUCTION_FAILED', message), { errorMessage: message, cause });
        }
    }

    return inScene((cells: any) => reservations.forCurrentAccount().withLock(async () => run(action, input, await loadRaw(cells))));
}

module.exports = { prepareAction, operate, ACTIONS, planAction };
