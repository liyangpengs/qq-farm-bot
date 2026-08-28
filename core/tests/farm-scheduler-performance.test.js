const assert = require('node:assert/strict');
const test = require('node:test');

test('farm checks expose get-lands as an inline phase of the queued farm task', async (t) => {
    const runner = require('../dist/app/account-task-runner');
    const store = require('../dist/models/store');
    const network = require('../dist/utils/network');
    const farmApi = require('../dist/services/farm/api');
    const visitStrategy = require('../dist/services/friend/visit-strategy');
    const schedulerModulePath = require.resolve('../dist/services/farm/scheduler');
    const originals = {
        isAutomationOn: store.isAutomationOn,
        getUserState: network.getUserState,
        getAllLands: farmApi.getAllLands,
        inFarmQuietHours: visitStrategy.inFarmQuietHours,
    };
    t.after(() => {
        runner.setAccountTaskMetricObserver(null);
        store.isAutomationOn = originals.isAutomationOn;
        network.getUserState = originals.getUserState;
        farmApi.getAllLands = originals.getAllLands;
        visitStrategy.inFarmQuietHours = originals.inFarmQuietHours;
        delete require.cache[schedulerModulePath];
    });

    const metrics = [];
    runner.setAccountTaskMetricObserver(metric => metrics.push(metric));
    store.isAutomationOn = key => key === 'farm';
    network.getUserState = () => ({ gid: 99, accountId: 'account-1' });
    farmApi.getAllLands = async () => ({ lands: [] });
    visitStrategy.inFarmQuietHours = () => false;

    delete require.cache[schedulerModulePath];
    const { checkFarm } = require(schedulerModulePath);
    assert.equal(await checkFarm(), false);

    const farm = metrics.find(metric => metric.name === 'farm.check');
    const getLands = metrics.find(metric => metric.name === 'farm.phase.get-lands');
    assert.ok(farm);
    assert.ok(getLands);
    assert.equal(getLands.inline, true);
    assert.equal(getLands.parentTaskId, farm.taskId);
    assert.equal(getLands.parentTaskName, 'farm.check');
});
