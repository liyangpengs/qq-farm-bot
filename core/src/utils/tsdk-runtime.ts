export {};
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { CONFIG } = require('../config/config');
const { ensureDataDir, getResourcePath } = require('../config/runtime-paths');
const { log, logWarn } = require('./utils');

const TSDK_VERSION = 'v3.9.0.1788165223';
const TSDK_SHA256 = 'a95b178193c4ad7cf01fd44b6ec7086b1711069659e0bf9180860466a7b5f99f';
const MINI_PROGRAM_APP_IDS = Object.freeze({
    qq: '1112386029',
    wx: 'wx5306c5978fdb76e4',
});
const TSDK_GAME_ID = 3167;
const TSDK_APP_KEY = '0';
const QQ_USER_DATA_PATH = 'qqfile://usr/';
const QQ_DEVICE_TEXT = 'windows;windows;windows 10.0;0;';
const RUNTIME_TABLE = Buffer.from([
    93, 86, 110, 34, 65, 129, 8, 113, 53, 192, 121, 32, 86, 162, 255, 139,
    217, 70, 223, 0, 45, 176, 85, 103, 234, 116, 120, 194, 206, 7, 176, 222,
    56, 6, 161, 159, 154, 231, 93, 229, 39, 107, 197, 136, 167, 52, 155, 228,
    209, 117, 218, 8, 107, 241, 32, 62, 53, 200, 238,
]);
const MERGED_DATA_KEY = 1871261153;
const MERGED_DATA_METADATA = [67371008, 404] as const;
const QQ_HOST_FEATURE_STATE = Object.freeze({
    currentPtr: 17288,
    referencePtr: 17352,
    length: 64,
    nodeMismatchIndex: 1,
});

type TsdkPlatform = 'qq' | 'wx';

interface TsdkRuntimeOptions {
    accountId?: unknown;
    dataDir?: string;
    platform?: unknown;
}

interface TsdkHostProfile {
    appId: string;
    debugMode: number;
    deviceText?: string;
    platform: TsdkPlatform;
    userDataPath?: string;
}

function resolveTsdkPlatform(value: unknown): TsdkPlatform {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'wx' || normalized === 'wechat' ? 'wx' : 'qq';
}

function resolveTsdkHostProfile(value: unknown): TsdkHostProfile {
    const platform = resolveTsdkPlatform(value);
    if (platform === 'qq') {
        return {
            appId: MINI_PROGRAM_APP_IDS.qq,
            debugMode: 0,
            deviceText: QQ_DEVICE_TEXT,
            platform,
            userDataPath: QQ_USER_DATA_PATH,
        };
    }
    return {
        appId: MINI_PROGRAM_APP_IDS.wx,
        debugMode: 2,
        platform,
    };
}

interface TsdkExports {
    w: WebAssembly.Memory;
    x: () => void;
    y: (...args: any[]) => number;
    A: (length: number) => number;
    B: (ptr: number) => void;
    C: () => number;
    E: () => void;
    G: (gameId: number, appKeyPtr: number) => void;
    H: () => number;
    K: (ptr: number, count: number, type: number) => void;
    M: () => void;
    N: (lengthPtr: number) => number;
    O: (ptr: number, length: number) => void;
    P: () => void;
    aa: (ptr: number, length: number) => number;
    ba: (ptr: number, length: number) => void;
    ca: (ptr: number, length: number) => void;
    da: (inputPtr: number, inputLength: number, outputPtr: number, outputCapacity: number) => number;
    ea: (inputPtr: number, inputLength: number, outputPtr: number, outputCapacity: number) => number;
    fa: (elapsedMs: number) => void;
    __mergewasm_shared____wasm_decrypt_strings?: (ptr: number, length: number, key: number) => void;
    decrypt_all_data?: () => void;
}

class TsdkRuntime {
    private accountId: string;
    private dataDir: string;
    private hostProfile: TsdkHostProfile;
    private memory: WebAssembly.Memory | null = null;
    private exports: TsdkExports | null = null;
    private initPromise: Promise<void> | null = null;
    private ready = false;
    private destroyed = false;
    private userBound = false;
    private serverTimeGeneration = 0;
    private warned = new Set<string>();

