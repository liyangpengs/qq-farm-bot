export {};

const crypto = require('node:crypto');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');

interface ApiTokenStoreOptions {
    filePath?: string;
    generateToken?: () => string;
    now?: () => number;
}

interface ApiTokenRecord {
    token: string;
    createdAt: number;
    rotatedAt?: number;
}

const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

class ApiTokenStore {
    private readonly filePath: string;
    private readonly generateToken: () => string;
    private readonly now: () => number;
    private record: ApiTokenRecord | null = null;

    constructor(options: ApiTokenStoreOptions = {}) {
        this.filePath = options.filePath || getDataFile('api-token.json');
        this.generateToken = options.generateToken || (() => crypto.randomBytes(32).toString('hex'));
        this.now = options.now || Date.now;
    }

    getToken(): string {
        return this.load().token;
    }

    rotateToken(): string {
        const current = this.load();
        const next: ApiTokenRecord = {
            token: this.createToken(),
            createdAt: current.createdAt,
            rotatedAt: this.now(),
        };
        this.record = next;
        this.save(next);
        return next.token;
    }

    verifyToken(value: unknown): boolean {
        const incoming = String(value || '').trim();
        const expected = this.getToken();
        if (incoming.length !== expected.length) return false;
        return crypto.timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
    }

    private load(): ApiTokenRecord {
        if (this.record) return this.record;
        const raw = readJsonFile(this.filePath, () => null);
        const token = String(raw?.token || '').trim();
        if (TOKEN_PATTERN.test(token)) {
            this.record = {
                token,
                createdAt: Number(raw?.createdAt) || this.now(),
                rotatedAt: Number(raw?.rotatedAt) || undefined,
            };
            return this.record;
        }
        this.record = {
            token: this.createToken(),
            createdAt: this.now(),
        };
        this.save(this.record);
        return this.record;
    }

    private createToken(): string {
        const token = String(this.generateToken() || '').trim();
        if (!TOKEN_PATTERN.test(token)) throw new Error('API Token 生成器返回了无效值');
        return token;
    }

    private save(record: ApiTokenRecord): void {
        writeJsonFileAtomic(this.filePath, record);
    }
}

const apiTokenStore = new ApiTokenStore();

module.exports = {
    ApiTokenStore,
    getApiToken: () => apiTokenStore.getToken(),
    rotateApiToken: () => apiTokenStore.rotateToken(),
    verifyApiToken: (value: unknown) => apiTokenStore.verifyToken(value),
};
