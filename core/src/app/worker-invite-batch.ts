export {};

interface InviteBatch {
    claimId: number;
    invites: any[];
}

interface InviteBatchOptions {
    notify: (message: { type: string; claimId: number }) => void;
    processInvites: (invites: any[]) => Promise<any> | any;
    submitTask: (
        name: string,
        run: () => Promise<any> | any,
        options: { priority: 'maintenance'; dedupeKey: string },
    ) => Promise<any>;
}

async function runClaimedInviteBatch(batch: InviteBatch, options: InviteBatchOptions): Promise<void> {
    if (!batch?.claimId || !Array.isArray(batch.invites)) return;

    let completed = false;
    try {
        await options.submitTask(
            'bootstrap.invites',
            () => options.processInvites(batch.invites),
            { priority: 'maintenance', dedupeKey: 'bootstrap.invites' },
        );
        completed = true;
    } finally {
        options.notify({
            type: completed ? 'invite_batch_complete' : 'invite_batch_release',
            claimId: batch.claimId,
        });
    }
}

module.exports = {
    runClaimedInviteBatch,
};