    constructor(options: TsdkRuntimeOptions = {}) {
        this.accountId = String(options.accountId || process.env.FARM_ACCOUNT_ID || 'default');
        this.dataDir = options.dataDir
            ? path.resolve(options.dataDir)
            : path.join(ensureDataDir(), 'tsdk', this.accountId);
        this.hostProfile = resolveTsdkHostProfile(options.platform ?? CONFIG.platform);
    }

    private warnOnce(key: string, message: string): void {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        logWarn('ACE', message);
    }

    private view(): Uint8Array {
        if (!this.memory) throw new Error('TSDK 内存尚未初始化');
        return new Uint8Array(this.memory.buffer);
    }

    private ensureBounds(ptr: number, length: number): void {
        const size = this.memory ? this.memory.buffer.byteLength : 0;
        if (!Number.isInteger(ptr) || !Number.isInteger(length) || ptr < 0 || length < 0 || ptr + length > size) {
            throw new RangeError(`TSDK 内存越界: ptr=${ptr}, length=${length}, size=${size}`);
        }
    }

    private readCString(ptr: number, maxLength = 1024 * 1024): string {
        if (!ptr) return '';
        const view = this.view();
        this.ensureBounds(ptr, 1);
        const limit = Math.min(view.length, ptr + maxLength);
        let end = ptr;
        while (end < limit && view[end] !== 0) end++;
        if (end >= limit) throw new Error('TSDK 字符串未正常终止');
        return Buffer.from(view.subarray(ptr, end)).toString('utf8');
    }

    private writeCString(value: any, ptr: number, capacity: number): number {
        const data = Buffer.from(String(value ?? ''), 'utf8');
        if (!ptr || capacity <= data.length) return 0;
        this.ensureBounds(ptr, capacity);
        const view = this.view();
        view.set(data, ptr);
        view[ptr + data.length] = 0;
        return ptr;
    }

    private writeBytes(value: Uint8Array, ptr: number, capacity: number): number {
        const data = Buffer.from(value || []);
        if (!ptr || capacity < data.length) return 0;
        this.ensureBounds(ptr, capacity);
        this.view().set(data, ptr);
        return data.length;
    }

