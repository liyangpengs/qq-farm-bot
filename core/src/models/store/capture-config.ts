export {};

const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../../config/runtime-paths');

const CAPTURE_CONFIG_FILE: string = getDataFile('capture-config.json');

const DEFAULT_CAPTURE_CONFIG = {
    enabled: false,
    embedded: true,
    apiBase: 'http://127.0.0.1:8450',
    apiToken: '',
    autoImportQqGids: true,
};

interface CaptureConfig {
    enabled: boolean;
    embedded: boolean;
    apiBase: string;
    apiToken: string;
    autoImportQqGids: boolean;
}

function loadRaw(): Record<string, any> {
    ensureDataDir();
    try {
        if (!fs.existsSync(CAPTURE_CONFIG_FILE)) return {};
        const data = JSON.parse(fs.readFileSync(CAPTURE_CONFIG_FILE, 'utf8'));
        return (data && typeof data === 'object') ? data : {};
    } catch {
        return {};
    }
}

function saveRaw(data: Record<string, any>): void {
    ensureDataDir();
    try {
        fs.writeFileSync(CAPTURE_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e: any) {
        console.error('保存抓包配置失败:', e.message);
    }
}

function getCaptureConfig(): CaptureConfig {
    const saved = loadRaw();
    return {
        enabled: saved.enabled === true,
        embedded: saved.embedded !== false,
        apiBase: String(saved.apiBase || DEFAULT_CAPTURE_CONFIG.apiBase).trim(),
        apiToken: String(saved.apiToken || '').trim(),
        autoImportQqGids: saved.autoImportQqGids !== false,
    };
}

function setCaptureConfig(config: any): CaptureConfig | null {
    if (!config || typeof config !== 'object') return null;
    const current = getCaptureConfig();
    const next: CaptureConfig = {
        enabled: config.enabled === true,
        embedded: config.embedded !== false,
        apiBase: String(config.apiBase || current.apiBase || DEFAULT_CAPTURE_CONFIG.apiBase).trim(),
        apiToken: (config.apiToken === undefined || config.apiToken === null || config.apiToken === '')
            ? current.apiToken
            : String(config.apiToken).trim(),
        autoImportQqGids: config.autoImportQqGids !== false,
    };
    saveRaw(next);
    return { ...next };
}

module.exports = {
    DEFAULT_CAPTURE_CONFIG,
    getCaptureConfig,
    setCaptureConfig,
};
