'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { TextDecoder } = require('node:util');

const DEFAULT_INPUT = path.join(__dirname, 'json');
const DEFAULT_OUTPUT = path.join(__dirname, 'img', 'seed_images');
const DEFAULT_SOURCE = 'D:\\wxsource\\wx5306c5978fdb76e4-code';
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 16;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function printUsage() {
    console.log(`用法：
  node tools/download-game-images.js
  node tools/download-game-images.js --input <JSON目录> --output <图片目录> --source <反编译源码目录>

参数：
  --input <dir>         ItemInfo.json 和 Plant.json 所在目录
  --output <dir>        图片输出目录
  --source <dir>        微信小程序反编译源码目录
  --concurrency <n>     下载并发数，1-32（默认 ${DEFAULT_CONCURRENCY}）
  --retries <n>         可重试错误的额外重试次数，0-10（默认 ${DEFAULT_RETRIES}）
  --help, -h            显示帮助

默认值：
  --input        ${DEFAULT_INPUT}
  --output       ${DEFAULT_OUTPUT}
  --source       ${DEFAULT_SOURCE}`);
}

function parseIntegerOption(value, name, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
    }
    return number;
}

function parseArgs(argv) {
    const options = {
        input: DEFAULT_INPUT,
        output: DEFAULT_OUTPUT,
        source: DEFAULT_SOURCE,
        concurrency: DEFAULT_CONCURRENCY,
        retries: DEFAULT_RETRIES,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (!['--input', '--output', '--source', '--concurrency', '--retries'].includes(arg)) {
            throw new Error(`未知参数: ${arg}`);
        }
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数`);
        if (arg === '--concurrency') options.concurrency = parseIntegerOption(value, arg, 1, 32);
        else if (arg === '--retries') options.retries = parseIntegerOption(value, arg, 0, 10);
        else options[arg.slice(2)] = path.resolve(value);
    }
    return options;
}

function decodeUtf8(buffer, label) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (error) {
        throw new Error(`${label} 不是有效 UTF-8: ${error.message}`);
    }
}

function readJsonArray(filePath, label) {
    let buffer;
    try { buffer = fs.readFileSync(filePath); } catch (error) {
        throw new Error(`无法读取 ${label}: ${filePath}: ${error.message}`);
    }
    let value;
    try { value = JSON.parse(decodeUtf8(buffer, label)); } catch (error) {
        throw new Error(`${label} 不是有效 JSON: ${error.message}`);
    }
    if (!Array.isArray(value)) throw new Error(`${label} 顶层必须是数组`);
    return { value, sha256: sha256(buffer), filePath };
}

function validatePositiveId(id, label) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} 不是正安全整数: ${id}`);
}

function loadInputs(inputDir) {
    const itemInput = readJsonArray(path.join(inputDir, 'ItemInfo.json'), 'ItemInfo.json');
    const plantInput = readJsonArray(path.join(inputDir, 'Plant.json'), 'Plant.json');
    const itemById = new Map();
    const plantIds = new Set();
    const errors = [];

    itemInput.value.forEach((item, index) => {
        try {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('必须是对象');
            validatePositiveId(item.id, `ItemInfo[${index}].id`);
            if (itemById.has(item.id)) throw new Error(`重复 id: ${item.id}`);
            itemById.set(item.id, { item, index });
        } catch (error) { errors.push(error.message); }
    });
    plantInput.value.forEach((plant, index) => {
        try {
            if (!plant || typeof plant !== 'object' || Array.isArray(plant)) throw new Error('必须是对象');
            validatePositiveId(plant.id, `Plant[${index}].id`);
            if (plantIds.has(plant.id)) throw new Error(`Plant 重复 id: ${plant.id}`);
            if (itemById.has(plant.id)) throw new Error(`ItemInfo 与 Plant 输出 id 冲突: ${plant.id}`);
            plantIds.add(plant.id);
        } catch (error) { errors.push(error.message); }
    });
    if (errors.length > 0) throw new Error(`输入校验失败 (${errors.length} 项):\n- ${errors.join('\n- ')}`);
    return { itemInput, plantInput, itemById };
}

