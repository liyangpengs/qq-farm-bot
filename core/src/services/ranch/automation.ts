import type { RanchAutomationConfig } from '../../config/ranch-automation';
export {};

const { RANCH_SWITCH_KEYS } = require('../../config/ranch-automation');
const { getAutomation } = require('../../models/store');
const { inScene, isUnlocked } = require('./transport');
const { loadRaw, snapshot, inventory, catalog, balance } = require('./state');
const { cubMap, quantity } = require('./model');
const { prepareAction, operate } = require('./actions');
const { getServerTimeSec, log } = require('../../utils/utils');
const { getShopGoodsById } = require('../../config/gameConfig');
const reservations = require('./operation-state');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const daily = require('./daily');

let nextCheckAt = 0;
let nextFriendIndex = 0;
const FRIEND_CONTROLS: Record<string, string> = { stroke: 'ranch_stroke', steal: 'ranch_friend_steal', cleanFriend: 'ranch_friend_clean', putMosquito: 'ranch_friend_mosquito' };
const enabled = (key: string) => getAutomation()[key] === true;
const due = (state: any) => !state.doneToday && Date.now() >= (state.nextCheckAt || 0);

function getRoutineState(): any {
    const auto = getAutomation();
    const work = RANCH_SWITCH_KEYS.some((key: string) => !['ranch_task', 'ranch_share', 'ranch_grass_buy'].includes(key) && auto[key]);
    return { doneToday: !isUnlocked() || !(work || auto.ranch_task && due(daily.getTaskRoutineState()) || auto.ranch_share && due(daily.getShareRoutineState())), nextCheckAt };
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

async function run(): Promise<void> {
    if (getRoutineState().doneToday) return;
    const auto: RanchAutomationConfig = getAutomation();
    nextCheckAt = Date.now() + auto.ranch_check_minutes * 60_000;
    try {
        await inScene(async (cells: any) => {
            let raw = await loadRaw(cells);
            let changed = false;
            const available = (id: number) => {
                const funds = balance(raw.bag, id);
                return BigInt(funds.total) - BigInt(funds.locked) - BigInt(reservations.forCurrentAccount().reserved(`item:${id}`));
            };
            const affordable = (good: any, wanted: number) => {
                const money = available(good.price.id);
                const count = money > 0n ? money / BigInt(good.price.count) : 0n;
                return Number(count < BigInt(wanted) ? count : BigInt(wanted));
            };
            async function act(key: string, action: string, input: any = {}, currency?: number): Promise<boolean> {
                const isEnabled = () => enabled(key) && (key !== 'ranch_grass_buy' || enabled('ranch_grass'));
                if (!isEnabled()) return false;
                try {
                    const quote = await prepareAction(action, input);
                    if (quote.skipped || currency && quote.costItems.some((cost: any) => cost.id !== currency)) return false;
                    if (!isEnabled()) return false;
                    const parent = getAmbientSendContext();
                    const result = await runWithSendContext({
                        check: (service: string, method: string) => parent?.check(service, method) || (isEnabled() ? null
                            : Object.assign(new Error('牧场操作开关已关闭'), { code: 'RANCH_AUTOMATION_DISABLED' })),
                        onSent: (service: string, method: string) => parent?.onSent(service, method),
                    }, () => operate(action, { ...input, expected: quote.expected }));
                    if (result.status === 'skipped') return false;
                    changed = true;
                    log('牧场', `${quote.label}${result.notice ? `：${result.notice}` : '完成'}`, { module: 'ranch', event: `ranch_${action}`, result: 'ok' });
                    raw = await loadRaw();
                    return true;
                } catch (error: any) {
                    // 状态或余额变化交给下一次巡查重新报价；已发出但结果未知的写入由持久账本保护。
                    if (['INSUFFICIENT_BALANCE', 'RESERVE_PROTECTED', 'PENDING_CONFIRMATION', 'RANCH_OFFER_CHANGED', 'GOODS_UNAVAILABLE', 'RANCH_STATE_CHANGED'].includes(error.code)) {
                        log('牧场', `${action} 暂未执行：${error.message}`, { module: 'ranch', event: `ranch_${action}`, result: 'skipped' });
                        return false;
                    }
                    throw error;
                }
            }

            await act('ranch_harvest', 'harvest', { all: true });
            await act('ranch_produce', 'produce', { all: true });
            await act('ranch_clean', 'clean');
            await act('ranch_sell', 'sell', { all: true });

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

            if (enabled('ranch_buy') && raw.cells.facilities.some((f: any) => f.state === 1 && f.ranch && f.ranch.animal_count < f.ranch.capacity)) {
                const shop = await catalog(raw, 5);
                for (const original of raw.cells.facilities.filter((f: any) => f.state === 1 && f.ranch)) {
                    const id = quantity(original.instance_id);
                    const selected = selectAnimal(shop.goods, auto, original.ranch.husbandry_type);
                    const stock = inventory(raw).filter((item: any) => !item.locked && item.animalId && BigInt(item.count) > 0n
                        && cubMap.get(item.id).husbandry_type === (original.ranch.husbandry_type === 1 ? '窝' : '棚')
                        && (auto.ranch_strategy === 'bag_priority' || item.animalId === selected?.animal.id)).sort((a: any, b: any) => b.animalId - a.animalId);
                    const room = () => {
                        const current = raw.cells.facilities.find((f: any) => quantity(f.instance_id) === id);
                        return current.ranch.capacity - current.ranch.animal_count;
                    };
                    for (const item of stock) {
                        const count = Number(BigInt(Math.max(0, room())) < available(item.id) ? BigInt(Math.max(0, room())) : available(item.id));
                        if (count > 0) await act('ranch_buy', 'place', { ranchId: id, itemId: item.id, count });
                    }
                    if (room() > 0 && selected) {
                        const count = affordable(selected, Math.min(room(), selected.maxCount, selected.remaining ?? Infinity));
                        if (count > 0) await act('ranch_buy', 'buy', { shopId: 5, goodsId: selected.id, count, autoPlace: true }, 1007);
                    }
                }
            }

            if (enabled('ranch_grass')) {
                for (const original of raw.cells.facilities.filter((f: any) => f.state === 1 && f.feed_machine)) {
                    const id = quantity(original.instance_id);
                    const room = original.capacity - original.feed_machine.feed_count;
                    if (room <= 0) continue;
                    const stock = Math.max(0, Number(available(7001)));
                    if (stock < room && enabled('ranch_grass_buy')) {
                        const shop = await catalog(raw, 6);
                        const good = shop.goods.find((g: any) => g.available && g.reward.id === 7001 && g.reward.count === '1' && g.price.id === 1007 && BigInt(g.price.count) > 0n);
                        if (good) {
                            const count = affordable(good, Math.min(room - stock, good.maxCount, good.remaining ?? Infinity));
                            if (count > 0) await act('ranch_grass_buy', 'buy', { shopId: 6, goodsId: good.id, count }, 1007);
                        }
                    }
                    const count = Math.min(room, Number(available(7001)));
                    if (count > 0) await act('ranch_grass', 'addGrass', { facilityId: id, count });
                }
            }

            if (enabled('ranch_fill_cans')) {
                for (const item of inventory(raw).filter((item: any) => item.can && !item.locked)) {
                    const count = Number(BigInt(item.count) < available(item.id) ? BigInt(item.count) : available(item.id));
                    if (count > 0) await act('ranch_fill_cans', 'useCan', { uid: item.uid, count });
                }
            }
            if (enabled('ranch_feed_normal') && available(7003) > 0n) await act('ranch_feed_normal', 'feed', { all: true, bucketType: 2 });
            if (enabled('ranch_feed_organic') && available(7004) > 0n) await act('ranch_feed_organic', 'feed', { all: true, bucketType: 1 });

            if (Object.values(FRIEND_CONTROLS).some(enabled)) {
                const interactions = require('./friends');
                const times = await interactions.getInteractionTimes();
                const wanted = (action: string) => enabled(FRIEND_CONTROLS[action])
                    && (!['stroke', 'putMosquito'].includes(action) || times[action] > 0);
                if (Object.keys(FRIEND_CONTROLS).some(wanted)) {
                    const friends = await require('../friend').getFriendsList();
                    // 沿用本轮巡查，每轮最多拜访三位，避免长期占用农牧场共用连接。
                    for (let visited = 0; visited < Math.min(3, friends.length) && Object.keys(FRIEND_CONTROLS).some(wanted); visited++) {
                        const friend = friends[nextFriendIndex++ % friends.length];
                        try {
                            const result = await interactions.automateFriend(friend.gid, wanted);
                            Object.assign(times, result.times);
                            for (const outcome of result.results) {
                                daily.markTasksChanged();
                                log('牧场', `${friend.name}：${outcome.notice}`, { module: 'ranch', event: `ranch_${outcome.action}`, result: 'ok' });
                            }
                        } catch (error: any) {
                            if (error.name !== 'GatewayError' || error.methodName !== 'EnterHomestead') throw error;
                            log('牧场', `暂不能拜访 ${friend.name}：${error.message}`, { module: 'ranch', event: 'ranch_friend', result: 'skipped' });
                        }
                    }
                }
            }

            if (changed) daily.markTasksChanged();
            if (enabled('ranch_task') && due(daily.getTaskRoutineState())) await daily.claimTasks();
            if (enabled('ranch_share') && due(daily.getShareRoutineState())) await daily.claimShare();
            // 成长、生产和建筑完成时间可提前唤醒；仍由现有 30 秒例程统一调度。
            const state = snapshot(raw);
            const upcoming = state.facilities.flatMap((f: any) => [
                ...(f.ranch?.animals || []).map((a: any) => a.nextAtMs),
                f.upgradeState ? (f.upgradeEndTime < 100_000_000_000 ? f.upgradeEndTime * 1000 : f.upgradeEndTime) : 0,
            ]).filter((at: any) => at > state.serverTime);
            if (upcoming.length) nextCheckAt = Math.min(nextCheckAt, Date.now() + Math.max(30_000, Math.min(...upcoming) - state.serverTime));
            if (changed) nextCheckAt = Math.min(nextCheckAt, Date.now() + 30_000);
        });
    } catch (error: any) {
        if (error.code === 'RANCH_AUTOMATION_DISABLED') return;
        nextCheckAt = Date.now() + Math.max(auto.ranch_check_minutes, 10) * 60_000;
        log('牧场', `日常牧场巡查失败：${error.message}`, { module: 'ranch', event: 'ranch_automation', result: 'error' });
    }
}

module.exports = { run, getRoutineState, selectAnimal, resetSchedule: () => { nextCheckAt = 0; } };
