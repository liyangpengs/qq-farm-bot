import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const crypto = require('node:crypto');
const store = require('../../models/store');
const { verifyApiToken } = require('../../models/api-token-store');
const { normalizeAccountRef, resolveAccountId } = require('../../services/account-resolver');

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    adminAuthType?: 'session' | 'api';
}

function getClientIp(req: Request): string {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return String(cfIp).trim();
    const realIp = req.headers['x-real-ip'];
    if (realIp) return String(realIp).trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const first = String(forwarded).split(',').map(item => item.trim()).find(Boolean);
        if (first) return first;
    }
    const address = req.ip || (req as any).connection?.remoteAddress || req.socket?.remoteAddress;
    return String(address || 'unknown').replace(/^::ffff:/, '');
}

const issueToken = (): string => crypto.randomBytes(24).toString('hex');

function isAdminTokenValid(ctx: AdminContext, value: unknown): boolean {
    const token = String(value || '').trim();
    return !!token && (ctx.tokens.has(token) || verifyApiToken(token));
}

function createAuthRequired(ctx: AdminContext) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        const token = String(req.headers['x-admin-token'] || '');
        if (!isAdminTokenValid(ctx, token)) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        req.adminToken = token;
        req.adminAuthType = ctx.tokens.has(token) ? 'session' : 'api';
        next();
    };
}

function getAccountList(ctx: AdminContext): any[] {
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts)) return data.accounts;
        }
    } catch {
        // Fall back to persistent storage.
    }
    const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
    return Array.isArray(data.accounts) ? data.accounts : [];
}

function getAccountIds(ctx: AdminContext): string[] {
    return getAccountList(ctx).map((account: any) => String(account.id || '')).filter(Boolean);
}

const isSoftRuntimeError = (err: any): boolean => {
    const message = String(err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};

function handleApiError(res: Response, err: any): void {
    if (isSoftRuntimeError(err)) {
        res.json({ ok: false, error: err.message });
        return;
    }
    res.status(500).json({ ok: false, error: err.message });
}

function resolveAccId(ctx: AdminContext, rawRef: any): string {
    const input = normalizeAccountRef(rawRef);
    if (!input) return '';
    if (ctx.provider && typeof ctx.provider.resolveAccountId === 'function') {
        const resolvedByProvider = normalizeAccountRef(ctx.provider.resolveAccountId(input));
        if (resolvedByProvider) return resolvedByProvider;
    }
    return resolveAccountId(getAccountList(ctx), input) || input;
}

function getAccId(ctx: AdminContext, req: Request): string {
    return resolveAccId(ctx, req.headers['x-account-id']);
}

function buildKnownFriendGidSettings(accountId: string): {
    knownFriendGids: any[];
    knownFriendGidSyncCooldownSec: number;
    friendsListCacheTtlSec: number;
} {
    return {
        knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
        knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
            ? store.getKnownFriendGidSyncCooldownSec(accountId)
            : 600,
        friendsListCacheTtlSec: store.getFriendsListCacheTtlSec
            ? store.getFriendsListCacheTtlSec(accountId)
            : 60,
    };
}

module.exports = {
    getClientIp,
    issueToken,
    isAdminTokenValid,
    createAuthRequired,
    getAccountList,
    getAccountIds,
    isSoftRuntimeError,
    handleApiError,
    resolveAccId,
    getAccId,
    buildKnownFriendGidSettings,
};
