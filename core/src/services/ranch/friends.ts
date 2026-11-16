export {};

const { rpc, inScene } = require('./transport');
const network = require('../../utils/network');
const { error, positiveId, quantity, itemDto, sumItems } = require('./model');
const { runWithSendContext } = require('./context');
const { logWarn } = require('../../utils/utils');

function targets(ranches: any[]): any[] {
    const gid = quantity(network.getUserState().gid);
    return ranches.flatMap(ranch => ranch.shelves.filter((shelf: any) => shelf.can_steal && shelf.lots.some((lot: any) =>
        lot.can_steal && BigInt(quantity(lot.remain_num)) > 0n && !lot.stealers.some((id: any) => quantity(id) === gid)))
        .map((shelf: any) => ({ ranchId: quantity(ranch.ranch_inst_id), slot: shelf.slot_index,
            itemIds: shelf.lots.filter((lot: any) => lot.can_steal && !lot.stealers.some((id: any) => quantity(id) === gid)).map((lot: any) => quantity(lot.item_id)) })));
}

async function visit(hostGid: unknown, run: (entry: any, ranches: any[], host: string) => Promise<any>): Promise<any> {
    const host = positiveId(hostGid, '好友GID');
    if (host === quantity(network.getUserState().gid)) throw error('INVALID_ARGUMENT', '请选择好友牧场');
    return inScene(async () => {
        const socket = network.getWs();
        let result: any;
        try {
            const entry = await rpc('enterFriend', { host_gid: host, reason: 2 });
            if (quantity(entry.basic?.gid) !== host || !entry.homestead_cells) throw error('RANCH_RESPONSE_MISMATCH', '好友牧场回包与目标不匹配');
            const detail = await rpc('animals', { host_gid: host });
            result = await run(entry, detail.ranches, host);
            return result;
        } finally {
            if (network.getWs() === socket) {
                try {
                    await runWithSendContext({ check: () => null, onSent: () => {} }, () => rpc('leaveFriend', { host_gid: host }));
                } catch (error: any) {
                    logWarn('牧场', `离开好友牧场失败：${error.message}`, { module: 'ranch', event: 'ranch_friend_leave' });
                    network.invalidateGameScene('好友牧场离场未确认，需要重新登录');
                    if (result) Object.assign(result, { sceneRestored: false, refreshRequired: true, notice: '好友牧场离场未确认，账号需重新登录；请核对操作结果' });
                }
            }
        }
    });
}

async function getFriend(hostGid: unknown): Promise<any> {
    return visit(hostGid, async (entry, ranches, host) => {
        const eligible = targets(ranches);
        return { gid: host, name: entry.basic.name, level: Number(entry.basic.big_farm_level),
            canSteal: eligible.length > 0, stealableShelves: eligible.length,
            ranches: ranches.map(ranch => ({ id: quantity(ranch.ranch_inst_id),
                shelves: ranch.shelves.map((shelf: any) => ({ slot: shelf.slot_index,
                    canSteal: eligible.some(target => target.ranchId === quantity(ranch.ranch_inst_id) && target.slot === shelf.slot_index),
                    products: shelf.lots.map((lot: any) => itemDto({ id: lot.item_id, count: lot.remain_num })) })) })) };
    });
}

function quote(host: string, ranches: any[]): any {
    const eligible = targets(ranches);
    return { action: 'steal', label: '偷取好友牧场产物', costItems: [], costs: [], rewards: [], count: eligible.length,
        expected: { signature: JSON.stringify({ host, targets: eligible }) }, skipped: eligible.length === 0 };
}

async function prepareSteal(input: any): Promise<any> {
    return visit(input.hostGid, async (_entry, ranches, host) => quote(host, ranches));
}

async function steal(input: any): Promise<any> {
    return visit(input.hostGid, async (_entry, ranches, host) => {
        const plan = quote(host, ranches);
        if (plan.skipped) return { status: 'skipped', snapshot: null, costs: [], rewards: [], completed: 0, refreshRequired: true };
        if (input.expected?.signature !== plan.expected.signature) throw error('RANCH_OFFER_CHANGED', '好友牧场可偷产物已变化，请重新确认');
        // 原生一键偷取使用空 targets，由服务端筛选当前可偷货架。
        const reply = await rpc('steal', { host_gid: host, targets: [] }, true);
        const eligible = targets(ranches);
        const seen = new Set<string>();
        for (const row of reply.op_results) {
            const key = `${quantity(row.facility_inst_id)}:${quantity(row.target_id)}`;
            const target = eligible.find(target => target.ranchId === quantity(row.facility_inst_id) && String(target.slot) === quantity(row.target_id));
            if (!target || row.kind !== 2 || seen.has(key) || row.costs.length || !row.rewards.length
                || row.rewards.some((item: any) => !target.itemIds.includes(quantity(item.id)) || BigInt(quantity(item.count)) <= 0n)) {
                throw error('RANCH_RESULT_UNKNOWN', '偷取回包未能确认，请刷新核对，勿重复提交');
            }
            seen.add(key);
        }
        const completed = reply.op_results.length;
        const rewards = sumItems(reply.op_results.flatMap((row: any) => row.rewards));
        const notice = rewards.length ? `获得 ${rewards.map((item: any) => `${item.name} ×${item.count}`).join('、')}` : '当前没有可偷取的产物';
        return { status: completed ? 'confirmed' : 'skipped', snapshot: null, costs: [],
            rewards, completed, refreshRequired: true,
            notice: completed < plan.count ? `${notice}；已完成 ${completed} / ${plan.count} 个货架，请刷新核对` : notice };
    });
}

module.exports = { getFriend, prepareSteal, steal };
