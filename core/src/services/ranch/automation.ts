import type { RanchAutomationConfig } from '../../config/ranch-automation';
import type { RanchFriend } from './friend-roster';
import type { FriendPatrolProgress } from './friends';
import { getRanchFriendList } from './friend-roster';
export {};

const { RANCH_SWITCH_KEYS, RANCH_MARKET_SWITCH_KEYS, isRanchMarketEnabled } = require('../../config/ranch-automation');
const { getAutomation, getFriendBlacklist } = require('../../models/store');
const { inScene, isUnlocked } = require('./transport');
const { loadRaw, shedAwaitingActivation, snapshot, inventory, catalog, market, readMarketRotation, balance } = require('./state');
const { cubMap, quantity } = require('./model');
const { prepareAction, operate } = require('./actions');
const { getServerTimeSec, log } = require('../../utils/utils');
const { getShopGoodsById } = require('../../config/gameConfig');
const reservations = require('./operation-state');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const daily = require('./daily');
const interactions = require('./friends');

let nextCheckAt = 0;
let nextFriendIndex = 0;
let friendVisits = 0;
let pendingFriend: { gid: string; progress: FriendPatrolProgress } | null = null;
let patrolFriends: RanchFriend[] | null = null;
let cycleStartedAt = 0;
let cycleChanged = false;
let ownRecheckUsed = false;
const completedPhases = new Set<string>();
const completedSteps = new Set<string>();
const pendingBookKinds = new Set<'normal' | 'giant'>();
const PATROL_SLICE_MS = 5000;
const SCENE_REENTRY_MS = 20_000;
const MARKET_EXCHANGES = [
    { key: 'ranch_market_organic_poop', currencyId: 7002, rewardPriority: [80012, 80011], minBalance: 3n },
    { key: 'ranch_market_organic_pinecone', currencyId: 1008, rewardPriority: [80013, 80012, 80011], minBalance: 1n },
];
type MarketRotation = { periodDay: string; roundIndex: number; startsAt: number; endsAt: number; present: boolean };
let marketCheckPending = true;
let marketRunId = 0;
let lastMarketRotation: MarketRotation | null = null;
const lastMarketBalances = new Map<number, bigint>();

function resetCycle(keepFriendProgress = false): void {
    completedPhases.clear();
    completedSteps.clear();
    pendingBookKinds.clear();
    if (!keepFriendProgress) {
        friendVisits = 0;
        pendingFriend = null;
        patrolFriends = null;
    }
    cycleStartedAt = 0;
    cycleChanged = false;
    ownRecheckUsed = false;
}
const FRIEND_CONTROLS: Record<string, string> = { stroke: 'ranch_stroke', steal: 'ranch_friend_steal', cleanFriend: 'ranch_friend_clean', putMosquito: 'ranch_friend_mosquito' };
const enabled = (key: string) => getAutomation()[key] === true;
const canInteract = (action: string) => enabled(FRIEND_CONTROLS[action]) && !interactions.getInteractionQuotaResetAt(action);
function marketRotation(raw: any): MarketRotation {
    return { periodDay: quantity(raw.period_day), roundIndex: raw.round_index, startsAt: Number(raw.shop_start_time),
        endsAt: Number(raw.shop_end_time), present: raw.present };
}

function sameMarketRound(a: Pick<MarketRotation, 'periodDay' | 'roundIndex'>, b: MarketRotation): boolean {
    return a.periodDay === b.periodDay && a.roundIndex === b.roundIndex;
}

function marketIsOpen(rotation: MarketRotation | null): rotation is MarketRotation {
    const now = getServerTimeSec();
    return !!rotation?.present && rotation.startsAt <= now && now < rotation.endsAt;
}

function requestMarketCheck(): void {
    marketCheckPending = true;
    marketRunId++;
    completedPhases.delete('market-organic');
}

