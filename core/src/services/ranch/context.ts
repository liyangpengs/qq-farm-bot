export {};

const { AsyncLocalStorage } = require('node:async_hooks');

interface SendContext {
    check: (service: string, method: string) => Error | null;
    onSent: (service: string, method: string) => void;
}

const context = new AsyncLocalStorage();
function runWithSendContext<T>(value: SendContext, run: () => T): T {
    return context.run(value, run);
}
function getAmbientSendContext(): SendContext | undefined { return context.getStore(); }

module.exports = { runWithSendContext, getAmbientSendContext };