function readSettings(sourceDir) {
    const srcDir = path.join(sourceDir, 'src');
    let names;
    try {
        names = fs.readdirSync(srcDir).filter(name => /^settings(?:\.[^.]+)?\.json$/i.test(name)).sort();
    } catch (error) {
        throw new Error(`无法读取反编译源码目录 ${srcDir}: ${error.message}`);
    }
    const matches = [];
    for (const name of names) {
        const filePath = path.join(srcDir, name);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const assets = data?.assets;
            if (typeof assets?.server === 'string' && Array.isArray(assets.remoteBundles)
                && assets.bundleVers && typeof assets.bundleVers === 'object') {
                matches.push({ filePath, assets });
            }
        } catch {}
    }
    if (matches.length !== 1) {
        throw new Error(`有效 settings 文件数量应为 1，实际为 ${matches.length}: ${matches.map(x => x.filePath).join(', ')}`);
    }
    const { filePath, assets } = matches[0];
    const serverUrl = new URL(assets.server);
    if (serverUrl.protocol !== 'https:') throw new Error(`CDN 必须使用 HTTPS: ${serverUrl.href}`);
    if (!serverUrl.pathname.endsWith('/')) serverUrl.pathname += '/';
    const remoteBundles = [];
    const seen = new Set();
    for (const bundle of assets.remoteBundles) {
        if (typeof bundle !== 'string' || !/^[A-Za-z0-9_-]+$/.test(bundle) || seen.has(bundle)) {
            throw new Error(`无效或重复 remote bundle: ${bundle}`);
        }
        const version = assets.bundleVers[bundle];
        if (typeof version !== 'string' || !/^[A-Za-z0-9_-]+$/.test(version)) {
            throw new Error(`remote bundle ${bundle} 缺少有效版本`);
        }
        seen.add(bundle);
        remoteBundles.push({ name: bundle, version });
    }
    return { filePath, server: serverUrl.href, remoteBundles };
}

function requestBuffer(url, maxBytes, redirectCount = 0, expectedOrigin = null) {
    const target = new URL(url);
    const origin = expectedOrigin || target.origin;
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return Promise.reject(Object.assign(new Error(`不支持的 URL 协议: ${target.protocol}`), { retryable: false }));
    }
    const client = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = client.get(target, {
            headers: { 'Accept': '*/*', 'User-Agent': 'qq-farm-bot-image-downloader/1.0' },
        }, response => {
            const status = response.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
                response.resume();
                if (redirectCount >= MAX_REDIRECTS) {
                    reject(Object.assign(new Error(`重定向次数过多: ${target.href}`), { retryable: false }));
                    return;
                }
                const next = new URL(response.headers.location || '', target);
                if (next.protocol !== 'https:' || next.origin !== origin) {
                    reject(Object.assign(new Error(`拒绝跨源或非 HTTPS 重定向: ${next.href}`), { retryable: false }));
                    return;
                }
                requestBuffer(next.href, maxBytes, redirectCount + 1, origin).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                response.resume();
                const retryable = [408, 429, 500, 502, 503, 504].includes(status);
                reject(Object.assign(new Error(`HTTP ${status}: ${target.href}`), {
                    retryable,
                    status,
                    retryAfter: response.headers['retry-after'],
                }));
                return;
            }
            const chunks = [];
            let total = 0;
            response.on('data', chunk => {
                total += chunk.length;
                if (total > maxBytes) {
                    response.destroy(Object.assign(new Error(`响应超过 ${maxBytes} 字节限制: ${target.href}`), { retryable: false }));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({
                buffer: Buffer.concat(chunks),
                contentType: String(response.headers['content-type'] || ''),
                url: target.href,
            }));
            response.on('error', error => reject(Object.assign(error, { retryable: true })));
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(Object.assign(new Error(`请求超时 (${REQUEST_TIMEOUT_MS}ms): ${target.href}`), { retryable: true }));
        });
        request.on('error', error => {
            if (typeof error.retryable !== 'boolean') error.retryable = true;
            reject(error);
        });
    });
}

function parseRetryAfter(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(10_000, Math.max(0, seconds * 1000));
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.min(10_000, Math.max(0, time - Date.now())) : 0;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function downloadWithRetry(url, maxBytes, retries) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try { return await requestBuffer(url, maxBytes); } catch (error) {
            lastError = error;
            if (!error.retryable || attempt >= retries) throw error;
            const retryAfter = parseRetryAfter(error.retryAfter);
            const delay = retryAfter || Math.min(4000, 500 * 2 ** attempt);
            await sleep(delay);
        }
    }
    throw lastError;
}

