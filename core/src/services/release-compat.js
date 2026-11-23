const fs = require('node:fs');
const path = require('node:path');

const RELEASE_META_FILENAME = 'release-meta.json';

function readOptionalText(filename) {
    try {
        return fs.readFileSync(filename, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return '';
        throw err;
    }
}

function readReleaseMeta(dir) {
    const text = readOptionalText(path.join(dir, RELEASE_META_FILENAME));
    return text ? JSON.parse(text) : null;
}

// Read the immutable package's defaults without executing code from an older release.
function readReleaseVersions(dir) {
    if (!dir || !fs.existsSync(path.join(dir, 'client.js'))) return null;
    const config = readOptionalText(path.join(dir, 'dist/config/config.js'));
    const contract = readOptionalText(path.join(dir, 'node_modules/@qq-farm-bot/session-contract/dist/constants.js'));
    const qq = /\bDEFAULT_CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(config)?.[1];
    const wx = /\bDEFAULT_WX_CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(config)?.[1];
    const ipc = Number(/\bSESSION_IPC_VERSION\s*=\s*(\d+)/.exec(contract)?.[1]);
    return qq && wx && ipc ? { qq, wx, ipc } : null;
}

function compareReleaseVersions(target, current, hostIpcVersion = current?.ipc) {
    if (!target || !current) {
        const reason = target ? '无法读取当前运行版本信息' : '备份缺少入口或版本信息';
        return { compatible: false, outdated: false, reasons: [reason] };
    }
    const reasons = [];
    if (target.qq !== current.qq) reasons.push(`QQ 客户端版本不同（${target.qq} ≠ ${current.qq}）`);
    if (target.wx !== current.wx) reasons.push(`微信客户端版本不同（${target.wx} ≠ ${current.wx}）`);
    if (target.ipc !== hostIpcVersion) reasons.push('会话宿主 IPC 版本不同');
    return { compatible: reasons.length === 0, outdated: reasons.length > 0, reasons };
}

module.exports = { RELEASE_META_FILENAME, readReleaseMeta, readReleaseVersions, compareReleaseVersions };
