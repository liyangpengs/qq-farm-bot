export {};

const { getState } = require('./state');
const { prepareAction, operate } = require('./actions');

module.exports = { getRanchState: getState, prepareRanchAction: prepareAction, operateRanch: operate };