async function downloadJson(url, retries) {
    const response = await downloadWithRetry(url, MAX_MANIFEST_BYTES, retries);
    try { return JSON.parse(decodeUtf8(response.buffer, url)); } catch (error) {
        throw Object.assign(new Error(`manifest 不是有效 JSON: ${url}: ${error.message}`), { retryable: false });
    }
}

function decodeCocosUuid(value) {
    const input = String(value || '');
    const at = input.indexOf('@');
    const base = at >= 0 ? input.slice(0, at) : input;
    const suffix = at >= 0 ? input.slice(at) : '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)) {
        return base.toLowerCase() + suffix;
    }
    if (!/^[A-Za-z0-9+/]{22}$/.test(base)) throw new Error(`无效 Cocos UUID: ${input}`);
    let hex = base.slice(0, 2);
    for (let i = 2; i < 22; i += 2) {
        const left = BASE64_ALPHABET.indexOf(base[i]);
        const right = BASE64_ALPHABET.indexOf(base[i + 1]);
        if (left < 0 || right < 0) throw new Error(`无效 Cocos UUID: ${input}`);
        hex += (left >> 2).toString(16);
        hex += (((left & 3) << 2) | (right >> 4)).toString(16);
        hex += (right & 15).toString(16);
    }
    return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') + suffix;
}

function normalizeCocosUuid(value) {
    const input = String(value || '');
    const at = input.indexOf('@');
    const base = at >= 0 ? input.slice(0, at) : input;
    const suffix = at >= 0 ? input.slice(at) : '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)
        || /^[A-Za-z0-9+/]{22}$/.test(base)) {
        return decodeCocosUuid(base).split('@')[0] + suffix;
    }
    // Cocos 的 uuids 数组也包含 pack 短 ID；它们参与索引，但不是原生资源 UUID。
    return input;
}

function normalizeBaseUuid(value) { return normalizeCocosUuid(value).split('@')[0]; }

function pairsToMap(values, label, maxIndex) {
    if (!Array.isArray(values) || values.length % 2 !== 0) throw new Error(`${label} 必须是偶数长度数组`);
    const result = new Map();
    for (let i = 0; i < values.length; i += 2) {
        const index = Number(values[i]);
        const value = values[i + 1];
        if (!Number.isInteger(index) || index < 0 || index >= maxIndex) throw new Error(`${label} 索引越界: ${values[i]}`);
        if (result.has(index)) throw new Error(`${label} 重复索引: ${index}`);
        result.set(index, value);
    }
    return result;
}

function prepareManifest(name, version, raw) {
    if (!raw || typeof raw !== 'object' || raw.name !== name || !Array.isArray(raw.uuids)
        || !raw.paths || typeof raw.paths !== 'object' || !Array.isArray(raw.types)
        || !Array.isArray(raw.deps) || typeof raw.nativeBase !== 'string') {
        throw new Error(`bundle ${name} manifest 结构无效`);
    }
    const uuidLookup = new Map();
    raw.uuids.forEach((uuid, index) => {
        const normalized = normalizeCocosUuid(uuid);
        const list = uuidLookup.get(normalized) || [];
        list.push(index);
        uuidLookup.set(normalized, list);
    });
    const redirects = pairsToMap(raw.redirect || [], `${name}.redirect`, raw.uuids.length);
    for (const [index, ordinalValue] of redirects) {
        const ordinal = Number(ordinalValue);
        if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= raw.deps.length) {
            throw new Error(`${name}.redirect[${index}] 依赖序号无效: ${ordinalValue}`);
        }
        redirects.set(index, ordinal);
    }
    const nativeVersions = pairsToMap(raw.versions?.native || [], `${name}.versions.native`, raw.uuids.length);
    const extensionByIndex = new Map();
    for (const [extension, indices] of Object.entries(raw.extensionMap || {})) {
        if (!/^\.[A-Za-z0-9]+$/.test(extension) || !Array.isArray(indices)) throw new Error(`${name}.extensionMap 结构无效`);
        for (const value of indices) {
            const index = Number(value);
            if (!Number.isInteger(index) || index < 0 || index >= raw.uuids.length) throw new Error(`${name}.extensionMap 索引越界: ${value}`);
            if (extensionByIndex.has(index) && extensionByIndex.get(index) !== extension) throw new Error(`${name} index ${index} 有多个扩展名`);
            extensionByIndex.set(index, extension.toLowerCase());
        }
    }
    return { name, version, raw, uuidLookup, redirects, nativeVersions, extensionByIndex };
}

