export {};

interface KnownFriendGidSyncValue {
    revision: number;
    baseGids: number[];
    gids: number[];
}

class KnownFriendGidSync {
    private revision = 0;
    private pending: KnownFriendGidSyncValue | null = null;

    update(baseGids: number[], gids: number[]): KnownFriendGidSyncValue {
        this.pending = {
            revision: ++this.revision,
            baseGids: this.pending ? this.pending.baseGids : [...baseGids],
            gids: [...gids],
        };
        return this.getPending()!;
    }

    getPending(): KnownFriendGidSyncValue | null {
        if (!this.pending) return null;
        return {
            revision: this.pending.revision,
            baseGids: [...this.pending.baseGids],
            gids: [...this.pending.gids],
        };
    }

    acknowledge(revision: number): boolean {
        if (!this.pending || revision < this.pending.revision) return false;
        this.pending = null;
        return true;
    }
}

function normalizeGids(values: unknown): number[] {
    const result: number[] = [];
    for (const value of (Array.isArray(values) ? values : [])) {
        const gid = Number(value);
        if (!Number.isFinite(gid) || gid <= 0 || result.includes(gid)) continue;
        result.push(gid);
    }
    return result;
}

function applyKnownFriendGidChange(currentInput: unknown, baseInput: unknown, nextInput: unknown): number[] {
    const current = normalizeGids(currentInput);
    const base = normalizeGids(baseInput);
    const next = normalizeGids(nextInput);
    const baseSet = new Set(base);
    const nextSet = new Set(next);
    const removed = new Set(base.filter(gid => !nextSet.has(gid)));
    const result = current.filter(gid => !removed.has(gid));
    for (const gid of next) {
        if (!baseSet.has(gid) && !result.includes(gid)) result.push(gid);
    }
    return result;
}

module.exports = {
    applyKnownFriendGidChange,
    KnownFriendGidSync,
};
