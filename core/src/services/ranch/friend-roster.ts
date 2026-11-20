import { extractReplyFriends, fetchAllFriendsForScene, fetchFriendsByGids, QQ_FRIEND_LIST_BATCH_SIZE } from '../friend/gid-manager';

export interface RanchFriend {
    gid: number;
    name: string;
    avatarUrl: string;
    canSteal: boolean;
    canHelp: boolean;
    statusAtMs: number;
}

const { CONFIG } = require('../../config/config');
const { getKnownFriendGids, getFriendsListCacheTtlSec } = require('../../models/store');
const { getWs, getUserState } = require('../../utils/network');
const { randomDelay, toNum } = require('../../utils/utils');
const { error } = require('./model');

interface RosterScope {
    socket: unknown;
    key: string;
}

let cache: (RosterScope & { friends: RanchFriend[]; expiresAt: number }) | null = null;
let sync: (RosterScope & { offset: number; friends: Map<number, RanchFriend> }) | null = null;

// 实包核对：can_steal 按当前账号计算，偷过后变为 false；can_help 排除当前账号自己投放的蚊子。
function farmStatus(status: any, statusAtMs: number): Pick<RanchFriend, 'canSteal' | 'canHelp' | 'statusAtMs'> {
    return { canSteal: status.can_steal, canHelp: status.can_help, statusAtMs };
}

function assertRanchSession(socket: unknown): void {
    if (getWs() !== socket || getUserState().globalSceneId !== 2) {
        throw error('RANCH_FRIEND_SESSION_CHANGED', '牧场好友同步期间连接或场景已变化');
    }
}

// 调用方持有牧场场景任务。从 start 起按名单顺序刷新一批好友的牧场状态，与官方客户端轮询使用同一请求。
// 只更新名单中已有的条目；未返回的好友保留原状态，由调用方按过期处理。返回本次查询的 GID。
export async function refreshRanchFriendStatus(friends: RanchFriend[], start: number): Promise<number[]> {
    if (!friends.length) return [];
    if (getUserState().globalSceneId !== 2) throw error('RANCH_SCENE_REQUIRED', '刷新好友状态需要先进入牧场场景');
    const socket = getWs();
    const qq = CONFIG.platform === 'qq';
    const size = Math.min(friends.length, QQ_FRIEND_LIST_BATCH_SIZE);
    const targets = qq ? Array.from({ length: size }, (_, index) => friends[(start + index) % friends.length]) : friends;
    const byGid = new Map(targets.map(friend => [friend.gid, friend]));
    const rows = qq ? await fetchFriendsByGids([...byGid.keys()], 2) : extractReplyFriends(await fetchAllFriendsForScene(2));
    assertRanchSession(socket);
    const statusAtMs = Date.now();
    for (const row of rows) {
        const friend = byGid.get(toNum(row.gid));
        if (friend && row.big_farm_status) Object.assign(friend, farmStatus(row.big_farm_status, statusAtMs));
    }
    return [...byGid.keys()];
}

// 调用方持有牧场场景任务。同步分批保留进度，让路后从下一批继续。
export async function getRanchFriendList(checkpoint?: (completedBatch: boolean) => void): Promise<RanchFriend[]> {
    const state = getUserState();
    if (state.globalSceneId !== 2) throw error('RANCH_SCENE_REQUIRED', '同步好友需要先进入牧场场景');
    const self = toNum(state.gid);
    const socket = getWs();
    const gids: number[] = CONFIG.platform === 'qq' ? getKnownFriendGids().filter((gid: number) => gid !== self) : [];
    const key = `${CONFIG.platform}:${self}:${gids.join(',')}`;
    if (cache && cache.socket === socket && cache.key === key && Date.now() < cache.expiresAt) return cache.friends;
    if (!sync || sync.socket !== socket || sync.key !== key) {
        sync = { socket, key, offset: 0, friends: new Map() };
    }
    const current = sync;
    while (current.offset < Math.max(gids.length, 1)) {
        checkpoint?.(false);
        const batch = gids.slice(current.offset, current.offset + QQ_FRIEND_LIST_BATCH_SIZE);
        const rows = batch.length
            ? await fetchFriendsByGids(batch, 2)
            : extractReplyFriends(await fetchAllFriendsForScene(2));
        assertRanchSession(socket);
        const requested = new Set(batch);
        const statusAtMs = Date.now();
        for (const friend of rows) {
            const gid = toNum(friend.gid);
            // GID 只是查询线索，以牧场回包中的状态确认名单资格。
            if (gid <= 0 || gid === self || !friend.big_farm_status || (batch.length && !requested.has(gid))) continue;
            current.friends.set(gid, {
                gid,
                name: friend.name.trim() || friend.remark.trim() || `GID:${gid}`,
                avatarUrl: friend.avatar_url.trim(),
                ...farmStatus(friend.big_farm_status, statusAtMs),
            });
        }
        current.offset += Math.max(batch.length, 1);
        checkpoint?.(true);
        if (current.offset < gids.length) await randomDelay(500, 1000);
    }
    const friends = [...current.friends.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.gid - b.gid);
    cache = { socket, key, friends, expiresAt: Date.now() + getFriendsListCacheTtlSec() * 1000 };
    sync = null;
    return friends;
}
