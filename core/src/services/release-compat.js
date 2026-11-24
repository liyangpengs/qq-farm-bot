const fs = require('node:fs');
const path = require('node:path');

const RELEASE_META_FILENAME = 'release-meta.json';
const UPDATE_SETTINGS_FILENAME = 'update-settings.json';

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

function pairedWebReleases(backendBaseDir, backendIds) {
    return backendIds.map(id => readReleaseMeta(path.join(backendBaseDir, id))?.pairedWebReleaseId).filter(Boolean);
}

// Read the immutable package's defaults without executing code from an older release.
function readReleaseIpcVersion(dir) {
    const contract = readOptionalText(path.join(dir, 'node_modules/@qq-farm-bot/session-contract/dist/constants.js'));
    return Number(/\bSESSION_IPC_VERSION\s*=\s*(\d+)/.exec(contract)?.[1]);
}

function readReleaseVersions(dir) {
    if (!dir || !fs.existsSync(path.join(dir, 'client.js'))) return null;
    const config = readOptionalText(path.join(dir, 'dist/config/config.js'));
    const qq = /\bDEFAULT_CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(config)?.[1];
    const wx = /\bDEFAULT_WX_CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(config)?.[1];
    const ipc = readReleaseIpcVersion(dir);
    return qq && wx && ipc ? { qq, wx, ipc } : null;
}

function compareReleaseVersions(target, current, hostIpcVersion = current?.ipc) {
    if (!target || !current) {
        const reason = target ? '无法读取当前运行版本信息' : '备份文件不完整，缺少版本信息';
        return { compatible: false, outdated: false, reasons: [reason] };
    }
    const reasons = [];
    if (target.qq !== current.qq) reasons.push(`QQ 客户端版本不同（${target.qq} ≠ ${current.qq}）`);
    if (target.wx !== current.wx) reasons.push(`微信客户端版本不同（${target.wx} ≠ ${current.wx}）`);
    if (target.ipc !== hostIpcVersion) reasons.push('游戏连接服务协议版本不兼容');
    return { compatible: reasons.length === 0, outdated: reasons.length > 0, reasons };
}

function readBackupEnabled(runtimeDir) {
    const raw = readOptionalText(path.join(runtimeDir, UPDATE_SETTINGS_FILENAME));
    if (!raw) return true;
    try {
        return JSON.parse(raw)?.keepBackups !== false;
    } catch {
        // An unreadable preference must never opt a deployment into deleting backups.
        return true;
    }
}

module.exports = {
    RELEASE_META_FILENAME,
    UPDATE_SETTINGS_FILENAME,
    readReleaseMeta,
    pairedWebReleases,
    readReleaseIpcVersion,
    readReleaseVersions,
    compareReleaseVersions,
    readBackupEnabled,
};
