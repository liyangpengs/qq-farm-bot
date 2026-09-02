"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('node:fs');
const path = require('node:path');
const isPackaged = !!process.pkg;
function getResourceRoot() {
    // When compiled (node client.js): __dirname = core/dist/config/ → resources at core/src/
    // When tsx (tsx client.ts): __dirname = core/src/config/ → resources at core/src/
    const parent = path.join(__dirname, '..');
    if (!isPackaged) {
        // Check if we're inside dist/ (compiled mode)
        const parentName = path.basename(parent);
        if (parentName === 'dist') {
            return path.join(parent, '..', 'src');
        }
    }
    return parent;
}
function getResourcePath(...segments) {
    return path.join(getResourceRoot(), ...segments);
}
function getAppRootForWritable() {
    return isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '../..');
}
function getDataDir() {
    return path.join(getAppRootForWritable(), 'data');
}
function ensureDataDir() {
    const dir = getDataDir();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function getDataFile(filename) {
    return path.join(getDataDir(), filename);
}
function getShareFilePath() {
    return path.join(getAppRootForWritable(), 'share.txt');
}
module.exports = {
    isPackaged,
    getResourcePath,
    getDataDir,
    getDataFile,
    ensureDataDir,
    getShareFilePath,
};
//# sourceMappingURL=runtime-paths.js.map