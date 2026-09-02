export {};

/**
 * 好友单次访问计划（纯函数，可单测）。
 *
 * 以前好友巡查分三段跑：先一轮「只偷菜」、再一轮「只帮忙」、最后一轮「只捣乱」，
 * 每段各自 Enter/Leave。既有可偷又需要帮忙的好友因此被进两次农场，
 * 200 位好友一轮下来能刷出几百个 Enter/Leave，网关直接被打满。
 *
 * 现在改成先算出「每位好友这一轮要做哪几件事」，再对每位好友只进一次农场，
 * 在里面把 帮助（除草/除虫/浇水）+ 偷菜 + 捣乱（放草/放虫）一次做完。
 *
 * 过滤规则（与用户设定一致）：
 * - 捣乱额度用完 → 这一轮不捣乱；
 * - 经验已满且「经验满不帮」开着 → 不帮；
 * - 经验已满但「护主犬无视经验上限」开着 → 只帮当天缓存已确认是护主犬的好友；
 * - 好友宠物还没同步（缓存里没有结论）且经验已满 → 不进农场，交给每日宠物同步补齐；
 * - 没有任何事可做的好友一个请求都不发。
 */

interface FriendVisitPlanInput {
    friends: any[];
    myGid: number;
    blacklist: Set<number> | null;
    stealEnabled: boolean;
    helpEnabled: boolean;
    badEnabled: boolean;
    /** 经验没满，或本次显式忽略经验上限：此时对所有好友都可以帮。 */
    helpAllowedForAll: boolean;
    /** 「护主犬无视经验上限」开关。 */
    protectDogBypassEnabled: boolean;
    /** 当天宠物缓存结论：'protect' | 'none' | 'unknown'。 */
    getDogState: (gid: number) => string;
    /** 剩余捣乱次数，<= 0 表示这一轮不捣乱。 */
    badBudget: number;
    /** 纯捣乱访问的数量上限（按等级降序取前 N 位）。 */
    maxBadOnlyVisits: number;
}

interface FriendVisitTarget {
    gid: number;
    name: string;
    level: number;
    stealNum: number;
    helpNum: number;
    dryNum: number;
    weedNum: number;
    insectNum: number;
    wantSteal: boolean;
    wantHelp: boolean;
    wantBad: boolean;
}

interface FriendVisitPlan {
    visits: FriendVisitTarget[];
    stealCount: number;
    helpCount: number;
    badOnlyCount: number;
    /** 经验已满而被跳过（未进农场）的好友数。 */
    skippedExpLimit: number;
    /** 其中因为「宠物还没同步」无法确认护主犬的好友数。 */
    skippedUnknownDog: number;
}

function toInt(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function buildFriendVisitPlan(input: FriendVisitPlanInput): FriendVisitPlan {
    const friends: any[] = Array.isArray(input && input.friends) ? input.friends : [];
    const myGid: number = toInt(input && input.myGid);
    const blacklist: Set<number> = input && input.blacklist ? input.blacklist : new Set<number>();
    const getDogState: (gid: number) => string = typeof input.getDogState === 'function'
        ? input.getDogState
        : () => 'unknown';
    const badBudget: number = toInt(input && input.badBudget);
    const maxBadOnlyVisits: number = Math.max(0, toInt(input && input.maxBadOnlyVisits));
    const badAllowed: boolean = !!input.badEnabled && badBudget > 0 && maxBadOnlyVisits > 0;

    const primary: FriendVisitTarget[] = [];
    const badOnly: FriendVisitTarget[] = [];
    const seen: Set<number> = new Set();
    let skippedExpLimit: number = 0;
    let skippedUnknownDog: number = 0;

    for (const friend of friends) {
        const gid: number = toInt(friend && friend.gid);
        if (gid <= 0 || gid === myGid) continue;
        if (seen.has(gid)) continue;
        seen.add(gid);
        if (blacklist.has(gid)) continue;

        const name: string = (friend && (friend.remark || friend.name)) || `GID:${gid}`;
        const level: number = toInt(friend && friend.level);
        const plant: any = friend && friend.plant;
        const stealNum: number = plant ? toInt(plant.steal_plant_num) : 0;
        const dryNum: number = plant ? toInt(plant.dry_num) : 0;
        const weedNum: number = plant ? toInt(plant.weed_num) : 0;
        const insectNum: number = plant ? toInt(plant.insect_num) : 0;
        const helpNum: number = dryNum + weedNum + insectNum;

        const wantSteal: boolean = !!input.stealEnabled && stealNum > 0;
        let wantHelp: boolean = !!input.helpEnabled && helpNum > 0;
        if (wantHelp && !input.helpAllowedForAll) {
            // 经验已满：只有「护主犬无视经验上限」开着、且当天缓存已确认是护主犬时才值得进农场。
            const dogState: string = String(getDogState(gid) || 'unknown');
            const bypass: boolean = !!input.protectDogBypassEnabled && dogState === 'protect';
            if (!bypass) {
                wantHelp = false;
                skippedExpLimit += 1;
                // 宠物没同步的好友这一轮不试探，等每日宠物同步给出结论
                if (input.protectDogBypassEnabled && dogState === 'unknown') skippedUnknownDog += 1;
            }
        }

        const target: FriendVisitTarget = {
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

    const badTargets: FriendVisitTarget[] = badOnly.slice(0, maxBadOnlyVisits);
    for (const target of badTargets) target.wantBad = true;

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