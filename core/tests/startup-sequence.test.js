const assert = require('node:assert/strict');
const test = require('node:test');

const { runStartupSequence } = require('../dist/app/startup-sequence');

test('startup steps run serially before the automation runtime starts', async () => {
    const events = [];
    let active = 0;
    let maxActive = 0;

    const step = (name, error = null) => async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(name);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        if (error) throw error;
    };

    const completed = await runStartupSequence({
        steps: [
            { name: 'daily', run: step('daily') },
            { name: 'tasks', run: step('tasks', new Error('task failed')) },
            { name: 'mystery-shop', run: step('mystery-shop') },
        ],
        canContinue: () => true,
        activateRuntime: () => {
            events.push('runtime');
        },
        onStepError: (name, error) => {
            events.push(`error:${name}:${error.message}`);
        },
    });

    assert.equal(completed, true);
    assert.equal(maxActive, 1);
    assert.deepEqual(events, [
        'daily',
        'tasks',
        'error:tasks:task failed',
        'mystery-shop',
        'runtime',
    ]);
});

test('startup stops without activating runtime when the login generation changes', async () => {
    const events = [];
    let current = true;

    const completed = await runStartupSequence({
        steps: [
            {
                name: 'daily',
                run: async () => {
                    events.push('daily');
                    current = false;
                },
            },
            { name: 'tasks', run: async () => events.push('tasks') },
        ],
        canContinue: () => current,
        activateRuntime: () => events.push('runtime'),
    });

    assert.equal(completed, false);
    assert.deepEqual(events, ['daily']);
});

test('runtime activation failures are reported without completing startup', async () => {
    const errors = [];

    const completed = await runStartupSequence({
        steps: [],
        canContinue: () => true,
        activateRuntime: () => {
            throw new Error('runtime failed');
        },
        onStepError: (name, error) => errors.push(`${name}:${error.message}`),
    });

    assert.equal(completed, false);
    assert.deepEqual(errors, ['runtime:runtime failed']);
});