async function loadManifests(settings, retries) {
    const manifests = new Map();
    for (const bundle of settings.remoteBundles) {
        const url = new URL(`remote/${bundle.name}/config.${bundle.version}.json`, settings.server).href;
        console.log(`[清单] ${bundle.name}@${bundle.version}`);
        const raw = await downloadJson(url, retries);
        manifests.set(bundle.name, prepareManifest(bundle.name, bundle.version, raw));
    }
    return manifests;
}

function buildPathIndex(manifests) {
    const global = new Map();
    const byBundle = new Map();
    for (const manifest of manifests.values()) {
        const one = new Map();
        for (const [indexText, entry] of Object.entries(manifest.raw.paths)) {
            const index = Number(indexText);
            if (!Number.isInteger(index) || index < 0 || index >= manifest.raw.uuids.length
                || !Array.isArray(entry) || typeof entry[0] !== 'string') {
                throw new Error(`${manifest.name}.paths[${indexText}] 结构无效`);
            }
            const typeIndex = Number(entry[1]);
            const type = manifest.raw.types[typeIndex];
            if (typeof type !== 'string') throw new Error(`${manifest.name}.paths[${index}] 类型索引无效`);
            const candidate = { bundle: manifest.name, bundleVersion: manifest.version, index, path: entry[0], type };
            const local = one.get(entry[0]) || [];
            local.push(candidate);
            one.set(entry[0], local);
            const all = global.get(entry[0]) || [];
            all.push(candidate);
            global.set(entry[0], all);
        }
        byBundle.set(manifest.name, one);
    }
    return { global, byBundle };
}

function requireUniqueCandidate(candidates, manifestPath, expectedType) {
    if (!candidates || candidates.length === 0) throw Object.assign(new Error(`资源路径不存在: ${manifestPath}`), { code: 'PATH_NOT_FOUND' });
    if (candidates.length !== 1) throw Object.assign(new Error(`资源路径不唯一 (${candidates.length}): ${manifestPath}`), { code: 'PATH_AMBIGUOUS' });
    const candidate = candidates[0];
    if (candidate.type !== expectedType) {
        throw Object.assign(new Error(`资源类型错误: ${manifestPath}, 期望 ${expectedType}, 实际 ${candidate.type}`), { code: 'TYPE_MISMATCH' });
    }
    return candidate;
}

function resolveImageCandidate(manifestPath, mode, pathIndex, manifests) {
    if (mode === 'icon') {
        if (!manifestPath.endsWith('/spriteFrame')) {
            throw Object.assign(new Error(`icon_res 必须以 /spriteFrame 结尾: ${manifestPath}`), { code: 'INVALID_ICON_PATH' });
        }
        const sprite = requireUniqueCandidate(pathIndex.global.get(manifestPath), manifestPath, 'cc.SpriteFrame');
        const rootPath = manifestPath.slice(0, -'/spriteFrame'.length);
        const localCandidates = pathIndex.byBundle.get(sprite.bundle)?.get(rootPath);
        const root = requireUniqueCandidate(localCandidates, `${sprite.bundle}:${rootPath}`, 'cc.ImageAsset');
        const manifest = manifests.get(sprite.bundle);
        if (normalizeBaseUuid(manifest.raw.uuids[sprite.index]) !== normalizeBaseUuid(manifest.raw.uuids[root.index])) {
            throw Object.assign(new Error(`SpriteFrame 与 ImageAsset UUID 不同组: ${manifestPath}`), { code: 'SPRITEFRAME_GROUP_MISMATCH' });
        }
        return { candidate: root, spriteFrame: sprite, manifestPath: rootPath };
    }
    const candidate = requireUniqueCandidate(pathIndex.global.get(manifestPath), manifestPath, 'cc.ImageAsset');
    return { candidate, spriteFrame: null, manifestPath };
}

