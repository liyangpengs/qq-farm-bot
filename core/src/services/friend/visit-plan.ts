export {};

interface FriendVisitPlanInput {
    friends: any[];
    myGid: number;
    blacklist: Set<number> | null;
    stealEnabled: boolean;
    helpEnabled: boolean;
    badEnabled: boolean;
    helpAllowedForAll: boolean;
    protectDogBypassEnabled: boolean;
    getDogState: (gid: number) => string;
    badBudget: number;
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
    skippedExpLimit: number;
    skippedUnknownDog: number;
}

function toInt(value: any): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function buildFriendVisitPlan(input: FriendVisitPlanInput): FriendVisitPlan {
    const friends = Array.isArray(input?.friends) ? input.friends : [];
    const myGid = toInt(input?.myGid);
    const blacklist = input?.blacklist || new Set<number>();
    const getDogState = typeof input?.getDogState === 'function'
        ? input.getDogState
        : () => 'unknown';
    const badAllowed = !!input?.badEnabled
        && toInt(input?.badBudget) > 0
        && toInt(input?.maxBadOnlyVisits) > 0;

    const primary: FriendVisitTarget[] = [];
    const badOnly: FriendVisitTarget[] = [];
    const seen = new Set<number>();
    let skippedExpLimit = 0;
    let skippedUnknownDog = 0;

    for (const friend of friends) {
        const gid = toInt(friend?.gid);
        if (gid <= 0 || gid === myGid || seen.has(gid)) continue;
        seen.add(gid);
        if (blacklist.has(gid)) continue;

        const plant = friend?.plant;
        const stealNum = plant ? toInt(plant.steal_plant_num) : 0;
        const dryNum = plant ? toInt(plant.dry_num) : 0;
        const weedNum = plant ? toInt(plant.weed_num) : 0;
        const insectNum = plant ? toInt(plant.insect_num) : 0;
        const helpNum = dryNum + weedNum + insectNum;
        const wantSteal = !!input.stealEnabled && stealNum > 0;
        let wantHelp = !!input.helpEnabled && helpNum > 0;

        if (wantHelp && !input.helpAllowedForAll) {
            const dogState = String(getDogState(gid) || 'unknown');
            if (!input.protectDogBypassEnabled || dogState !== 'protect') {
                wantHelp = false;
                skippedExpLimit += 1;
                if (input.protectDogBypassEnabled && dogState === 'unknown') skippedUnknownDog += 1;
            }
        }

        const target: FriendVisitTarget = {
            gid,
            name: friend?.remark || friend?.name || `GID:${gid}`,
            level: toInt(friend?.level),
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
        } else if (badAllowed && stealNum === 0 && helpNum === 0) {
            badOnly.push(target);
        }
    }

    primary.sort((left, right) => (
        (right.stealNum - left.stealNum)
        || (right.helpNum - left.helpNum)
        || (right.level - left.level)
    ));
    badOnly.sort((left, right) => right.level - left.level);

    const badTargets = badOnly.slice(0, Math.max(0, toInt(input.maxBadOnlyVisits)));
    for (const target of badTargets) target.wantBad = true;

    return {
        visits: [...primary, ...badTargets],
        stealCount: primary.filter(target => target.wantSteal).length,
        helpCount: primary.filter(target => target.wantHelp).length,
        badOnlyCount: badTargets.length,
        skippedExpLimit,
        skippedUnknownDog,
    };
}

module.exports = {
    buildFriendVisitPlan,
};