function noteMarketVisit(raw: any): boolean {
    const rotation = marketRotation(raw);
    const previous = lastMarketRotation;
    if (previous && sameMarketRound(previous, rotation) && previous.present === rotation.present
        && previous.startsAt === rotation.startsAt && previous.endsAt === rotation.endsAt) return false;
    lastMarketRotation = rotation;
    if (!marketIsOpen(rotation)) {
        marketRunId++;
        return false;
    }
    requestMarketCheck();
    return true;
}
const due = (state: any) => !state.doneToday && Date.now() >= (state.nextCheckAt || 0);

function getRoutineState(): any {
    if (!isUnlocked()) return { doneToday: true, nextCheckAt: Infinity };
    const auto = getAutomation();
    const strokeReset = auto.ranch_stroke ? interactions.getInteractionQuotaResetAt('stroke') : 0;
    const mosquitoReset = auto.ranch_friend_mosquito ? interactions.getInteractionQuotaResetAt('putMosquito') : 0;
    const work = auto.ranch_stroke && !strokeReset || auto.ranch_friend_mosquito && !mosquitoReset
        || RANCH_SWITCH_KEYS.some((key: string) => ![
            'ranch_task', 'ranch_illustrated', 'ranch_share', 'ranch_daily_benefit', 'ranch_grass_buy', 'ranch_market_organic', ...RANCH_MARKET_SWITCH_KEYS, 'ranch_stroke', 'ranch_friend_mosquito',
        ].includes(key) && auto[key]);
    const routineDue = work || auto.ranch_task && due(daily.getTaskRoutineState()) || auto.ranch_share && due(daily.getShareRoutineState()) || auto.ranch_daily_benefit && due(daily.getBenefitRoutineState());
    const pending = routineDue || isRanchMarketEnabled(auto) && marketCheckPending;
    return {
        doneToday: !pending,
        nextCheckAt: pending ? nextCheckAt : Math.min(strokeReset || Infinity, mosquitoReset || Infinity),
    };
}

function selectAnimal(goods: any[], settings: RanchAutomationConfig, kind: number): any {
    const strategy = settings.ranch_strategy === 'bag_priority' ? settings.ranch_bag_fallback : settings.ranch_strategy;
    const preferred = kind === 1 ? settings.ranch_coop_animal : settings.ranch_shed_animal;
    const candidates = goods.filter(good => good.available && good.animal?.enable_flag
        && good.animal.husbandry_type === (kind === 1 ? '窝' : '棚') && good.price.id === 1007 && BigInt(good.price.count) > 0n);
    if (strategy === 'preferred') return candidates.find(good => good.animal.id === preferred);
    const level = (good: any) => Number(getShopGoodsById(Number(good.id))?.conds?.match(/:(\d+)$/)?.[1] || good.requiredLevel || 0);
    return candidates.sort((a, b) => level(b) - level(a) || b.animal.id - a.animal.id)[0];
}