function resolveNative(candidate, manifests, settings) {
    let manifest = manifests.get(candidate.bundle);
    let index = candidate.index;
    const hops = [];
    const visited = new Set();
    for (let depth = 0; depth <= MAX_REDIRECT_HOPS; depth += 1) {
        const key = `${manifest.name}:${index}`;
        if (visited.has(key)) throw Object.assign(new Error(`redirect 循环: ${key}`), { code: 'REDIRECT_CYCLE' });
        visited.add(key);
        const depOrdinal = manifest.redirects.get(index);
        if (depOrdinal === undefined) break;
        const targetBundle = manifest.raw.deps[depOrdinal];
        const target = manifests.get(targetBundle);
        if (!target) throw Object.assign(new Error(`redirect 指向未加载 bundle: ${targetBundle}`), { code: 'REDIRECT_TARGET_NOT_REMOTE' });
        const sourceUuid = normalizeCocosUuid(manifest.raw.uuids[index]);
        const matches = target.uuidLookup.get(sourceUuid) || [];
        const uuid = normalizeBaseUuid(sourceUuid);
        if (matches.length !== 1) {
            throw Object.assign(new Error(`redirect UUID 在 ${targetBundle} 中匹配 ${matches.length} 项: ${uuid}`), { code: matches.length ? 'REDIRECT_UUID_AMBIGUOUS' : 'REDIRECT_UUID_NOT_FOUND' });
        }
        hops.push({ fromBundle: manifest.name, fromIndex: index, dependencyOrdinal: depOrdinal, toBundle: targetBundle, toIndex: matches[0], uuid });
        manifest = target;
        index = matches[0];
        if (depth === MAX_REDIRECT_HOPS) throw Object.assign(new Error('redirect 深度超过限制'), { code: 'REDIRECT_TOO_DEEP' });
    }
    const uuid = normalizeBaseUuid(manifest.raw.uuids[index]);
    const hash = manifest.nativeVersions.get(index);
    if (typeof hash !== 'string' || !/^[A-Za-z0-9_-]+$/.test(hash)) {
        throw Object.assign(new Error(`缺少 native hash: ${manifest.name}[${index}]`), { code: 'NATIVE_HASH_MISSING' });
    }
    const extension = manifest.extensionByIndex.get(index) || '.png';
    if (extension !== '.png') {
        throw Object.assign(new Error(`原生图片不是 PNG (${extension}): ${manifest.name}[${index}]`), { code: 'TRANSCODE_REQUIRED' });
    }
    const nativeBase = manifest.raw.nativeBase.replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9_-]+$/.test(nativeBase)) throw new Error(`无效 nativeBase: ${manifest.raw.nativeBase}`);
    const relative = `remote/${manifest.name}/${nativeBase}/${uuid.slice(0, 2)}/${uuid}.${hash}${extension}`;
    return {
        ownerBundle: manifest.name,
        ownerBundleVersion: manifest.version,
        ownerIndex: index,
        uuid,
        hash,
        extension,
        url: new URL(relative, settings.server).href,
        redirectHops: hops,
    };
}

function createMappingRecord(kind, outputId, sourceIndex, mapping, pathIndex, manifests, settings) {
    const record = { kind, outputId, sourceIndex, mapping, status: 'mapped' };
    try {
        const resolved = resolveImageCandidate(mapping.manifestPath, mapping.mode, pathIndex, manifests);
        const native = resolveNative(resolved.candidate, manifests, settings);
        Object.assign(record, {
            manifestPath: resolved.manifestPath,
            declaringBundle: resolved.candidate.bundle,
            declaringBundleVersion: resolved.candidate.bundleVersion,
            declaringIndex: resolved.candidate.index,
            declaringType: resolved.candidate.type,
            spriteFrame: resolved.spriteFrame,
            ...native,
        });
    } catch (error) {
        record.status = 'failed';
        record.error = { code: error.code || 'MAPPING_FAILED', message: error.message };
    }
    return record;
}

