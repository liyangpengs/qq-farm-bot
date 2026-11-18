import { animalMap, cubMap } from '../../config/ranch-animals';
import cans from '../../gameConfig/ranch/MCCanConfig.json';
import facilities from '../../gameConfig/ranch/MCFacilityConfig.json';
import items from '../../gameConfig/ranch/MCItemInfo.json';
import tasks from '../../gameConfig/ranch/MCTask.json';
import levels from '../../gameConfig/ranch/BigFarmLevel.json';
import mutations from '../../gameConfig/ranch/MCAnimalMutation.json';

export {};

const { getItemById, getItemImageById, getShopGoodsById } = require('../../config/gameConfig');

const canMap = new Map<number, any>(cans.map(row => [row.id, row]));
const facilityMap = new Map<number, any>(facilities.map(row => [row.facility_id, row]));
const itemMap = new Map<number, any>(items.map(row => [row.id, row]));
const taskMap = new Map<number, any>(tasks.map(row => [row.id, row]));
const mutationMap = new Map<number, any>(mutations.map(row => [row.animal_id, row]));

function error(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function positiveId(value: unknown, label: string): string {
    const text = String(value ?? '').trim();
    if (!/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) throw error('INVALID_ARGUMENT', `${label}无效`);
    return text;
}

function positiveCount(value: unknown): number {
    const text = positiveId(value, '数量');
    const count = Number(text);
    if (!Number.isSafeInteger(count) || count > 2147483647) throw error('INVALID_ARGUMENT', '数量超出范围');
    return count;
}

function quantity(value: any): string {
    return value == null ? '0' : value.toString();
}

function itemDto(item: any): any {
    const id = Number(item.id);
    const metadata = itemMap.get(id) || getItemById(id);
    if (id === 7003 || id === 7004) return { id, count: quantity(item.count), name: id === 7003 ? '普通罐头桶' : '有机罐头桶', image: getItemImageById(id === 7003 ? 80021 : 80031) };
    return { id, count: quantity(item.count), name: metadata?.name || `物品${id}`, image: getItemImageById(id) };
}

function pendingOperationView(operation: any): any {
    let label = operation.label;
    const goodsId = operation.target.match(/^ranch:buy:(\d+)$/)?.[1];
    if (label === '购买牧场商品' && goodsId) {
        const goods = getShopGoodsById(Number(goodsId));
        if (goods) label = `购买${itemDto({ id: goods.item_id }).name}`;
    }
    return { ...operation, label, costs: operation.costs.map((cost: any) => ({ ...cost,
        name: itemDto({ id: Number(cost.resourceKey.slice(5)) }).name,
    })) };
}

function sumItems(items: any[]): any[] {
    const totals = new Map<number, bigint>();
    for (const item of items) totals.set(Number(item.id), (totals.get(Number(item.id)) || 0n) + BigInt(quantity(item.count)));
    return [...totals].map(([id, count]) => itemDto({ id, count }));
}

function signature(items: any[]): string {
    return sumItems(items).filter(item => BigInt(item.count) !== 0n).map(item => `${item.id}:${item.count}`).sort().join('|');
}

function levelInfo(exp: number): any {
    const current = [...levels].reverse().find(row => row.exp <= exp)!;
    const next = levels.find(row => row.level === current.level + 1);
    return { level: current.level, exp, currentExp: exp - current.exp, neededExp: next ? next.exp - current.exp : null };
}

function isLongestAnimalStage(animal: any): boolean {
    const config = animalMap.get(Number(animal?.animal_id ?? animal?.animalId));
    if (!config) return false;
    const durations = [config.infant_sec, config.grow_sec, config.product_round_sec, config.mature_sec].map(Number);
    const current = Number(animal.stage) - 1;
    if (!Number.isInteger(current) || current < 0 || current >= durations.length) return false;
    return Number.isFinite(durations[current]) && durations[current] === Math.max(...durations.filter(Number.isFinite));
}

module.exports = { animalMap, mutationMap, cubMap, canMap, facilityMap, itemMap, taskMap, error, positiveId, positiveCount, quantity, itemDto, pendingOperationView, sumItems, signature, levelInfo, isLongestAnimalStage };
