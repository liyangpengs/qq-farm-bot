const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

// 缓存文件名由 FARM_ACCOUNT_ID 推导，先设好再加载模块，避开真实账号的缓存文件。
process.env.FARM_ACCOUNT_ID = 'friend-pet-cache-test';

const {
    PROTECT_DOG_ID,
    recordFriendDog,
    recordFriendDogFromEnterReply,
    getFriendDogState,
    getFriendDogId,
    isFriendDogKnownToday,
    forgetFriendDog,
    isFullSyncDoneToday,
    markFullSyncDone,
    getFriendPetCacheStats,
    flushFriendPetCacheNow,
    resetFriendPetCacheMemory,
} = require('../dist/services/friend/pet-cache');
const { collectPendingFriends, planNextSyncPacing, FRIEND_PET_SYNC_TUNING } = require('../dist/services/friend/pet-sync');
const { buildFriendPetView } = require('../dist/services/friend/visit-strategy');
const { getDataFile } = require('../dist/config/runtime-paths');
const { getSystemDateKey } = require('../dist/utils/utils');

function cacheFile() {
    const token = crypto.createHash('sha256').update(process.env.FARM_ACCOUNT_ID, 'utf8').digest('hex');
    return getDataFile(`friend-pet-${token}.json`);
}

function resetAll() {
    resetFriendPetCacheMemory();
    try { fs.rmSync(cacheFile()); } catch { /* 首次运行没有文件 */ }
}

test.beforeEach(resetAll);
test.after(resetAll);

test('Enter 回包里的护主犬被识别为 protect，其余狗与无狗识别为 other', () => {
    recordFriendDogFromEnterReply(1001, { brief_dog_info: { dog_id: PROTECT_DOG_ID } });
    recordFriendDogFromEnterReply(1002, { briefDogInfo: { dogId: 90011 } });
    recordFriendDogFromEnterReply(1003, {});

    assert.equal(getFriendDogState(1001), 'protect');
    assert.equal(getFriendDogState(1002), 'other');
    // 没有上场狗也是一个有效结论，不应该回到 unknown 而被重复同步
    assert.equal(getFriendDogState(1003), 'other');
    assert.equal(getFriendDogId(1003), 0);
    assert.ok(isFriendDogKnownToday(1003));
});

test('没确认过的好友是 unknown，不会被误当成护主犬', () => {
    assert.equal(getFriendDogState(2001), 'unknown');
    assert.equal(isFriendDogKnownToday(2001), false);
    assert.equal(getFriendDogState(0), 'unknown');
});

test('结论可以落盘并在重启后恢复', () => {
    recordFriendDog(3001, PROTECT_DOG_ID);
    markFullSyncDone();
    flushFriendPetCacheNow();

    resetFriendPetCacheMemory();
    assert.equal(getFriendDogState(3001), 'protect');
    assert.ok(isFullSyncDoneToday());
});

test('跳日的缓存一律作废，当天重新同步', () => {
    recordFriendDog(4001, PROTECT_DOG_ID);
    markFullSyncDone();
    flushFriendPetCacheNow();

    const file = cacheFile();
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(state.entries['4001'].date, getSystemDateKey());
    state.lastFullSyncDate = '2000-01-01';
    state.entries['4001'].date = '2000-01-01';
    fs.writeFileSync(file, JSON.stringify(state));

    resetFriendPetCacheMemory();
    assert.equal(getFriendDogState(4001), 'unknown');
    assert.equal(isFullSyncDoneToday(), false);
});

test('统计与遗忘单位好友', () => {
    recordFriendDog(5001, PROTECT_DOG_ID);
    recordFriendDog(5002, 90001);
    assert.deepEqual(
        { known: getFriendPetCacheStats().known, protect: getFriendPetCacheStats().protect },
        { known: 2, protect: 1 },
    );

    forgetFriendDog(5001);
    assert.equal(getFriendDogState(5001), 'unknown');
    assert.equal(getFriendPetCacheStats().known, 1);
});

test('每日同步只选当天未确认、非黑名单、非失效的好友', () => {
    recordFriendDog(6002, 90001);
    const friends = [
        { gid: 6001, name: '待确认' },
        { gid: 6002, name: '今天已确认' },
        { gid: 6003, remark: '黑名单' },
        { gid: 6004, name: '已失效' },
        { gid: 6005, name: '自己' },
        { gid: 6001, name: '重复项' },
        { gid: 0, name: '非法 gid' },
    ];

    const pending = collectPendingFriends(friends, 6005, new Set([6003]), new Set([6004]));
    assert.deepEqual(pending, [{ gid: 6001, name: '待确认' }]);
});