function mapAll(inputs, pathIndex, manifests, settings) {
    const records = [];
    inputs.itemInput.value.forEach((item, index) => {
        let mapping;
        if (typeof item.icon_res === 'string' && item.icon_res.trim()) {
            const iconPath = item.icon_res.endsWith('/spriteFrame') ? item.icon_res : `${item.icon_res}/spriteFrame`;
            mapping = { mode: 'icon', field: 'icon_res', value: item.icon_res, manifestPath: iconPath };
        } else if (typeof item.asset_name === 'string' && item.asset_name.trim()) {
            mapping = { mode: 'asset', field: 'asset_name', value: item.asset_name, manifestPath: `model/v4/${item.asset_name}_Seed` };
        } else {
            records.push({
                kind: 'ItemInfo', outputId: item.id, sourceIndex: index, status: 'failed',
                error: { code: 'UNMAPPABLE_NO_IMAGE_FIELD', message: 'icon_res 和 asset_name 均为空' },
            });
            return;
        }
        records.push(createMappingRecord('ItemInfo', item.id, index, mapping, pathIndex, manifests, settings));
    });

    inputs.plantInput.value.forEach((plant, index) => {
        const useSeed = plant.seed_id !== null && plant.seed_id !== undefined;
        const referenceId = useSeed ? plant.seed_id : plant?.fruit?.id;
        let referenced;
        try {
            validatePositiveId(referenceId, `Plant[${index}].${useSeed ? 'seed_id' : 'fruit.id'}`);
            referenced = inputs.itemById.get(referenceId);
            if (!referenced) throw new Error(`引用的 ItemInfo 不存在: ${referenceId}`);
            const assetName = referenced.item.asset_name;
            if (typeof assetName !== 'string' || !assetName.trim()) throw new Error(`ItemInfo ${referenceId} 缺少 asset_name`);
            const mapping = {
                mode: 'asset',
                field: useSeed ? 'seed_id' : 'fruit.id',
                value: referenceId,
                referencedItemId: referenceId,
                referencedItemIndex: referenced.index,
                referencedField: 'asset_name',
                assetName,
                manifestPath: `model/v4/${assetName}_Seed`,
            };
            records.push(createMappingRecord('Plant', plant.id, index, mapping, pathIndex, manifests, settings));
        } catch (error) {
            records.push({
                kind: 'Plant', outputId: plant.id, sourceIndex: index, status: 'failed',
                error: { code: 'MISSING_ITEM_REFERENCE', message: error.message },
            });
        }
    });
    return records;
}

let crcTable = null;
function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
    }
    return crcTable;
}

