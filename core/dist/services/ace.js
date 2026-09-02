"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * TSDK/ACE 生命周期 - 提取客户端安全数据并回灌服务端响应
 */
const { createScheduler } = require('./scheduler');
const { types } = require('../utils/proto');
const cryptoWasm = require('../utils/crypto-wasm');
const { log, logWarn } = require('../utils/utils');
const aceScheduler = createScheduler('ace');
let requestRunning = false;
let readyLogged = false;
let sendRequest = null;
let lastSpeedCheckAt = 0;
async function sendAntiData() {
    if (!sendRequest || requestRunning)
        return;
    const data = cryptoWasm.getDataToServer();
    if (!data || data.length === 0)
        return;
    requestRunning = true;
    try {
        const body = types.AntiDataRequest.encode(types.AntiDataRequest.create({ data })).finish();
        const { body: replyBody } = await sendRequest('gamepb.acepb.AceService', 'AntiData', Buffer.from(body), 10000);
        const reply = types.AntiDataReply.decode(replyBody);
        if (reply.result && reply.result.length > 0) {
            cryptoWasm.sendDataFromServer(Buffer.from(reply.result));
            if (!readyLogged) {
                readyLogged = true;
                log('ACE', `AntiData 链路正常: 上报 ${data.length} 字节，回灌 ${reply.result.length} 字节`);
            }
        }
    }
    catch (e) {
        logWarn('ACE', `AntiData 上报失败: ${e.message}`);
    }
    finally {
        requestRunning = false;
    }
}
function startAceRuntime(sender) {
    stopAceRuntime(false);
    sendRequest = sender;
    readyLogged = false;
    lastSpeedCheckAt = Date.now();
    aceScheduler.setIntervalTask('anti_data', 5000, sendAntiData, { preventOverlap: true });
    aceScheduler.setIntervalTask('process_received_data', 5000, () => cryptoWasm.processReceivedData());
    aceScheduler.setIntervalTask('heartbeat_tick', 25000, () => cryptoWasm.heartbeatTick());
    aceScheduler.setIntervalTask('speed_check', 30000, () => {
        const now = Date.now();
        cryptoWasm.detectSpeedHack(now - lastSpeedCheckAt);
        lastSpeedCheckAt = now;
    });
    aceScheduler.setIntervalTask('status_report', 150000, () => cryptoWasm.sendStatus());
}
function stopAceRuntime(destroyWasm = false) {
    aceScheduler.clearAll();
    requestRunning = false;
    readyLogged = false;
    sendRequest = null;
    lastSpeedCheckAt = 0;
    if (destroyWasm)
        cryptoWasm.destroyWasm();
}
module.exports = {
    sendAntiData,
    startAceRuntime,
    stopAceRuntime,
};
//# sourceMappingURL=ace.js.map