async function run(options: { farmDeadline?: () => number; canContinue?: () => boolean } = {}): Promise<void> {
    if (getRoutineState().doneToday) return;
    const auto: RanchAutomationConfig = getAutomation();
    if (!cycleStartedAt) cycleStartedAt = Date.now();
    nextCheckAt = cycleStartedAt + auto.ranch_check_minutes * 60_000;
    try {
        if (options.canContinue?.() === false || Date.now() >= (options.farmDeadline?.() ?? Infinity)) {
            nextCheckAt = Date.now() + SCENE_REENTRY_MS;
            return;
        }
        await inScene(async (cells: any) => {
            const startedAt = Date.now();
            let steps = 0;
            const markStep = (action?: string) => {
                steps++;
                if (action !== 'harvest' && action !== 'produce') ownRecheckUsed = false;
            };
            const shouldYield = (friendActed = false) => options.canContinue?.() === false
                || Date.now() >= (options.farmDeadline?.() ?? Infinity)
                || (steps > 0 || friendActed) && Date.now() >= startedAt + PATROL_SLICE_MS;
            const checkpoint = (checkDeadline = false) => {
                if (shouldYield(checkDeadline)) {
                    throw Object.assign(new Error('牧场巡查让路'), { code: 'RANCH_PATROL_YIELD' });
                }
            };
            async function phase(name: string, work: () => Promise<any>): Promise<void> {
                if (completedPhases.has(name)) return;
                await work();
                completedPhases.add(name);
            }
            checkpoint();
            let raw = await loadRaw(cells);
            let nextActionAt = Infinity;
            const updateDeadline = (reopenOwn = false) => {
                const state = snapshot(raw);
                const upcoming = state.facilities.flatMap((f: any) => [
                    ...(auto.ranch_harvest || auto.ranch_produce ? (f.ranch?.animals || []).map((a: any) => a.nextAtMs) : []),
                    auto.ranch_upgrade && f.upgradeState ? (f.upgradeEndTime < 100_000_000_000 ? f.upgradeEndTime * 1000 : f.upgradeEndTime) : 0,
                ]).filter((at: any) => at > state.serverTime);
                nextActionAt = upcoming.length ? Date.now() + Math.min(...upcoming) - state.serverTime : Infinity;
                for (const [action, flag] of [['harvest', 'can_harvest'], ['produce', 'can_deliver']]) {
                    const ready = raw.cells.facilities.some((f: any) => f.ranch?.animals.some((a: any) => a[flag])
                        || action === 'harvest' && f.ranch?.shelves.some((s: any) => s.can_collect));
                    if (ready && enabled(action === 'harvest' ? 'ranch_harvest' : 'ranch_produce')) {
                        if (reopenOwn && completedPhases.delete(action)) {
                            completedSteps.delete(`${action}:{"all":true}`);
                            ownRecheckUsed = true;
                        }
                        nextActionAt = Math.min(nextActionAt, Date.now());
                    }
                }
            };
            // 已完成的产出可以提前复查，随后先给本轮的其他待办一次执行机会。
            updateDeadline(!ownRecheckUsed);
            const available = (id: number) => {
                const funds = balance(raw.bag, id);
                return BigInt(funds.total) - BigInt(funds.locked) - BigInt(reservations.forCurrentAccount().reserved(`item:${id}`));
            };
            const affordable = (good: any, wanted: number) => {
                const money = available(good.price.id);
                const count = money > 0n ? money / BigInt(good.price.count) : 0n;
                return Number(count < BigInt(wanted) ? count : BigInt(wanted));
            };
            async function act(key: string, action: string, input: any = {}, currency?: number, progress?: string, expectedRewardId?: number): Promise<boolean> {
                const isEnabled = () => enabled(key) && (key !== 'ranch_grass_buy' || enabled('ranch_grass'));
                if (!isEnabled()) return false;
                const step = `${action}:${JSON.stringify(input)}${progress === undefined ? '' : `:${progress}`}`;
                if (completedSteps.has(step)) return false;
                checkpoint(action === 'exchange');
                let label = action;
                try {
                    const quote = await prepareAction(action, input);
                    label = quote.label;
                    if (quote.skipped || currency && quote.costItems.some((cost: any) => cost.id !== currency)
                        || expectedRewardId !== undefined && (quote.rewards.length !== 1 || Number(quote.rewards[0].id) !== expectedRewardId)) {
                        completedSteps.add(step);
                        markStep(action);
                        return false;
                    }
                    if (!isEnabled()) return false;
                    checkpoint(action === 'exchange');
                    const parent = getAmbientSendContext();
                    const result = await runWithSendContext({
                        check: (service: string, method: string) => parent?.check(service, method) || (isEnabled() ? null
                            : Object.assign(new Error('牧场操作开关已关闭'), { code: 'RANCH_AUTOMATION_DISABLED' })),
                        onSent: (service: string, method: string) => parent?.onSent(service, method),
                    }, () => operate(action, { ...input, expected: quote.expected }));
                    completedSteps.add(step);
                    markStep(action);
                    if (result.status === 'skipped') return false;
                    if (action === 'harvest' && result.harvestedAnimals > 0 && enabled('ranch_illustrated')) {
                        for (const kind of ['normal', 'giant'] as const) {
                            pendingBookKinds.add(kind);
                            completedSteps.delete(`claimIllustrated:${JSON.stringify({ kind })}`);
                        }
                    }
                    cycleChanged = true;
                    log('牧场', `${quote.label}${result.notice ? `：${result.notice}` : '完成'}`, { module: 'ranch', event: `ranch_${action}`, result: 'ok' });
                    raw = await loadRaw();
                    updateDeadline();
                    return true;
                } catch (error: any) {
                    // 状态或余额变化交给下一次巡查重新报价；已发出但结果未知的写入由持久账本保护。
                    if (['INSUFFICIENT_BALANCE', 'RESERVE_PROTECTED', 'PENDING_CONFIRMATION', 'RANCH_OFFER_CHANGED', 'RANCH_EXCHANGE_UNAVAILABLE', 'GOODS_UNAVAILABLE', 'RANCH_STATE_CHANGED'].includes(error.code)) {
                        completedSteps.add(step);
                        markStep(action);
                        log('牧场', `${label} 暂未执行：${error.message}`, { module: 'ranch', event: `ranch_${action}`, result: 'skipped' });
                        return false;
                    }
                    throw error;
                }
            }

            await phase('harvest', async () => {
                if (await act('ranch_harvest', 'harvest', { all: true })) completedPhases.delete('buy');
            });
            await phase('produce', () => act('ranch_produce', 'produce', { all: true }));
            await phase('clean', () => act('ranch_clean', 'clean'));
            await phase('sell', () => act('ranch_sell', 'sell', { all: true }));

            if (isRanchMarketEnabled(auto) && marketCheckPending) completedPhases.delete('market-organic');
            await phase('market-organic', async () => {
                if (!isRanchMarketEnabled(getAutomation())) return;
                const stockReady = MARKET_EXCHANGES.some(({ key, currencyId, minBalance }) => {
                    const stock = available(currencyId);
                    return enabled(key) && stock >= minBalance && stock > (lastMarketBalances.get(currencyId) ?? 0n);
                });
                if (!marketCheckPending && !stockReady && marketIsOpen(lastMarketRotation)) return;
                checkpoint(true);
                const runId = marketRunId;
                const rawRotation = await readMarketRotation();
                let rotation = rawRotation ? marketRotation(rawRotation) : null;
                let current = null;
                if (marketIsOpen(rotation)) {
                    checkpoint(true);
                    current = await market(raw);
                }
                if (current && marketIsOpen(rotation) && current.opened && current.present && sameMarketRound(current, rotation)) {
                    for (const { key, currencyId, rewardPriority } of MARKET_EXCHANGES) {
                        if (!enabled(key)) continue;
                        const goods = current.goods.filter((entry: any) => entry.available && Number(entry.price.id) === currencyId
                            && BigInt(entry.price.count) > 0n && rewardPriority.includes(Number(entry.reward.id)));
                        goods.sort((a: any, b: any) => rewardPriority.indexOf(Number(a.reward.id)) - rewardPriority.indexOf(Number(b.reward.id)));
                        for (const good of goods) {
                            while (enabled(key) && good.remaining !== 0 && marketIsOpen(rotation)) {
                                const stock = available(currencyId);
                                const count = affordable(good, Math.min(good.remaining ?? 2147483647, 2147483647));
                                if (count < 1) break;
                                const exchanged = await act(key, 'exchange', { goodsId: good.id, count, marketRotation: rotation },
                                    currencyId, `${runId}:${good.id}:${stock}`, Number(good.reward.id));
                                if (!exchanged) break;
                                if (good.remaining !== null) good.remaining = Math.max(0, good.remaining - count);
                            }
                        }
                    }
                } else if (current) rotation = null;
                for (const { currencyId } of MARKET_EXCHANGES) lastMarketBalances.set(currencyId, available(currencyId));
                // 旧一轮结束时保留执行期间收到的到访或到账待办。
                if (runId === marketRunId) {
                    lastMarketRotation = rotation;
                    marketCheckPending = false;
                }
            });

            const shed = enabled('ranch_upgrade') && shedAwaitingActivation(raw);
            if (shed) await act('ranch_upgrade', 'activateShed', { facilityId: quantity(shed.instance_id) });

            await phase('upgrade', async () => {
                if (enabled('ranch_upgrade')) {
                    for (const facility of snapshot(raw).facilities) {
                        const end = facility.upgradeEndTime < 100_000_000_000 ? facility.upgradeEndTime * 1000 : facility.upgradeEndTime;
                        if (facility.active && facility.upgradeState && (facility.upgradeState === 2 || end <= getServerTimeSec() * 1000)) {
                            await act('ranch_upgrade', 'completeUpgrade', { facilityId: facility.id });
                        } else if (facility.next?.available) {
                            await act('ranch_upgrade', 'upgrade', { facilityId: facility.id }, 1007);
                        }
                    }
                }
            });

            // 成熟动物腾栏后，在补栏前核对一次。让路时保留尚未核对的图鉴。
            for (const kind of pendingBookKinds) {
                await act('ranch_illustrated', 'claimIllustrated', { kind });
                pendingBookKinds.delete(kind);
            }

            if (enabled('ranch_buy')) {
                const bagFirst = auto.ranch_strategy === 'bag_priority';
                const pens: any[] = raw.cells.facilities.filter((f: any) => f.state === 1 && f.ranch?.animal_count < f.ranch?.capacity);
                const vacancies = (id: string) => {
                    const ranch = raw.cells.facilities.find((f: any) => quantity(f.instance_id) === id)?.ranch;
                    return ranch ? Math.max(0, ranch.capacity - ranch.animal_count) : 0;
                };
                async function placeCubs(pen: any, animalId?: number): Promise<boolean> {
                    const ranchId = quantity(pen.instance_id);
                    const isCoop = pen.ranch.husbandry_type === 1;
                    const ordered = isCoop ? auto.ranch_coop_cub_priority : auto.ranch_shed_cub_priority;
                    const ranks = new Map(ordered.map((id, index) => [id, index]));
                    const stock = inventory(raw).filter((item: any) => !item.locked && item.animalId && BigInt(item.count) > 0n
                        && cubMap.get(item.id).husbandry_type === (isCoop ? '窝' : '棚') && (bagFirst || item.animalId === animalId));
                    stock.sort((a: any, b: any) => (bagFirst ? (ranks.get(a.id) ?? ordered.length) - (ranks.get(b.id) ?? ordered.length) : 0)
                        || b.animalId - a.animalId || a.id - b.id);
                    for (const item of stock) {
                        const room = BigInt(vacancies(ranchId));
                        if (room === 0n) break;
                        const usable = available(item.id);
                        const count = Number(room < usable ? room : usable);
                        // 库存和空位重新确认后才能续放；已有未决操作时不转去购买同一栏位。
                        if (count > 0 && !await act('ranch_buy', 'place', { ranchId, itemId: item.id, count }, undefined, `${usable}:${room}`)) return false;
                    }
                    return true;
                }

                // 续跑也按最新空位放养。先处理两种设施的背包库存，之后才读取购买备选。
                const purchasePens = [];
                for (const pen of pens) {
                    if ((!bagFirst || await placeCubs(pen)) && vacancies(quantity(pen.instance_id)) > 0) purchasePens.push(pen);
                }
                if (purchasePens.length) await phase('buy', async () => {
                    checkpoint();
                    const shop = await catalog(raw, 5);
                    for (const pen of purchasePens) {
                        const selected = selectAnimal(shop.goods, auto, pen.ranch.husbandry_type);
                        if (!selected || !bagFirst && !await placeCubs(pen, selected.animal.id)) continue;
                        const id = quantity(pen.instance_id);
                        const count = affordable(selected, Math.min(vacancies(id), selected.maxCount, selected.remaining ?? Infinity));
                        if (count > 0) await act('ranch_buy', 'buy', { shopId: 5, goodsId: selected.id, count, autoPlace: true }, 1007, `${id}:${available(1007)}`);
                    }
                });
            }

            await phase('grass', async () => {
                if (enabled('ranch_grass')) {
                    for (const original of raw.cells.facilities.filter((f: any) => f.state === 1 && f.feed_machine)) {
                        const id = quantity(original.instance_id);
                        let room = original.capacity - original.feed_machine.feed_count;
                        if (room <= 0 || original.feed_machine.feed_count * 100 >= original.capacity * auto.ranch_grass_threshold_percent) continue;
                        let stock = Math.max(0, Number(available(7001)));
                        if (stock < room && enabled('ranch_grass_buy')) {
                            const shop = await catalog(raw, 6);
                            const good = shop.goods.find((g: any) => g.available && g.reward.id === 7001 && g.reward.count === '1' && g.price.id === 1007 && BigInt(g.price.count) > 0n);
                            if (good) {
                                while (stock < room) {
                                    const count = affordable(good, Math.min(room - stock, good.maxCount, good.remaining ?? Infinity));
                                    // 按已到账库存区分限购批次，续跑时重新读取缺额，沿用农场到期让路。
                                    if (count <= 0 || !await act('ranch_grass_buy', 'buy', { shopId: 6, goodsId: good.id, count }, 1007, `${id}:${stock}`)) break;
                                    if (good.remaining !== null) good.remaining -= count;
                                    const current = raw.cells.facilities.find((f: any) => quantity(f.instance_id) === id);
                                    room = current.capacity - current.feed_machine.feed_count;
                                    stock = Math.max(0, Number(available(7001)));
                                }
                            }
                        }
                        const count = Math.min(room, Number(available(7001)));
                        if (count > 0) await act('ranch_grass', 'addGrass', { facilityId: id, count });
                    }
                }
            });

            await phase('cans', async () => {
                if (enabled('ranch_fill_cans')) {
                    for (const item of inventory(raw).filter((item: any) => item.can && !item.locked)) {
                        const count = Number(BigInt(item.count) < available(item.id) ? BigInt(item.count) : available(item.id));
                        if (count > 0) await act('ranch_fill_cans', 'useCan', { uid: item.uid, count });
                    }
                }
            });

            await phase('feed-normal', async () => { if (enabled('ranch_feed_normal') && available(7003) > 0n) await act('ranch_feed_normal', 'feed', { all: true, bucketType: 2 }); });
            await phase('feed-organic', async () => { if (enabled('ranch_feed_organic') && available(7004) > 0n) await act('ranch_feed_organic', 'feed', { all: true, bucketType: 1 }); });

            async function claimDailyRewards(): Promise<void> {
                if (cycleChanged && !completedPhases.has('tasks')) daily.markTasksChanged();
                await phase('tasks', async () => { if (enabled('ranch_task') && due(daily.getTaskRoutineState())) { checkpoint(); await daily.claimTasks(); markStep(); } });
                await phase('share', async () => { if (enabled('ranch_share') && due(daily.getShareRoutineState())) { checkpoint(); await daily.claimShare(); markStep(); } });
                await phase('benefit', async () => { if (enabled('ranch_daily_benefit') && due(daily.getBenefitRoutineState())) { checkpoint(); await daily.claimBenefit(); markStep(); } });
            }
            // 大名单会跨多个切片，到期的每日奖励在继续巡查前先执行。
            if (pendingFriend || friendVisits > 0) await claimDailyRewards();
            await phase('friends', async () => {
                if (Object.keys(FRIEND_CONTROLS).some(canInteract)) {
                    checkpoint();
                    patrolFriends ??= await getRanchFriendList(completedBatch => {
                        if (completedBatch) markStep();
                        checkpoint();
                    });
                    const blacklist = new Set(getFriendBlacklist(process.env.FARM_ACCOUNT_ID));
                    const friends = patrolFriends.filter(friend => !blacklist.has(friend.gid));
                    if (!friends.length) return;
                    const hasBulkWork = enabled('ranch_friend_steal') || enabled('ranch_friend_clean');
                    const times = hasBulkWork ? {} : await interactions.getInteractionTimes();
                    const wanted = (action: string) => canInteract(action) && times[action] !== 0;
                    if (Object.keys(FRIEND_CONTROLS).some(wanted)) {
                        // 沿用本轮巡查，每轮最多拜访三位，避免长期占用农牧场共用连接。
                        for (; friendVisits < Math.min(3, friends.length) && Object.keys(FRIEND_CONTROLS).some(wanted); friendVisits++) {
                            checkpoint();
                            const friend = friends.find((row: any) => String(row.gid) === pendingFriend?.gid) || friends[nextFriendIndex % friends.length];
                            const gid = String(friend.gid);
                            if (pendingFriend?.gid !== gid) pendingFriend = { gid, progress: {} };
                            try {
                                const result = await interactions.automateFriend(friend.gid, wanted, shouldYield, (outcome: any, nickname: string) => {
                                    const confirmed = outcome.status === 'confirmed';
                                    if (confirmed) daily.markTasksChanged();
                                    ownRecheckUsed = false;
                                    log('牧场', `${nickname || friend.name}：${outcome.notice}`, {
                                        module: 'ranch', event: `ranch_${outcome.action}`, result: confirmed ? 'ok' : 'skipped',
                                    });
                                }, pendingFriend.progress);
                                Object.assign(times, result.times);
                                if (result.yielded) {
                                    throw Object.assign(new Error('牧场好友巡查让路'), { code: 'RANCH_PATROL_YIELD' });
                                }
                                markStep();
                            } catch (error: any) {
                                if (error.name !== 'GatewayError' || error.methodName !== 'EnterHomestead') throw error;
                                markStep();
                                log('牧场', `暂不能拜访 ${friend.name}：${error.message}`, { module: 'ranch', event: 'ranch_friend', result: 'skipped' });
                            }
                            pendingFriend = null;
                            nextFriendIndex++;
                        }
                    }
                }
            });

            await claimDailyRewards();
            nextCheckAt = Math.max(Date.now() + SCENE_REENTRY_MS, Math.min(nextCheckAt, nextActionAt, cycleChanged ? Date.now() + 30_000 : Infinity));
            resetCycle();
        });
    } catch (error: any) {
        if (error.code === 'RANCH_PATROL_YIELD') {
            nextCheckAt = Date.now() + SCENE_REENTRY_MS;
            return;
        }
        resetCycle(pendingFriend !== null);
        if (error.code === 'RANCH_AUTOMATION_DISABLED') return;
        nextCheckAt = Date.now() + Math.max(auto.ranch_check_minutes, 10) * 60_000;
        log('牧场', `日常牧场巡查失败：${error.message}`, { module: 'ranch', event: 'ranch_automation', result: 'error' });
    }
}

module.exports = {
    run, getRoutineState, selectAnimal, requestMarketCheck, noteMarketVisit,
    resetSchedule: () => {
        requestMarketCheck();
        nextCheckAt = 0;
        lastMarketRotation = null;
        lastMarketBalances.clear();
        resetCycle();
    },
};
