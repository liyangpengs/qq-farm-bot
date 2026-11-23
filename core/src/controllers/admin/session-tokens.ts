export {};

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getRuntimePaths } = require('../../config/runtime-paths');
const adminStore = require('../../models/admin-store');
const { writeJsonFileAtomic } = require('../../services/json-db');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 32;

export interface PersistentTokenSetOptions {
    filePath?: string;
    getFingerprint?: () => string;
    now?: () => number;
    ttlMs?: number;
    maxSessions?: number;
}

export interface PersistentTokenSet {
    add: (token: string) => PersistentTokenSet;
    has: (token: string) => boolean;
    delete: (token: string) => boolean;
    clear: () => void;
    readonly size: number;
    snapshot: () => { has: (token: string) => boolean };
}

interface PersistedSessionEntry {
    hash: string;
    issuedAt: number;
}

function hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function defaultSessionFilePath(): string {
    return path.join(getRuntimePaths().runtimeDir, 'admin-sessions.json');
}

function createPersistentTokenSet(options: PersistentTokenSetOptions = {}): PersistentTokenSet {
    const filePath = path.resolve(options.filePath || defaultSessionFilePath());
    const getFingerprint = options.getFingerprint || (() => adminStore.getCredentialFingerprint());
    const now = options.now || Date.now;
    const ttlMs = Math.max(1000, Number(options.ttlMs) || DEFAULT_TTL_MS);
    const maxSessions = Math.max(1, Number(options.maxSessions) || DEFAULT_MAX_SESSIONS);

    let credentialFingerprint = '';
    const sessions = new Map<string, number>();

    const persist = (): void => {
        const list: PersistedSessionEntry[] = Array.from(sessions, ([hash, issuedAt]) => ({ hash, issuedAt }));
        writeJsonFileAtomic(filePath, { credentialFingerprint, sessions: list });
        if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    };

    const pruneExpired = (currentTime: number): boolean => {
        let changed = false;
        for (const [hash, issuedAt] of sessions.entries()) {
            if (!hash || !Number.isFinite(issuedAt) || currentTime - issuedAt >= ttlMs) {
                sessions.delete(hash);
                changed = true;
            }
        }
        return changed;
    };

    const ensureFingerprintCurrent = (): boolean => {
        const expected = getFingerprint();
        if (expected !== credentialFingerprint) {
            sessions.clear();
            credentialFingerprint = expected;
            persist();
            return false;
        }
        return true;
    };

    const loadInitial = (): void => {
        const currentTime = now();
        credentialFingerprint = getFingerprint();
        try {
            if (!fs.existsSync(filePath)) return;
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object') return;
            if (parsed.credentialFingerprint !== credentialFingerprint) {
                persist();
                return;
            }
            if (!Array.isArray(parsed.sessions)) return;
            for (const item of parsed.sessions) {
                const hash = typeof item?.hash === 'string' ? item.hash.trim() : '';
                const issuedAt = Number(item?.issuedAt);
                if (!/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(issuedAt)) continue;
                if (currentTime - issuedAt < ttlMs) {
                    sessions.set(hash, issuedAt);
                }
            }
            if (sessions.size > maxSessions) {
                const sorted = [...sessions.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxSessions);
                sessions.clear();
                for (const [hash, issuedAt] of sorted) sessions.set(hash, issuedAt);
                persist();
            } else if (sessions.size !== parsed.sessions.length) {
                persist();
            }
        } catch {
            sessions.clear();
        }
    };

    loadInitial();

    const api: PersistentTokenSet = {
        add(rawToken: string): PersistentTokenSet {
            const token = String(rawToken || '').trim();
            if (!token) return api;
            ensureFingerprintCurrent();
            const currentTime = now();
            pruneExpired(currentTime);
            const hash = hashToken(token);
            sessions.delete(hash);
            while (sessions.size >= maxSessions) {
                const oldestKey = sessions.keys().next().value;
                if (!oldestKey) break;
                sessions.delete(oldestKey);
            }
            sessions.set(hash, currentTime);
            persist();
            return api;
        },

        has(rawToken: string): boolean {
            const token = String(rawToken || '').trim();
            if (!token) return false;
            if (!ensureFingerprintCurrent()) return false;
            const currentTime = now();
            const hash = hashToken(token);
            const issuedAt = sessions.get(hash);
            if (issuedAt === undefined) return false;
            if (currentTime - issuedAt >= ttlMs) {
                sessions.delete(hash);
                pruneExpired(currentTime);
                persist();
                return false;
            }
            return true;
        },

        delete(rawToken: string): boolean {
            const token = String(rawToken || '').trim();
            if (!token) return false;
            const removed = sessions.delete(hashToken(token));
            if (removed) persist();
            return removed;
        },

        clear(): void {
            sessions.clear();
            credentialFingerprint = getFingerprint();
            persist();
        },

        get size(): number {
            ensureFingerprintCurrent();
            if (pruneExpired(now())) persist();
            return sessions.size;
        },

        snapshot(): { has: (rawToken: string) => boolean } {
            ensureFingerprintCurrent();
            pruneExpired(now());
            const frozen = new Set(sessions.keys());
            return {
                has(rawToken: string): boolean {
                    const token = String(rawToken || '').trim();
                    return Boolean(token) && frozen.has(hashToken(token));
                },
            };
        },
    };

    return api;
}

module.exports = { createPersistentTokenSet };
