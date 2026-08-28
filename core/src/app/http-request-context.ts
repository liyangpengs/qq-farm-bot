import { AsyncLocalStorage } from 'node:async_hooks';

export {};

interface HttpRequestContext {
    requestId: string;
}

const httpRequestContext = new AsyncLocalStorage<HttpRequestContext>();

function runWithHttpRequestContext<T>(requestId: string, run: () => T): T {
    return httpRequestContext.run({ requestId: String(requestId || '') }, run);
}

function getHttpRequestId(): string {
    return httpRequestContext.getStore()?.requestId || '';
}

module.exports = {
    getHttpRequestId,
    runWithHttpRequestContext,
};
