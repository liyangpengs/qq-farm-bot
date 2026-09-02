"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function toInt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function buildFriendVisitPlan(input) {
    const friends = Array.isArray(input && input.friends) ? input.friends : [];
    const myGid = toInt(input && input.myGid);
    const blacklist = input && input.blacklist ? input.blacklist : new Set();
    const getDogState = typeof input.getDogState === 'function'
        ? input.getDogState
        : () => 'unknown';
    const badBudget = toInt(input && input.badBudget);
    const maxBadOnlyVisits = Math.max(0, toInt(input && input.maxBadOnlyVisits));
    const badAllowed = !!input.badEnabled && badBudget > 0 && maxBadOnlyVisits > 0;
    const primary = [];
    const badOnly = [];
    const seen = new Set();
    let skippedExpLimit = 0;
    let skippedUnknownDog = 0;
    for (const friend of friends) {
        const gid = toInt(friend && friend.gid);
        if (gid <= 0 || gid === myGid)
            continue;
        if (seen.has(gid))
            continue;
        seen.add(gid);
        if (blacklist.has(gid))
            continue;
        const name = (friend && (friend.remark || friend.name)) || `GID:${gid}`;
        const level = toInt(friend && friend.level);
        const plant = friend && friend.plant;
        const stealNum = plant ? toInt(plant.steal_plant_num) : 0;
        const dryNum = plant ? toInt(plant.dry_num) : 0;
        const weedNum = plant ? toInt(plant.weed_num) : 0;
        const insectNum = plant ? toInt(plant.insect_num) : 0;
        const helpNum = dryNum + weedNum + insectNum;
        const wantSteal = !!input.stealEnabled && stealNum > 0;
        let wantHelp = !!input.helpEnabled && helpNum > 0;
        if (wantHelp && !input.helpAllowedForAll) {
            // 经验已满：只有「护主犬无视经验上限」开着、且当天缓存已确认是护主犬时才值得进农场。
            const dogState = String(getDogState(gid) || 'unknown');
            const bypass = !!input.protectDogBypassEnabled && dogState === 'protect';
            if (!bypass) {
                wantHelp = false;
                skippedExpLimit += 1;
                // 宠物没同步的好友这一轮不试探，等每日宠物同步给出结论
                if (input.protectDogBypassEnabled && dogState === 'unknown')
                    skippedUnknownDog += 1;
            }
        }
        const target = {
            gid,
            name,
            level,
            stealNum,
            helpNum,
            dryNum,
            weedNum,
            insectNum,
            wantSteal,
            wantHelp,
            wantBad: false,
        };
        if (wantSteal || wantHelp) {
            primary.push(target);
            continue;
        }
        // 既没可偷也没可帮的好友才是捣乱对象：和旧逻辑一致，不在偷/帮的访问里顺手放草放虫，
        // 免得每日捣乱额度被花在错误的好友身上。
        if (badAllowed && stealNum === 0 && helpNum === 0) {
            badOnly.push(target);
        }
    }
    // 偷得多的先走，其次是帮助需求大的，最后按等级
    primary.sort((a, b) => (b.stealNum - a.stealNum) || (b.helpNum - a.helpNum) || (b.level - a.level));
    // 捣乱优先挑等级高的好友
    badOnly.sort((a, b) => b.level - a.level);
    const badTargets = badOnly.slice(0, maxBadOnlyVisits);
    for (const target of badTargets)
        target.wantBad = true;
    return {
        visits: [...primary, ...badTargets],
        stealCount: primary.filter(item => item.wantSteal).length,
        helpCount: primary.filter(item => item.wantHelp).length,
        badOnlyCount: badTargets.length,
        skippedExpLimit,
        skippedUnknownDog,
    };
}
module.exports = {
    buildFriendVisitPlan,
};
//# sourceMappingURL=visit-plan.js.map