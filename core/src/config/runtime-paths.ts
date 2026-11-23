export {};
const fs = require('node:fs');
const path = require('node:path');
const { resolveRuntimePaths, resolveWebRootInfo } = require('@qq-farm-bot/session-contract');
const isPackaged: boolean = !!(process as any).pkg;

function getResourceRoot(): string {
    const parent = path.join(__dirname, '..');
    // 编译和打包后仍从 src 读取协议、配置和 WASM 等静态资源。
    if (path.basename(parent) === 'dist') return path.join(parent, '..', 'src');
    return parent;
}

function getResourcePath(...segments: string[]): string {
    return path.join(getResourceRoot(), ...segments);
}

function getAppRootForWritable(): string {
    return isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '../..');
}

function getRuntimePaths() {
    const appRoot = getAppRootForWritable();
    return resolveRuntimePaths({
        appRoot,
        isPackaged,
        defaultRuntimeDir: isPackaged ? path.join(appRoot, 'runtime') : path.resolve(appRoot, '../runtime'),
        defaultResourceRoot: getResourceRoot(),
        defaultWebRoot: path.resolve(__dirname, '../../../web/dist'),
    });
}

function getWebRootInfo() {
    return resolveWebRootInfo(getRuntimePaths().runtimeDir, path.resolve(__dirname, '../../../web/dist'));
}

function getDataDir(): string {
    return process.env.FARM_DATA_DIR ? path.resolve(process.env.FARM_DATA_DIR) : path.join(getAppRootForWritable(), 'data');
}

function ensureDataDir(): string {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getDataFile(filename: string): string {
    return path.join(getDataDir(), filename);
}

function getShareFilePath(): string {
    return getRuntimePaths().shareFilePath;
}

module.exports = {
    isPackaged,
    getResourcePath,
    getRuntimePaths,
    getWebRootInfo,
    getDataDir,
    getDataFile,
    ensureDataDir,
    getShareFilePath,
};