    private resolveDataPath(input: string): string {
        const relative = String(input || '')
            .replaceAll('\\', '/')
            .replace(/^(?:qq|wx)file:\/\/usr(?:\/|$)/i, '')
            .replace(/^\/+/, '');
        const root = path.resolve(this.dataDir);
        const target = path.resolve(root, relative);
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
            throw new Error('TSDK 文件路径越出账号目录');
        }
        return target;
    }

    private getDeviceText(): string {
        if (this.hostProfile.deviceText) return this.hostProfile.deviceText;
        const device = CONFIG.deviceInfo || {};
        const model = String(device.deviceId || `${os.type()} ${os.arch()}`);
        const platform = String(CONFIG.os || process.platform);
        const system = String(device.sysSoftware || os.release());
        return `${model};${platform};${system};Node.js;`;
    }

    private createImports(): WebAssembly.Imports {
        return {
            a: {
                a: (exprPtr: number, filePtr: number, line: number, funcPtr: number) => {
                    const expr = this.readCString(exprPtr);
                    const file = this.readCString(filePtr) || 'unknown';
                    const func = this.readCString(funcPtr);
                    throw new Error(`TSDK assertion: ${expr} at ${file}:${line} ${func}`);
                },
                b: (filePtr: number, dataPtr: number, encodingPtr: number) => {
                    try {
                        const target = this.resolveDataPath(this.readCString(filePtr));
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        fs.writeFileSync(target, this.readCString(dataPtr), this.readCString(encodingPtr) || 'utf8');
                        return 1;
                    } catch (e: any) {
                        this.warnOnce('write-file', `TSDK 文件写入失败: ${e.message}`);
                        return 0;
                    }
                },
                c: (ptr: number, capacity: number) => {
                    const stack = new Error('TSDK JavaScript 调用栈').stack || '';
                    return this.writeCString(stack, ptr, capacity) ? Buffer.byteLength(stack, 'utf8') + 1 : 0;
                },
                d: (ptr: number, capacity: number) => this.writeCString(TSDK_VERSION, ptr, capacity),
                e: () => {
                    this.warnOnce('acevm', 'Node.js 环境不提供小游戏 ACEVM 完整性上下文，使用空结果');
                    return 0;
                },
                f: () => this.warnOnce('sensors', 'Node.js 环境不提供触摸和陀螺仪数据'),
                g: (filePtr: number, outputPtr: number, capacity: number, encodingPtr: number) => {
                    try {
                        const data = fs.readFileSync(this.resolveDataPath(this.readCString(filePtr)), this.readCString(encodingPtr) || 'utf8');
                        return this.writeCString(data, outputPtr, capacity);
                    } catch {
                        return 0;
                    }
                },
                h: (clockId: number, _low: number, _high: number, outputPtr: number) => {
                    if (clockId < 0 || clockId > 3) return 28;
                    const value = Math.round((clockId === 0 ? Date.now() : performance.now()) * 1e6);
                    this.ensureBounds(outputPtr, 8);
                    const view = new Uint32Array(this.memory!.buffer);
                    view[outputPtr >> 2] = value >>> 0;
                    view[(outputPtr + 4) >> 2] = Math.floor(value / 0x100000000) >>> 0;
                    return 0;
                },
                i: (ptr: number, capacity: number) => this.writeCString(
                    this.hostProfile.userDataPath || `${this.dataDir}${path.sep}`,
                    ptr,
                    capacity,
                ),
                j: (ptr: number, capacity: number) => this.writeCString(this.getDeviceText(), ptr, capacity),
                k: (ptr: number, capacity: number) => this.writeBytes(RUNTIME_TABLE, ptr, capacity),
                l: () => this.hostProfile.debugMode,
                m: (ptr: number, capacity: number) => this.writeCString(this.hostProfile.appId, ptr, capacity),
                n: (ptr: number, capacity: number) => this.writeCString(this.hostProfile.appId, ptr, capacity),
                o: () => this.warnOnce('integrity-functions', 'Node.js 环境不提供小游戏函数完整性列表'),
                p: (filePtr: number) => {
                    try {
                        const stat = fs.statSync(this.resolveDataPath(this.readCString(filePtr)));
                        return this.exports?.y(stat.mode, Math.min(0x7FFFFFFF, stat.size), Math.floor(stat.atimeMs), Math.floor(stat.mtimeMs)) || 0;
                    } catch {
                        return 0;
                    }
                },
                q: (outputPtr: number) => {
                    const generation = ++this.serverTimeGeneration;
                    this.ensureBounds(outputPtr, 4);
                    new Int32Array(this.memory!.buffer)[outputPtr >> 2] = Math.floor(Date.now() / 1000);
                    https.get('https://api.anticheatexpert.com/test', { timeout: 3000 }, (response: any) => {
                        response.resume();
                        if (generation !== this.serverTimeGeneration || !this.memory) return;
                        const parsed = Date.parse(response.headers.date || '');
                        new Int32Array(this.memory.buffer)[outputPtr >> 2] = parsed ? Math.floor(parsed / 1000) : 0;
                    }).on('error', () => {});
                    return 1;
                },
                r: (size: number) => { throw new Error(`TSDK 内存扩展失败: ${size}`); },
                s: () => Date.now(),
                t: (filePtr: number, dataPtr: number, encodingPtr: number) => {
                    try {
                        const target = this.resolveDataPath(this.readCString(filePtr));
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        fs.appendFileSync(target, this.readCString(dataPtr), this.readCString(encodingPtr) || 'utf8');
                        return 1;
                    } catch {
                        return 0;
                    }
                },
                u: () => { throw new Error('TSDK aborted'); },
                v: (ptr: number, length: number) => {
                    try {
                        this.ensureBounds(ptr, length);
                        const report = JSON.parse(Buffer.from(this.view().subarray(ptr, ptr + length)).toString('utf8'));
                        const request = https.request('https://api.anticheatexpert.com/tqos', {
                            method: 'POST',
                            headers: report.headers || {},
                            timeout: 5000,
                        }, (response: any) => response.resume());
                        request.on('error', (e: any) => this.warnOnce('tqos', `TSDK TQOS 上报失败: ${e.message}`));
                        request.end(typeof report.message === 'string' ? report.message : JSON.stringify(report.message ?? {}));
                        return 0;
                    } catch (e: any) {
                        this.warnOnce('tqos', `TSDK TQOS 数据无效: ${e.message}`);
                        return 0;
                    }
                },
            },
        };
    }

    async init(): Promise<void> {
        if (this.ready) return;
        if (this.initPromise) return this.initPromise;
        if (this.destroyed) throw new Error('TSDK 运行时已销毁');

        this.initPromise = (async () => {
            const wasmPath = getResourcePath('utils', 'tsdk.wasm');
            const wasm = fs.readFileSync(wasmPath);
            const hash = crypto.createHash('sha256').update(wasm).digest('hex');
            if (hash !== TSDK_SHA256) throw new Error(`TSDK 文件校验失败: ${hash}`);
            fs.mkdirSync(this.dataDir, { recursive: true });

            const { instance } = await WebAssembly.instantiate(wasm, this.createImports());
            if (this.destroyed) throw new Error('TSDK 初始化已被取消');
            this.exports = instance.exports as unknown as TsdkExports;
            this.memory = this.exports.w;
            if (!(this.memory instanceof WebAssembly.Memory)) throw new Error('TSDK memory 导出不兼容');
            for (const name of ['x', 'y', 'A', 'B', 'E', 'G', 'H', 'M', 'N', 'O', 'P', 'aa', 'ba', 'ca', 'fa']) {
                if (typeof (this.exports as any)[name] !== 'function') throw new Error(`TSDK 缺少导出: ${name}`);
            }

            const decryptSegment = this.exports.__mergewasm_shared____wasm_decrypt_strings;
            if (typeof decryptSegment !== 'function') throw new Error('TSDK 缺少 mergewasm 数据解密导出');
            const decryptAllData = this.exports.decrypt_all_data;
            if (typeof decryptAllData !== 'function') throw new Error('TSDK 缺少 mergewasm 全量数据解密导出');
            const [metadataPtr, metadataLength] = MERGED_DATA_METADATA;
            this.ensureBounds(metadataPtr, metadataLength);
            decryptSegment(metadataPtr, metadataLength, MERGED_DATA_KEY);
            decryptAllData();
            this.exports.x();

            const appKey = this.allocCString(TSDK_APP_KEY);
            try {
                this.exports.G(TSDK_GAME_ID, appKey.ptr);
            } finally {
                this.free(appKey.ptr);
            }
            this.ready = true;
            log('ACE', `新版 TSDK 初始化成功: ${TSDK_VERSION} (${this.hostProfile.platform})`);
        })().catch((e: any) => {
            this.ready = false;
            this.exports = null;
            this.memory = null;
            this.initPromise = null;
            throw e;
        });
        return this.initPromise;
    }

    private assertReady(): void {
        if (!this.ready || !this.exports || !this.memory || this.destroyed) throw new Error('TSDK 尚未就绪');
    }

    private normalizeQqHostFeatureState(): void {
        if (this.hostProfile.platform !== 'qq') return;
        const {
            currentPtr,
            referencePtr,
            length,
            nodeMismatchIndex,
        } = QQ_HOST_FEATURE_STATE;
        this.ensureBounds(currentPtr, length);
        this.ensureBounds(referencePtr, length);
        const view = this.view();
        const mismatches: number[] = [];
        for (let index = 0; index < length; index += 1) {
            if (view[currentPtr + index] !== view[referencePtr + index]) mismatches.push(index);
        }
        if (mismatches.length === 0) return;
        const currentValue = view[currentPtr + nodeMismatchIndex];
        const referenceValue = view[referencePtr + nodeMismatchIndex];
        if (
            mismatches.length !== 1
            || mismatches[0] !== nodeMismatchIndex
            || currentValue !== referenceValue + 1
        ) {
            throw new Error('TSDK QQ 宿主特征布局与已验证版本不一致');
        }
        view[currentPtr + nodeMismatchIndex] = referenceValue;
    }

    private alloc(length: number): number {
        if (!this.exports) throw new Error('TSDK 尚未初始化');
        const size = Math.max(1, Math.floor(Number(length) || 0));
        const ptr = this.exports.A(size);
        if (!ptr) throw new Error(`TSDK 分配内存失败: ${size}`);
        this.ensureBounds(ptr, size);
        return ptr;
    }

    private allocBytes(value: Uint8Array): { ptr: number; length: number } {
        const data = Buffer.from(value || []);
        const ptr = this.alloc(data.length || 1);
        if (data.length) this.view().set(data, ptr);
        return { ptr, length: data.length };
    }

    private allocCString(value: string): { ptr: number; length: number } {
        const data = Buffer.from(String(value), 'utf8');
        const ptr = this.alloc(data.length + 1);
        this.view().set(data, ptr);
        this.view()[ptr + data.length] = 0;
        return { ptr, length: data.length };
    }

    private free(ptr: number): void {
        if (ptr && this.exports) this.exports.B(ptr);
    }

    transform(value: Uint8Array, decrypt = false): Buffer {
        this.assertReady();
        const input = this.allocBytes(value);
        try {
            (decrypt ? this.exports.ca : this.exports.ba)(input.ptr, input.length);
            this.ensureBounds(input.ptr, input.length);
            return Buffer.from(this.view().subarray(input.ptr, input.ptr + input.length));
        } finally {
            this.free(input.ptr);
        }
    }

    bindUser(openId: string): void {
        this.assertReady();
        const value = String(openId || '').trim();
        if (!value || this.userBound) return;
        const input = this.allocCString(value);
        try {
            this.exports.G(TSDK_GAME_ID, input.ptr);
            this.userBound = true;
        } finally {
            this.free(input.ptr);
        }
    }

    getEncryptedInitInfo(): string {
        this.assertReady();
        this.normalizeQqHostFeatureState();
        const ptr = this.exports.H();
        return ptr ? this.readCString(ptr, 64 * 1024) : '';
    }

    getDataToServer(): Buffer {
        this.assertReady();
        const lengthPtr = this.alloc(4);
        try {
            new Int32Array(this.memory.buffer)[lengthPtr >> 2] = 0;
            const dataPtr = this.exports.N(lengthPtr);
            const length = new Int32Array(this.memory.buffer)[lengthPtr >> 2];
            if (!dataPtr || length <= 0) return Buffer.alloc(0);
            this.ensureBounds(dataPtr, length);
            return Buffer.from(this.view().subarray(dataPtr, dataPtr + length));
        } finally {
            this.free(lengthPtr);
        }
    }

    sendDataFromServer(value: Uint8Array): void {
        this.assertReady();
        const input = this.allocBytes(value);
        try {
            this.exports.O(input.ptr, input.length);
        } finally {
            this.free(input.ptr);
        }
    }

    heartbeatTick(): void { this.assertReady(); this.exports.M(); }
    processReceivedData(): void { this.assertReady(); this.exports.P(); }
    sendStatus(): void { this.assertReady(); this.exports.E(); }
    detectSpeedHack(elapsedMs: number): void { this.assertReady(); this.exports.fa(Math.max(0, Math.floor(elapsedMs))); }

    destroy(): void {
        this.ready = false;
        this.destroyed = true;
        this.serverTimeGeneration++;
        this.exports = null;
        this.memory = null;
        this.initPromise = null;
    }
}

module.exports = {
    TsdkRuntime,
    TSDK_VERSION,
    TSDK_SHA256,
    MINI_PROGRAM_APP_IDS,
    TSDK_GAME_ID,
    resolveTsdkHostProfile,
    resolveTsdkPlatform,
};
