"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { TsdkRuntime } = require('./tsdk-runtime');
let runtime = null;
function getRuntime() {
    if (!runtime)
        runtime = new TsdkRuntime();
    return runtime;
}
async function initWasm() {
    await getRuntime().init();
}
async function encryptBuffer(buffer) {
    await initWasm();
    return getRuntime().transform(buffer, false);
}
async function decryptBuffer(buffer) {
    await initWasm();
    return getRuntime().transform(buffer, true);
}
async function bindUser(openId) {
    await initWasm();
    getRuntime().bindUser(openId);
}
function getEncryptedInitInfo() {
    return getRuntime().getEncryptedInitInfo();
}
function getDataToServer() {
    return getRuntime().getDataToServer();
}
function sendDataFromServer(data) {
    getRuntime().sendDataFromServer(data);
}
function heartbeatTick() {
    getRuntime().heartbeatTick();
}
function processReceivedData() {
    getRuntime().processReceivedData();
}
function sendStatus() {
    getRuntime().sendStatus();
}
function detectSpeedHack(elapsedMs) {
    getRuntime().detectSpeedHack(elapsedMs);
}
function destroyWasm() {
    if (runtime)
        runtime.destroy();
    runtime = null;
}
module.exports = {
    initWasm,
    encryptBuffer,
    decryptBuffer,
    bindUser,
    getEncryptedInitInfo,
    getDataToServer,
    sendDataFromServer,
    heartbeatTick,
    processReceivedData,
    sendStatus,
    detectSpeedHack,
    destroyWasm,
};
//# sourceMappingURL=crypto-wasm.js.map