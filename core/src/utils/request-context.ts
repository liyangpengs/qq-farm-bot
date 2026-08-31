export {};

const { AsyncLocalStorage } = require('node:async_hooks');
const { normalizeRequestClass } = require('./request-priority');

interface RequestContextStore {
    requestClass: string;
}

const storage: any = new AsyncLocalStorage();

function runWithRequestClass<T>(requestClass: any, run: () => T): T {
    const normalized = normalizeRequestClass(requestClass);
    if (!normalized) return run();
    return storage.run({ requestClass: normalized } as RequestContextStore, run);
}

function getAmbientRequestClass(): string | null {
    const store: RequestContextStore | undefined = storage.getStore();
    return store?.requestClass || null;
}

function classForSchedulerNamespace(namespace: any): string | null {
    const name = String(namespace || '').trim();
    if (!name || name === 'network' || name === 'ace' || name === 'worker_manager') return null;
    if (name === 'friend-pet-sync') return 'background';
    if (name.startsWith('friend')) return 'friend';
    return 'farm';
}

module.exports = {
    runWithRequestClass,
    getAmbientRequestClass,
    classForSchedulerNamespace,
};