function crc32(buffers) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (const buffer of buffers) {
        for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG 签名无效');
    let offset = 8;
    let ihdr = null;
    let idatCount = 0;
    let iendCount = 0;
    const idat = [];
    while (offset < buffer.length) {
        if (offset + 12 > buffer.length) throw new Error('PNG chunk 头被截断');
        const length = buffer.readUInt32BE(offset);
        const typeBuffer = buffer.subarray(offset + 4, offset + 8);
        const type = typeBuffer.toString('ascii');
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length) throw new Error(`PNG ${type} chunk 越界`);
        const data = buffer.subarray(dataStart, dataEnd);
        const expectedCrc = buffer.readUInt32BE(dataEnd);
        if (crc32([typeBuffer, data]) !== expectedCrc) throw new Error(`PNG ${type} CRC 错误`);
        if (!ihdr && type !== 'IHDR') throw new Error('PNG 第一个 chunk 不是 IHDR');
        if (type === 'IHDR') {
            if (ihdr || length !== 13) throw new Error('PNG IHDR 重复或长度无效');
            const width = data.readUInt32BE(0);
            const height = data.readUInt32BE(4);
            if (width === 0 || height === 0 || width > 16384 || height > 16384 || width * height > 64_000_000) throw new Error(`PNG 尺寸无效: ${width}x${height}`);
            const bitDepth = data[8];
            const colorType = data[9];
            const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
            if (!validDepths[colorType]?.includes(bitDepth) || data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(data[12])) throw new Error('PNG IHDR 参数无效');
            ihdr = { width, height, bitDepth, colorType, interlace: data[12] };
        } else if (type === 'IDAT') {
            idatCount += 1;
            idat.push(data);
        } else if (type === 'IEND') {
            if (length !== 0) throw new Error('PNG IEND 长度无效');
            iendCount += 1;
            offset = dataEnd + 4;
            // 个别官方资源在合法 IEND 后附带平台数据；PNG 解码器会按规范忽略尾部内容。
            break;
        }
        offset = dataEnd + 4;
    }
    if (!ihdr || idatCount === 0 || iendCount !== 1) throw new Error('PNG 缺少 IHDR、IDAT 或唯一 IEND');
    try { zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: 256 * 1024 * 1024 }); } catch (error) {
        throw new Error(`PNG IDAT 解压失败: ${error.message}`);
    }
    return ihdr;
}

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function installImage(outputDir, id, buffer) {
    const finalPath = path.join(outputDir, `${id}.png`);
    const newHash = sha256(buffer);
    let status = 'downloaded';
    let oldBuffer = null;
    if (fs.existsSync(finalPath)) {
        oldBuffer = fs.readFileSync(finalPath);
        try { validatePng(oldBuffer); } catch { status = 'replaced-invalid'; }
        if (sha256(oldBuffer) === newHash) return { status: 'skipped-identical', outputPath: finalPath, sha256: newHash };
        if (status !== 'replaced-invalid') status = 'updated';
    }

    const token = `${process.pid}-${Date.now()}-${id}`;
    const tempPath = path.join(outputDir, `.${id}.${token}.tmp`);
    const backupPath = path.join(outputDir, `.${id}.${token}.bak`);
    let backedUp = false;
    try {
        fs.writeFileSync(tempPath, buffer, { flag: 'wx' });
        const checked = fs.readFileSync(tempPath);
        validatePng(checked);
        if (sha256(checked) !== newHash) throw new Error('临时图片 SHA-256 回读不一致');
        if (fs.existsSync(finalPath)) {
            fs.renameSync(finalPath, backupPath);
            backedUp = true;
        }
        fs.renameSync(tempPath, finalPath);
        if (backedUp) {
            try { fs.unlinkSync(backupPath); } catch {}
        }
        return { status, outputPath: finalPath, sha256: newHash };
    } catch (error) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
        try {
            if (backedUp && fs.existsSync(backupPath)) {
                if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                fs.renameSync(backupPath, finalPath);
            }
        } catch (rollbackError) {
            error.message += `；回滚失败，备份保留在 ${backupPath}: ${rollbackError.message}`;
        }
        throw error;
    }
}

async function runPool(items, concurrency, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            await worker(items[index], index);
        }
    });
    await Promise.all(runners);
}

async function downloadImages(records, options) {
    fs.mkdirSync(options.output, { recursive: true });
    const mapped = records.filter(record => record.status === 'mapped');
    const byUrl = new Map();
    for (const record of mapped) {
        const list = byUrl.get(record.url) || [];
        list.push(record);
        byUrl.set(record.url, list);
    }
    const groups = [...byUrl.entries()].map(([url, linked]) => ({ url, linked }));
    let completedGroups = 0;
    await runPool(groups, options.concurrency, async group => {
        try {
            const response = await downloadWithRetry(group.url, MAX_IMAGE_BYTES, options.retries);
            const png = validatePng(response.buffer);
            const contentHash = sha256(response.buffer);
            for (const record of group.linked) {
                try {
                    const installed = installImage(options.output, record.outputId, response.buffer);
                    Object.assign(record, installed, {
                        contentType: response.contentType,
                        width: png.width,
                        height: png.height,
                        downloadedSha256: contentHash,
                    });
                } catch (error) {
                    record.status = 'failed';
                    record.error = { code: 'IMAGE_INSTALL_FAILED', message: error.message };
                }
            }
        } catch (error) {
            for (const record of group.linked) {
                record.status = 'failed';
                record.error = {
                    code: error.status ? `HTTP_${error.status}` : (error.message.startsWith('PNG ') ? 'PNG_INVALID' : 'DOWNLOAD_FAILED'),
                    message: error.message,
                };
            }
        } finally {
            completedGroups += 1;
            if (completedGroups % 50 === 0 || completedGroups === groups.length) console.log(`[进度] 图片 URL ${completedGroups}/${groups.length}`);
        }
    });
}