test('每日同步的突发量被压在服务端限制之下', () => {
    const tuning = FRIEND_PET_SYNC_TUNING;
    // 一轮探太多位会触发服务端静默（生产上 60~75 位就掉线），基线和封顶都必须留足余量
    assert.ok(tuning.SYNC_MAX_PER_ROUND_BASE > 0 && tuning.SYNC_MAX_PER_ROUND_BASE <= 15);
    assert.ok(tuning.SYNC_MAX_PER_ROUND_CAP >= tuning.SYNC_MAX_PER_ROUND_BASE && tuning.SYNC_MAX_PER_ROUND_CAP <= 30);
    // 批内间隔不能回到几百毫秒的密集节奏：这是瞬时速率的安全线，不参与自适应
    assert.ok(tuning.SYNC_GAP_MS >= 1000);

    // 最快节奏（满配额 + 最短轮间间隔）下 Enter + Leave 的平均速率
    const batches = Math.ceil(tuning.SYNC_MAX_PER_ROUND_CAP / tuning.SYNC_BATCH_SIZE);
    const roundMs = tuning.SYNC_MAX_PER_ROUND_CAP * tuning.SYNC_GAP_MS
        + (batches - 1) * tuning.SYNC_BATCH_GAP_MS
        + tuning.SYNC_FAST_INTERVAL_MS;
    const rpcPerSecond = (tuning.SYNC_MAX_PER_ROUND_CAP * 2) / (roundMs / 1000);
    assert.ok(rpcPerSecond <= 0.25, `平均 ${rpcPerSecond} RPC/s 偏高`);

    // 加速节奏不能比基线巡检还慢；抢窗口失败的短退避要明显小于服务端静默的冷却
    assert.ok(tuning.SYNC_FAST_INTERVAL_MS <= tuning.SYNC_CHECK_INTERVAL_MS);
    assert.ok(tuning.SYNC_CONTENTION_RETRY_MS < tuning.SYNC_BUSY_COOLDOWN_MS);
    // 撞上网关静默之后的冷却要比常规检查周期更长
    assert.ok(tuning.SYNC_BUSY_COOLDOWN_MS >= tuning.SYNC_CHECK_INTERVAL_MS);
});

test('同步节奏自适应：干净跑完就加量加速，让路一次就退回基线并锁死上调', () => {
    const tuning = FRIEND_PET_SYNC_TUNING;
    const base = { quota: tuning.SYNC_MAX_PER_ROUND_BASE, rampLocked: false };

    // 只是配额没探完，说明连接扛得住：配额 +STEP，用较短的间隔接上
    const ramped = planNextSyncPacing({ outcome: 'deferred', reason: 'round_quota' }, base);
    assert.equal(ramped.quota, tuning.SYNC_MAX_PER_ROUND_BASE + tuning.SYNC_MAX_PER_ROUND_STEP);
    assert.equal(ramped.delayMs, tuning.SYNC_FAST_INTERVAL_MS);
    assert.equal(ramped.rampLocked, false);

    // 配额封顶后不再往上爬
    const capped = planNextSyncPacing({ outcome: 'deferred', reason: 'round_quota' }, { quota: tuning.SYNC_MAX_PER_ROUND_CAP, rampLocked: false });
    assert.equal(capped.quota, tuning.SYNC_MAX_PER_ROUND_CAP);

    // 抢不到空闲窗口：短退避，配额回基线并锁死当天的上调
    const contention = planNextSyncPacing({ outcome: 'deferred', reason: 'gateway_contention' }, { quota: tuning.SYNC_MAX_PER_ROUND_CAP, rampLocked: false });
    assert.equal(contention.delayMs, tuning.SYNC_CONTENTION_RETRY_MS);
    assert.equal(contention.quota, tuning.SYNC_MAX_PER_ROUND_BASE);
    assert.equal(contention.rampLocked, true);

    // 服务端静默：冷却已在同步侧生效，这里只要回到基线间隔
    const stalled = planNextSyncPacing({ outcome: 'deferred', reason: 'gateway_busy' }, base);
    assert.equal(stalled.delayMs, tuning.SYNC_CHECK_INTERVAL_MS);
    assert.equal(stalled.rampLocked, true);

    // 锁死之后即使干净跑完也不再上调，只保留加速
    const lockedRound = planNextSyncPacing({ outcome: 'deferred', reason: 'round_quota' }, { quota: tuning.SYNC_MAX_PER_ROUND_BASE, rampLocked: true });
    assert.equal(lockedRound.quota, tuning.SYNC_MAX_PER_ROUND_BASE);
    assert.equal(lockedRound.delayMs, tuning.SYNC_FAST_INTERVAL_MS);

    // 好友巡查占用也算让路；当天活干完 / 没活则回基线间隔
    assert.equal(planNextSyncPacing({ outcome: 'deferred', reason: 'friend_task_busy' }, base).delayMs, tuning.SYNC_CONTENTION_RETRY_MS);
    assert.equal(planNextSyncPacing({ outcome: 'synced' }, base).delayMs, tuning.SYNC_CHECK_INTERVAL_MS);
    assert.equal(planNextSyncPacing({ outcome: 'fresh', reason: 'done_today' }, base).delayMs, tuning.SYNC_CHECK_INTERVAL_MS);
    assert.equal(planNextSyncPacing(null, base).delayMs, tuning.SYNC_CHECK_INTERVAL_MS);
});

test('好友列表的宠物 DTO 区分护主犬、其他狗、无狗与未确认', () => {
    recordFriendDog(7001, PROTECT_DOG_ID);
    recordFriendDog(7002, 90001);
    recordFriendDog(7003, 0);

    assert.deepEqual(buildFriendPetView(7001), {
        petState: 'protect',
        pet: { id: '90021', name: '护主犬', image: '/game-config/seed_images_named/seed_images/90021.png' },
    });
    assert.equal(buildFriendPetView(7002).petState, 'other');
    assert.equal(buildFriendPetView(7002).pet.name, '田园犬');
    assert.deepEqual(buildFriendPetView(7003), { petState: 'none', pet: null });
    assert.deepEqual(buildFriendPetView(7004), { petState: 'unknown', pet: null });
});
