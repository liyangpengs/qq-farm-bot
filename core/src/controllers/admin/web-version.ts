export {};

const fs = require('node:fs');
const path = require('node:path');
const { getWebRootInfo } = require('../../config/runtime-paths');

export interface WebBuildInfo {
    buildId: string;
    appVersion: string;
    builtAt: number;
}

let cachedEntry: {
    filePath: string;
    mtimeMs: number;
    size: number;
    info: WebBuildInfo | null;
} | null = null;

function readWebBuildInfo(webRoot?: string): WebBuildInfo | null {
    try {
        const targetRoot = webRoot ? path.resolve(webRoot) : getWebRootInfo().webRoot;
        const versionFile = path.join(targetRoot, 'version.json');
        const stat = fs.statSync(versionFile);
        if (cachedEntry
            && cachedEntry.filePath === versionFile
            && cachedEntry.mtimeMs === stat.mtimeMs
            && cachedEntry.size === stat.size) {
            return cachedEntry.info;
        }
        const parsed = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
        const buildId = typeof parsed?.buildId === 'string' ? parsed.buildId.trim() : '';
        const info: WebBuildInfo | null = buildId
            ? {
                buildId,
                appVersion: typeof parsed?.appVersion === 'string' ? parsed.appVersion.trim() : '',
                builtAt: Number(parsed?.builtAt) || 0,
            }
            : null;
        cachedEntry = {
            filePath: versionFile,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            info,
        };
        return info;
    } catch {
        return null;
    }
}

function getActiveWebBuildId(): string {
    return readWebBuildInfo()?.buildId || '';
}

module.exports = {
    readWebBuildInfo,
    getActiveWebBuildId,
};
