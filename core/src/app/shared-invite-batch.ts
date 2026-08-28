export {};

const { getShareFilePath } = require('../config/runtime-paths');
const { readTextFile, writeTextFileAtomic } = require('../services/json-db');

interface ShareInvite {
    uid: string;
    openid: string;
    shareSource: string;
    docId: string;
}

interface InviteBatchClaim {
    claimId: number;
    invites: ShareInvite[];
}

interface ActiveInviteBatch extends InviteBatchClaim {
    accountId: string;
    content: string;
}

function parseShareInvite(line: string): ShareInvite | null {
    const query = line.startsWith('?') ? line.slice(1) : line;
    const params = new URLSearchParams(query);
    const uid = String(params.get('uid') || '').trim();
    const openid = String(params.get('openid') || '').trim();
    if (!uid || !openid) return null;
    return {
        uid,
        openid,
        shareSource: String(params.get('share_source') || ''),
        docId: String(params.get('doc_id') || ''),
    };
}

function parseShareInviteContent(content: string): ShareInvite[] {
    const invites: ShareInvite[] = [];
    const seenUids = new Set<string>();
    for (const rawLine of String(content || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || !line.includes('openid=')) continue;
        const invite = parseShareInvite(line);
        if (!invite || seenUids.has(invite.uid)) continue;
        seenUids.add(invite.uid);
        invites.push(invite);
    }
    return invites;
}

class SharedInviteBatch {
    private readonly filePath: string;
    private active: ActiveInviteBatch | null = null;
    private nextClaimId = 1;

    constructor(filePath: string = getShareFilePath()) {
        this.filePath = filePath;
    }

    claim(accountIdInput: unknown): InviteBatchClaim | null {
        const accountId = String(accountIdInput || '').trim();
        if (!accountId || this.active) return null;

        const content = readTextFile(this.filePath, '');
        const invites = parseShareInviteContent(content);
        if (invites.length === 0) return null;

        this.active = {
            accountId,
            claimId: this.nextClaimId++,
            content,
            invites,
        };
        return this.copyClaim(this.active);
    }

    complete(accountIdInput: unknown, claimIdInput: unknown): boolean {
        const claim = this.match(accountIdInput, claimIdInput);
        if (!claim) return false;
        this.active = null;
        if (readTextFile(this.filePath, '') !== claim.content) return false;
        writeTextFileAtomic(this.filePath, '');
        return true;
    }

    release(accountIdInput: unknown, claimIdInput: unknown): boolean {
        if (!this.match(accountIdInput, claimIdInput)) return false;
        this.active = null;
        return true;
    }

    private match(accountIdInput: unknown, claimIdInput: unknown): ActiveInviteBatch | null {
        if (!this.active) return null;
        const accountId = String(accountIdInput || '').trim();
        const claimId = Number(claimIdInput) || 0;
        return this.active.accountId === accountId && this.active.claimId === claimId
            ? this.active
            : null;
    }

    private copyClaim(claim: ActiveInviteBatch): InviteBatchClaim {
        return {
            claimId: claim.claimId,
            invites: claim.invites.map(invite => ({ ...invite })),
        };
    }
}

const sharedInviteBatch = new SharedInviteBatch();

module.exports = {
    SharedInviteBatch,
    parseShareInviteContent,
    sharedInviteBatch,
};
