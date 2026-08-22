import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const crypto = require('node:crypto');
const store = require('../../models/store');
const { normalizeAccountRef, resolveAccountId, findAccountByRef } = require('../../services/account-resolver');

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    adminUser?: string;
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

function createAuthRequired(ctx: AdminContext) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        const token = String(req.headers['x-admin-token'] || '');
        const username = ctx.tokens.get(token);
        if (!token || !username) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        req.adminToken = token;
        req.adminUser = username;
        next();
    };
}

function getAccountList(ctx: AdminContext, owner?: string): any[] {
    const ownerKey = owner ? String(owner) : '';
    if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
        try {
            const data = ctx.provider.getAccounts(ownerKey);
            if (Array.isArray(data?.accounts)) return data.accounts;
        } catch {
            // Fall back to persistent storage.
        }
    }
    const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
    let list = Array.isArray(data.accounts) ? data.accounts : [];
    if (ownerKey) list = list.filter((account: any) => String(account.owner || '') === ownerKey);
    return list;
}

function getAccountIds(ctx: AdminContext, owner?: string): string[] {
    return getAccountList(ctx, owner).map((account: any) => String(account.id || '')).filter(Boolean);
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

/**
 * 校验账号归属：解析 rawRef 指向的账号，若存在但不属于当前登录管理员则返回 denied。
 * 不存在的引用返回 id（交给上游处理）。
 */
function requireAccountOwner(ctx: AdminContext, req: Request, rawRef: any): { denied?: boolean; id?: string; account?: any } {
    const input = normalizeAccountRef(rawRef);
    if (!input) return {};
    const username = String((req as any).adminUser || '');
    const account = findAccountByRef(getAccountList(ctx), input);
    if (!account) {
        return { id: resolveAccId(ctx, input) || input };
    }
    if (String(account.owner || '') !== username) {
        return { denied: true };
    }
    return { id: String(account.id || ''), account };
}

function getAccId(ctx: AdminContext, req: Request): string {
    const input = normalizeAccountRef(req.headers['x-account-id']);
    if (!input) return '';
    const accountId = resolveAccId(ctx, input);
    if (!accountId) return '';
    // 归属校验：解析出的账号必须属于当前登录管理员
    const account = findAccountByRef(getAccountList(ctx), accountId);
    const username = String((req as any).adminUser || '');
    if (account && String(account.owner || '') !== username) return '';
    return accountId;
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
    createAuthRequired,
    getAccountList,
    getAccountIds,
    isSoftRuntimeError,
    handleApiError,
    resolveAccId,
    requireAccountOwner,
    getAccId,
    buildKnownFriendGidSettings,
};
