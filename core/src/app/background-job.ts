export {};

type BackgroundJobOutcome = 'success' | 'error' | 'cancelled';

interface BackgroundJobHandlers<T> {
    onSuccess?: (value: T) => void;
    onError?: (error: any) => void;
    onSettled?: (outcome: BackgroundJobOutcome) => void;
}

class BackgroundJob {
    private completion: Promise<void> | null = null;
    private controller: AbortController | null = null;

    start<T>(run: (signal: AbortSignal) => Promise<T> | T, handlers: BackgroundJobHandlers<T> = {}): boolean {
        if (this.completion) return false;

        const controller = new AbortController();
        this.controller = controller;
        const work = Promise.resolve().then(() => run(controller.signal));
        const completion = work.then(
            (value): BackgroundJobOutcome => {
                if (controller.signal.aborted) return 'cancelled';
                this.invoke(handlers.onSuccess, value);
                return 'success';
            },
            (error): BackgroundJobOutcome => {
                if (controller.signal.aborted) return 'cancelled';
                this.invoke(handlers.onError, error);
                return 'error';
            },
        ).then((outcome) => {
            if (this.completion === completion) {
                this.completion = null;
                this.controller = null;
            }
            this.invoke(handlers.onSettled, outcome);
        });
        this.completion = completion;
        return true;
    }

    abort(): void {
        this.controller?.abort();
    }

    isRunning(): boolean {
        return this.completion !== null;
    }

    wait(): Promise<void> {
        return this.completion || Promise.resolve();
    }

    private invoke<T>(callback: ((value: T) => void) | undefined, value?: T): void {
        if (typeof callback !== 'function') return;
        try {
            callback(value as T);
        } catch {}
    }
}

module.exports = {
    BackgroundJob,
};