function createReport(inputs, settings, options, records, startedAt) {
    const successfulStatuses = new Set(['downloaded', 'updated', 'replaced-invalid', 'skipped-identical']);
    const summary = {
        expected: records.length,
        downloaded: records.filter(x => x.status === 'downloaded').length,
        updated: records.filter(x => x.status === 'updated').length,
        replacedInvalid: records.filter(x => x.status === 'replaced-invalid').length,
        skippedIdentical: records.filter(x => x.status === 'skipped-identical').length,
        failed: records.filter(x => x.status === 'failed').length,
    };
    summary.succeeded = records.filter(x => successfulStatuses.has(x.status)).length;
    return {
        complete: summary.failed === 0 && summary.succeeded === summary.expected,
        startedAt,
        finishedAt: new Date().toISOString(),
        input: {
            itemInfo: inputs.itemInput.filePath,
            itemInfoSha256: inputs.itemInput.sha256,
            itemCount: inputs.itemInput.value.length,
            plant: inputs.plantInput.filePath,
            plantSha256: inputs.plantInput.sha256,
            plantCount: inputs.plantInput.value.length,
        },
        output: options.output,
        settings: {
            file: settings.filePath,
            server: settings.server,
            remoteBundles: Object.fromEntries(settings.remoteBundles.map(x => [x.name, x.version])),
        },
        summary,
        records,
    };
}

function writeReportAtomically(outputDir, report) {
    const finalPath = path.join(outputDir, 'download-images-report.json');
    const token = `${process.pid}-${Date.now()}`;
    const tempPath = path.join(outputDir, `.download-images-report.${token}.tmp`);
    const backupPath = path.join(outputDir, `.download-images-report.${token}.bak`);
    let backedUp = false;
    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        JSON.parse(fs.readFileSync(tempPath, 'utf8'));
        if (fs.existsSync(finalPath)) {
            fs.renameSync(finalPath, backupPath);
            backedUp = true;
        }
        fs.renameSync(tempPath, finalPath);
        if (backedUp) {
            try { fs.unlinkSync(backupPath); } catch {}
        }
        return finalPath;
    } catch (error) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
        try {
            if (backedUp && fs.existsSync(backupPath)) {
                if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                fs.renameSync(backupPath, finalPath);
            }
        } catch (rollbackError) {
            error.message += `；报告回滚失败，备份保留在 ${backupPath}: ${rollbackError.message}`;
        }
        throw error;
    }
}

async function main() {
    const startedAt = new Date().toISOString();
    const options = parseArgs(process.argv.slice(2));
    const inputs = loadInputs(options.input);
    const settings = readSettings(options.source);
    console.log(`[输入] ItemInfo=${inputs.itemInput.value.length}, Plant=${inputs.plantInput.value.length}, 总 ID=${inputs.itemInput.value.length + inputs.plantInput.value.length}`);
    console.log(`[配置] settings: ${settings.filePath}`);
    console.log(`[配置] CDN: ${settings.server}`);
    const manifests = await loadManifests(settings, options.retries);
    const pathIndex = buildPathIndex(manifests);
    const records = mapAll(inputs, pathIndex, manifests, settings);
    const mappingFailures = records.filter(x => x.status === 'failed').length;
    console.log(`[映射] 准确=${records.length - mappingFailures}, 失败=${mappingFailures}`);
    await downloadImages(records, options);
    const report = createReport(inputs, settings, options, records, startedAt);
    const reportPath = writeReportAtomically(options.output, report);
    console.log(`[报告] ${reportPath}`);
    if (report.complete) {
        console.log(`[完成] 已准确下载/验证 ${report.summary.succeeded}/${report.summary.expected} 张图片`);
    } else {
        console.error(`[部分完成] 已准确下载/验证 ${report.summary.succeeded}/${report.summary.expected}，失败 ${report.summary.failed}`);
        const grouped = new Map();
        for (const record of records.filter(x => x.status === 'failed')) {
            const code = record.error?.code || 'UNKNOWN';
            const list = grouped.get(code) || [];
            list.push(record.outputId);
            grouped.set(code, list);
        }
        for (const [code, ids] of grouped) console.error(`[失败清单] ${code} (${ids.length}): ${ids.join(', ')}`);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`[失败] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_SOURCE,
    DEFAULT_CONCURRENCY,
    DEFAULT_RETRIES,
    parseIntegerOption,
    readJsonArray,
    readSettings,
    loadManifests,
    buildPathIndex,
    createMappingRecord,
    downloadImages,
    writeReportAtomically,
};
