export {};

interface StartupStep {
    name: string;
    run: () => Promise<any> | any;
}

interface StartupSequenceOptions {
    steps: readonly StartupStep[];
    canContinue: () => boolean;
    activateRuntime: () => Promise<any> | any;
    onStepError?: (name: string, error: any) => void;
}

async function runStartupSequence(options: StartupSequenceOptions): Promise<boolean> {
    for (const step of options.steps) {
        if (!options.canContinue()) return false;
        try {
            await step.run();
        } catch (error: any) {
            options.onStepError?.(step.name, error);
        }
    }

    if (!options.canContinue()) return false;
    try {
        await options.activateRuntime();
    } catch (error: any) {
        options.onStepError?.('runtime', error);
        return false;
    }
    return options.canContinue();
}

module.exports = {
    runStartupSequence,
};
