export {};

interface WorkerApiDefinition {
    execution: 'queued' | 'direct' | 'self-queued' | 'read-fresh';
    allowOffline: boolean;
    handle: (args: any[]) => Promise<any> | any;
}

interface WorkerApiDispatchOptions {
    isAccountReady: () => boolean;
    onStarted?: () => void;
    requestId?: string;
    submitTask: (
        name: string,
        run: () => Promise<any> | any,
        options: { priority: 'interactive'; requestId?: string },
    ) => Promise<any>;
}

interface WorkerApiCallResult {
    result: any;
    error: { message: string; code?: string | number; name?: string } | string | null;
}

async function executeWorkerApiCall(
    method: any,
    args: any,
    registry: Map<string, WorkerApiDefinition>,
    options: WorkerApiDispatchOptions,
): Promise<WorkerApiCallResult> {
    const definition = registry.get(String(method || ''));
    if (!definition) return { result: null, error: 'Unknown method' };

    try {
        if (!definition.allowOffline && !options.isAccountReady()) {
            throw new Error('账号未连接');
        }

        const callArgs = Array.isArray(args) ? args : [];
        const run = () => {
            options.onStarted?.();
            return definition.handle(callArgs);
        };
        const taskOptions: { priority: 'interactive'; requestId?: string } = { priority: 'interactive' };
        if (options.requestId) taskOptions.requestId = options.requestId;
        const result = definition.execution === 'queued'
            ? await options.submitTask(`api:${method}`, run, taskOptions)
            : await run();
        return { result, error: null };
    } catch (error: any) {
        return {
            result: null,
            error: {
                message: String(error?.message || error || 'Worker API error'),
                code: error?.code,
                name: String(error?.name || 'Error'),
            },
        };
    }
}

module.exports = {
    executeWorkerApiCall,
};
