'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { TextDecoder } = require('node:util');

const DEFAULT_SOURCE = 'D:\\wxsource\\wx5306c5978fdb76e4-code';
const DEFAULT_OUTPUT = path.join(__dirname, 'json');
const BUNDLE_NAME = 'mainscene';
const ALL_CONFIG_DIR = 'allconfig';
const SELECTED_RESOURCES = [
    { name: 'ItemInfo', path: 'config/ItemInfo', assetName: 'ItemInfo' },
    { name: 'Plant', path: 'config/Plant', assetName: 'Plant' },
    { name: 'RoleLevel', path: 'config/RoleLevel', assetName: 'RoleLevel' },
    { name: 'Land', path: 'config/Land', assetName: 'Land' },
    { name: 'MutantEffect', path: 'config/mutant_effect', assetName: 'mutant_effect' },
    { name: 'BuffCfg', path: 'config/BuffCfg', assetName: 'BuffCfg' },
    { name: 'Illustrated', path: 'config/Illustrated', assetName: 'Illustrated' },
];
const SELECTED_BY_PATH = new Map(SELECTED_RESOURCES.map(resource => [resource.path, resource]));
const SELECTED_NAMES = SELECTED_RESOURCES.map(resource => resource.name);
const XOR_KEY = Buffer.from('NQF_SHANGXIANDAMAI_#2026_SECURE', 'utf8');
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 6;

function printUsage() {
    console.log(`用法：
  node tools/download-game-config.js
  node tools/download-game-config.js --source <反编译源码目录> --output <输出目录>

默认参数：
  --source  ${DEFAULT_SOURCE}
  --output  ${DEFAULT_OUTPUT}

输出规则：
  已指定配置  <output>/<配置名>.json
  其他配置    <output>/${ALL_CONFIG_DIR}/<资源名>.json`);
}

