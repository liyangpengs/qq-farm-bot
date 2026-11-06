export {};

const { AsyncLocalStorage } = require('node:async_hooks');

interface AutomationLockStore {
    exclusive: true;
    active: boolean;
}

const storage: any = new AsyncLocalStorage();
let tail: Promise<void> = Promise.resolve();
let running = false;

function runExclusiveAutomationTask<T>(
    taskName: string,
    taskFn: () => T | PromiseLike<T>,
    options: { detached?: boolean } = {},
): Promise<T> {
    const store: AutomationLockStore | undefined = storage.getStore();
    if (!options.detached && store && store.exclusive && store.active) return Promise.resolve(taskFn());

    const run = tail.then(async () => {
        running = true;
        const taskStore: AutomationLockStore = { exclusive: true, active: true };
        try {
            return await storage.run(taskStore, taskFn);
        } finally {
            taskStore.active = false;
            running = false;
        }
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
}

function isAutomationTaskRunning(): boolean {
    return running;
}

module.exports = {
    runExclusiveAutomationTask,
    isAutomationTaskRunning,
};