function parseArgs(argv) {
    const options = { source: DEFAULT_SOURCE, output: DEFAULT_OUTPUT };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (arg !== '--source' && arg !== '--output') throw new Error(`未知参数: ${arg}`);
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少路径参数`);
        options[arg.slice(2)] = path.resolve(value);
    }
    return options;
}

function readSettings(sourceDir) {
    const srcDir = path.join(sourceDir, 'src');
    let names;
    try {
        names = fs.readdirSync(srcDir).filter(name => /^settings(?:\.[^.]+)?\.json$/i.test(name)).sort();
    } catch (error) {
        throw new Error(`无法读取反编译源码目录 ${srcDir}: ${error.message}`);
    }
    const candidates = [];
    for (const name of names) {
        const filePath = path.join(srcDir, name);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const server = data?.assets?.server;
            const bundleVersion = data?.assets?.bundleVers?.[BUNDLE_NAME];
            if (typeof server === 'string' && server && typeof bundleVersion === 'string' && bundleVersion) {
                candidates.push({ filePath, server, bundleVersion });
            }
        } catch {}
    }
    if (candidates.length === 0) throw new Error(`在 ${srcDir} 中未找到包含 assets.server 和 ${BUNDLE_NAME} 版本的 settings JSON`);
    if (candidates.length > 1) throw new Error(`发现多个有效 settings 文件: ${candidates.map(item => item.filePath).join(', ')}`);
    const settings = candidates[0];
    const serverUrl = new URL(settings.server);
    if (serverUrl.protocol !== 'https:') throw new Error(`CDN 地址必须使用 HTTPS: ${settings.server}`);
    if (!serverUrl.pathname.endsWith('/')) serverUrl.pathname += '/';
    settings.server = serverUrl.href;
    return settings;
}

function download(url, options = {}, redirectCount = 0, originalOrigin = null) {
    const maxBytes = options.maxBytes || MAX_ASSET_BYTES;
    const target = new URL(url);
    const origin = originalOrigin || target.origin;
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return Promise.reject(new Error(`不支持的 URL 协议: ${target.protocol}`));
    const client = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = client.get(target, { headers: { Accept: 'application/json', 'User-Agent': 'qq-farm-bot-config-downloader/2.0' } }, response => {
            const status = response.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
                response.resume();
                if (redirectCount >= MAX_REDIRECTS) return reject(new Error(`重定向次数过多: ${target.href}`));
                const location = response.headers.location;
                if (!location) return reject(new Error(`重定向缺少 Location: ${target.href}`));
                const next = new URL(location, target);
                if (next.protocol !== 'https:' || next.origin !== origin) return reject(new Error(`拒绝跨源或非 HTTPS 重定向: ${next.href}`));
                return download(next.href, options, redirectCount + 1, origin).then(resolve, reject);
            }
            if (status !== 200) { response.resume(); return reject(new Error(`HTTP ${status}: ${target.href}`)); }
            const chunks = [];
            let total = 0;
            response.on('data', chunk => {
                total += chunk.length;
                if (total > maxBytes) { response.destroy(new Error(`响应超过 ${maxBytes} 字节限制: ${target.href}`)); return; }
                chunks.push(chunk);
            });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`请求超时 (${REQUEST_TIMEOUT_MS}ms): ${target.href}`)));
        request.on('error', reject);
    });
}

async function downloadJson(url, maxBytes) {
    const buffer = await download(url, { maxBytes });
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch (error) { throw new Error(`响应不是有效 UTF-8: ${url}: ${error.message}`); }
    try { return JSON.parse(text); }
    catch (error) { throw new Error(`响应不是有效 JSON: ${url}: ${error.message}`); }
}

function decodeCocosUuid(value) {
    const uuid = String(value || '');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) return uuid.toLowerCase();
    if (!/^[A-Za-z0-9+/]{22}$/.test(uuid)) throw new Error(`不支持的 Cocos UUID: ${uuid}`);
    let hex = uuid.slice(0, 2);
    for (let i = 2; i < 22; i += 2) {
        const left = BASE64_ALPHABET.indexOf(uuid[i]);
        const right = BASE64_ALPHABET.indexOf(uuid[i + 1]);
        if (left < 0 || right < 0) throw new Error(`Cocos UUID 含无效字符: ${uuid}`);
        hex += (left >> 2).toString(16);
        hex += (((left & 3) << 2) | (right >> 4)).toString(16);
        hex += (right & 15).toString(16);
    }
    return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function buildImportVersionMap(manifest) {
    const values = manifest?.versions?.import;
    if (!Array.isArray(values) || values.length % 2 !== 0) throw new Error('bundle manifest 的 versions.import 结构无效');
    const result = new Map();
    for (let i = 0; i < values.length; i += 2) result.set(Number(values[i]), String(values[i + 1] || ''));
    return result;
}

function sanitizeFilePart(value) {
    const sanitized = String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '');
    return sanitized || 'unnamed';
}

function assignOutputPaths(resources) {
    const used = new Set();
    for (const resource of resources) {
        if (resource.selected) { resource.outputRelative = `${resource.selected.name}.json`; continue; }
        let fileName = `${sanitizeFilePart(resource.assetName)}.json`;
        if (used.has(fileName.toLowerCase())) fileName = `${resource.path.split('/').map(sanitizeFilePart).join('__')}.json`;
        if (used.has(fileName.toLowerCase())) fileName = `${sanitizeFilePart(resource.bundleName)}__${fileName}`;
        if (used.has(fileName.toLowerCase())) throw new Error(`无法为配置生成唯一文件名: ${resource.path}`);
        used.add(fileName.toLowerCase());
        resource.outputRelative = path.join(ALL_CONFIG_DIR, fileName);
    }
}

function resolveResources(manifest, server, bundleName, bundleVersion) {
    if (!manifest || !Array.isArray(manifest.uuids) || !manifest.paths || typeof manifest.paths !== 'object') throw new Error('bundle manifest 缺少 uuids 或 paths');
    const versions = buildImportVersionMap(manifest);
    const entries = [];
    const seenPaths = new Set();
    for (const [rawIndex, pathEntry] of Object.entries(manifest.paths)) {
        if (!Array.isArray(pathEntry) || typeof pathEntry[0] !== 'string') continue;
        const resourcePath = pathEntry[0];
        if (!/^config\/.+/i.test(resourcePath)) continue;
        if (seenPaths.has(resourcePath)) throw new Error(`manifest 中存在重复配置路径: ${resourcePath}`);
        seenPaths.add(resourcePath);
        const index = Number(rawIndex);
        const compressedUuid = manifest.uuids[index];
        const hash = versions.get(index);
        if (!Number.isSafeInteger(index) || typeof compressedUuid !== 'string' || !hash) throw new Error(`配置 ${resourcePath} 缺少 UUID 或 import 版本 (index=${rawIndex})`);
        const uuid = decodeCocosUuid(compressedUuid);
        const assetName = resourcePath.split('/').filter(Boolean).pop();
        const selected = SELECTED_BY_PATH.get(resourcePath) || null;
        const relative = `remote/${bundleName}/import/${uuid.slice(0, 2)}/${uuid}.${hash}.json`;
        entries.push({ name: selected?.name || assetName, assetName: selected?.assetName || assetName, bundleName, bundleVersion, path: resourcePath, selected, index, uuid, hash, url: new URL(relative, server).href });
    }
    entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    assignOutputPaths(entries);
    for (const selected of SELECTED_RESOURCES) {
        const matches = entries.filter(resource => resource.path === selected.path);
        if (matches.length !== 1) throw new Error(`manifest 中指定配置 ${selected.path} 匹配数量异常: ${matches.length}`);
    }
    if (entries.length === 0) throw new Error(`bundle ${bundleName} 中未发现 config/* 配置`);
    return entries;
}

function extractTextAsset(payload, expectedName) {
    if (!Array.isArray(payload)) throw new Error(`${expectedName} 的 Cocos payload 不是数组`);
    const matches = [];
    const visit = value => {
        if (!Array.isArray(value)) return;
        if (value.length >= 3 && typeof value[1] === 'string' && typeof value[2] === 'string') matches.push({ assetName: value[1], text: value[2] });
        for (const child of value) visit(child);
    };
    visit(payload);
    const exact = matches.filter(item => item.assetName === expectedName);
    if (exact.length === 1) return exact[0];
    if (exact.length === 0 && matches.length === 1) return matches[0];
    throw new Error(`${expectedName} 的 TextAsset 实例匹配数量异常: exact=${exact.length}, total=${matches.length}`);
}

function decodeBase64Strict(value, resourceName) {
    const text = String(value || '');
    if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error(`${resourceName} 的 text 不是严格 Base64`);
    const decoded = Buffer.from(text, 'base64');
    if (decoded.toString('base64') !== text) throw new Error(`${resourceName} 的 Base64 存在非规范或损坏内容`);
    return decoded;
}

function decodeConfig(text, resourceName) {
    const encrypted = decodeBase64Strict(text, resourceName);
    const plain = Buffer.allocUnsafe(encrypted.length);
    for (let i = 0; i < encrypted.length; i += 1) plain[i] = encrypted[i] ^ XOR_KEY[i % XOR_KEY.length];
    let jsonText;
    try { jsonText = new TextDecoder('utf-8', { fatal: true }).decode(plain); }
    catch (error) { throw new Error(`${resourceName} 解密结果不是有效 UTF-8: ${error.message}`); }
    try { return JSON.parse(jsonText); }
    catch (error) { throw new Error(`${resourceName} 解密结果不是有效 JSON: ${error.message}`); }
}

function assertConfigArray(configs, resourceName) {
    const data = configs.get(resourceName);
    if (!Array.isArray(data)) throw new Error(`${resourceName} 顶层必须是数组`);
    return data;
}

function assertPositiveUniqueIds(list, resourceName, fieldName = 'id') {
    const seen = new Set();
    for (let i = 0; i < list.length; i += 1) {
        const id = list[i]?.[fieldName];
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${resourceName}[${i}].${fieldName} 不是正安全整数: ${id}`);
        if (seen.has(id)) throw new Error(`${resourceName} 存在重复 ${fieldName}: ${id}`);
        seen.add(id);
    }
    return seen;
}

function validateSelectedConfigs(configs) {
    const itemInfo = assertConfigArray(configs, 'ItemInfo');
    const plantConfig = assertConfigArray(configs, 'Plant');
    const roleLevel = assertConfigArray(configs, 'RoleLevel');
    const landConfig = assertConfigArray(configs, 'Land');
    const mutantEffect = assertConfigArray(configs, 'MutantEffect');
    const itemIds = assertPositiveUniqueIds(itemInfo, 'ItemInfo');
    assertPositiveUniqueIds(plantConfig, 'Plant');
    assertPositiveUniqueIds(landConfig, 'Land');
    assertPositiveUniqueIds(mutantEffect, 'MutantEffect');
    for (const effect of mutantEffect) if (typeof effect?.effect_name !== 'string' || !effect.effect_name.trim()) throw new Error(`MutantEffect ${effect?.id} 缺少 effect_name`);
    const landCoordinates = new Set();
    for (let i = 0; i < landConfig.length; i += 1) {
        const land = landConfig[i];
        if (!Number.isSafeInteger(land?.grid_x) || !Number.isSafeInteger(land?.grid_y)) throw new Error(`Land[${i}] 网格坐标无效: (${land?.grid_x}, ${land?.grid_y})`);
        const coordinate = `${land.grid_x},${land.grid_y}`;
        if (landCoordinates.has(coordinate)) throw new Error(`Land 存在重复网格坐标: ${coordinate}`);
        landCoordinates.add(coordinate);
    }
    if (landConfig.length === 0) throw new Error('Land 不能为空');
    const seedIds = new Set();
    const unusualFruitTypes = [];
    const itemsById = new Map(itemInfo.map(item => [item.id, item]));
    for (let i = 0; i < plantConfig.length; i += 1) {
        const plant = plantConfig[i];
        const seedId = plant?.seed_id;
        if (seedId !== null && seedId !== undefined) {
            if (!Number.isSafeInteger(seedId) || seedId <= 0) throw new Error(`Plant[${i}].seed_id 无效: ${seedId}`);
            if (seedIds.has(seedId)) throw new Error(`Plant 存在重复 seed_id: ${seedId}`);
            seedIds.add(seedId);
            if (!itemIds.has(seedId)) throw new Error(`Plant ${plant.id} 引用了不存在的 seed ItemInfo: ${seedId}`);
        }
        const fruitId = plant?.fruit?.id;
        if (!Number.isSafeInteger(fruitId) || fruitId <= 0) throw new Error(`Plant ${plant?.id} 的 fruit.id 无效: ${fruitId}`);
        const fruitItem = itemsById.get(fruitId);
        if (!fruitItem) throw new Error(`Plant ${plant.id} 引用了不存在的 fruit ItemInfo: ${fruitId}`);
        if (fruitItem.type !== 6) unusualFruitTypes.push({ plantId: plant.id, fruitId, type: fruitItem.type });
    }
    let previousExp = -1;
    for (let i = 0; i < roleLevel.length; i += 1) {
        const row = roleLevel[i];
        const expectedLevel = i + 1;
        if (row?.level !== expectedLevel) throw new Error(`RoleLevel[${i}].level 应为 ${expectedLevel}，实际为 ${row?.level}`);
        if (!Number.isSafeInteger(row.exp) || row.exp < 0) throw new Error(`RoleLevel 等级 ${row.level} 的 exp 无效: ${row.exp}`);
        if (i > 0 && row.exp <= previousExp) throw new Error(`RoleLevel 等级 ${row.level} 的 exp 未严格递增: ${row.exp}`);
        previousExp = row.exp;
    }
    if (roleLevel.length === 0) throw new Error('RoleLevel 不能为空');
    return { unusualFruitTypes };
}

function describeConfig(data) {
    if (Array.isArray(data)) return `${data.length} 条`;
    if (data && typeof data === 'object') return `${Object.keys(data).length} 个顶层字段`;
    return `顶层类型 ${data === null ? 'null' : typeof data}`;
}

function serializeConfig(data) { return `${JSON.stringify(data, null, 2)}\n`; }

function writeAllAtomically(outputDir, resources, configsByPath) {
    fs.mkdirSync(outputDir, { recursive: true });
    const token = `${process.pid}-${Date.now()}`;
    const usedPaths = new Set();
    const records = resources.map(resource => {
        const pathKey = resource.outputRelative.toLowerCase();
        if (usedPaths.has(pathKey)) throw new Error(`输出路径冲突: ${resource.outputRelative}`);
        usedPaths.add(pathKey);
        const finalPath = path.join(outputDir, resource.outputRelative);
        const directory = path.dirname(finalPath);
        const fileName = path.basename(finalPath);
        fs.mkdirSync(directory, { recursive: true });
        return { resource, finalPath, tempPath: path.join(directory, `.${fileName}.${token}.tmp`), backupPath: path.join(directory, `.${fileName}.${token}.bak`), hadOriginal: false, installed: false };
    });
    try {
        for (const record of records) {
            fs.writeFileSync(record.tempPath, serializeConfig(configsByPath.get(record.resource.path)), { encoding: 'utf8', flag: 'wx' });
            JSON.parse(fs.readFileSync(record.tempPath, 'utf8'));
        }
        for (const record of records) {
            record.hadOriginal = fs.existsSync(record.finalPath);
            if (record.hadOriginal) fs.renameSync(record.finalPath, record.backupPath);
            fs.renameSync(record.tempPath, record.finalPath);
            record.installed = true;
        }
        for (const record of records) if (record.hadOriginal && fs.existsSync(record.backupPath)) { try { fs.unlinkSync(record.backupPath); } catch {} }
    } catch (error) {
        const rollbackErrors = [];
        for (const record of [...records].reverse()) {
            try {
                if (record.installed && fs.existsSync(record.finalPath)) fs.unlinkSync(record.finalPath);
                if (record.hadOriginal && fs.existsSync(record.backupPath)) fs.renameSync(record.backupPath, record.finalPath);
            } catch (rollbackError) { rollbackErrors.push(`${record.resource.path}: ${rollbackError.message}`); }
        }
        if (rollbackErrors.length > 0) error.message += `；回滚失败，备份文件已保留: ${rollbackErrors.join(' | ')}`;
        throw error;
    } finally {
        for (const record of records) { try { if (fs.existsSync(record.tempPath)) fs.unlinkSync(record.tempPath); } catch {} }
    }
}

async function mapWithConcurrency(items, concurrency, callback) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            results[index] = await callback(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()));
    return results;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const settings = readSettings(options.source);
    const manifestUrl = new URL(`remote/${BUNDLE_NAME}/config.${settings.bundleVersion}.json`, settings.server).href;
    console.log(`[配置] settings: ${settings.filePath}`);
    console.log(`[配置] CDN: ${settings.server}`);
    console.log(`[配置] bundle: ${BUNDLE_NAME}@${settings.bundleVersion}`);
    console.log(`[下载] ${manifestUrl}`);
    const manifest = await downloadJson(manifestUrl, MAX_MANIFEST_BYTES);
    const resources = resolveResources(manifest, settings.server, BUNDLE_NAME, settings.bundleVersion);
    const selectedCount = resources.filter(resource => resource.selected).length;
    console.log(`[发现] config/* 共 ${resources.length} 项：根目录 ${selectedCount} 项，${ALL_CONFIG_DIR} ${resources.length - selectedCount} 项`);
    const downloaded = await mapWithConcurrency(resources, DOWNLOAD_CONCURRENCY, async resource => {
        console.log(`[下载] ${resource.path}: ${resource.url}`);
        const payload = await downloadJson(resource.url, MAX_ASSET_BYTES);
        const textAsset = extractTextAsset(payload, resource.assetName);
        const data = decodeConfig(textAsset.text, resource.path);
        console.log(`[解析] ${resource.path}: ${describeConfig(data)} (uuid=${resource.uuid}, hash=${resource.hash})`);
        return { resource, data };
    });
    const configsByPath = new Map(downloaded.map(item => [item.resource.path, item.data]));
    const selectedConfigs = new Map(SELECTED_RESOURCES.map(resource => [resource.name, configsByPath.get(resource.path)]));
    const validation = validateSelectedConfigs(selectedConfigs);
    writeAllAtomically(options.output, resources, configsByPath);
    console.log(`[完成] 输出目录: ${options.output}`);
    for (const name of SELECTED_NAMES) console.log(`[完成] ${name}.json: ${describeConfig(selectedConfigs.get(name))}`);
    console.log(`[完成] ${ALL_CONFIG_DIR}: ${resources.length - selectedCount} 个配置文件`);
    if (validation.unusualFruitTypes.length > 0) {
        const types = [...new Set(validation.unusualFruitTypes.map(item => item.type))].sort((a, b) => a - b);
        console.log(`[提示] ${validation.unusualFruitTypes.length} 个 Plant 果实引用的 ItemInfo.type 不是 6（特殊果实类型: ${types.join(', ')}）`);
    }
}

main().catch(error => {
    console.error(`[失败] ${error.message}`);
    process.exitCode = 1;
});
