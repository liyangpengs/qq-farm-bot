import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const crypto = require('node:crypto');
const store = require('../../models/store');
const userStore = require('../../models/user-store');
const { normalizeAccountRef, resolveAccountId } = require('../../services/account-resolver');

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    currentUser?: any;
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
        if (!token || !ctx.tokens.has(token)) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        req.adminToken = token;
        req.currentUser = ctx.tokens.get(token) || null;
        next();
    };
}

function isAdminRole(role: unknown): boolean {
    return role === 'admin' || role === 'super_admin';
}

function createRequireAdminRole() {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        if (!req.currentUser || !isAdminRole(req.currentUser.role)) {
            res.status(403).json({ ok: false, error: '需要管理员权限' });
            return;
        }
        next();
    };
}

// 当前系统仅存在单一管理员角色，超级管理员校验与管理员一致。
function createRequireSuperAdminRole() {
    return createRequireAdminRole();
}

function requireDangerConfirmation(req: Request, res: Response, requiredConfirmation: string): boolean {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const confirmed = body.confirmed === true || body.confirmed === 'true' || body.confirmed === 1 || body.confirmed === '1';
    if (!confirmed) {
        res.status(400).json({ ok: false, error: '危险操作未确认', requiredConfirmation });
        return false;
    }
    return true;
}

function getAdminUserMutationError(currentUser: any, targetUsername: string): string | null {
    const normalizedTarget = String(targetUsername || '').trim();
    if (!currentUser || !normalizedTarget) return null;
    if (isAdminRole(currentUser.role)) return null;
    if (String(currentUser.username || '').trim() === normalizedTarget) return null;
    try {
        const users = userStore.getAllUsers();
        const targetUser = Array.isArray(users)
            ? users.find((user: any) => String(user.username || '').trim() === normalizedTarget)
            : null;
        if (targetUser && isAdminRole(targetUser.role)) return '普通用户不能修改或删除管理员账号';
    } catch {
        // ignore lookup errors
    }
    return null;
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

function getAccountsForUser(ctx: AdminContext, username: string | null = null): any[] {
    const accounts = getAccountList(ctx);
    if (!username) return accounts;
    return accounts.filter((account: any) => String(account.username || '') === String(username));
}

function getAccessibleAccounts(ctx: AdminContext, req: AuthenticatedRequest): any[] {
    const currentUser = req.currentUser;
    if (!currentUser) return [];
    if (isAdminRole(currentUser.role)) return getAccountList(ctx);
    return getAccountsForUser(ctx, currentUser.username);
}

function canAccessAccount(ctx: AdminContext, req: AuthenticatedRequest, accountId: string): boolean {
    const currentUser = req.currentUser;
    if (!currentUser) return false;
    if (isAdminRole(currentUser.role)) return true;
    return getAccountsForUser(ctx, currentUser.username)
        .some((account: any) => String(account.id) === String(accountId));
}

const isSoftRuntimeError = (err: any): boolean => {
    const message = String(typeof err === 'string' ? err : err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};

function isGatewayProtocolError(err: any): boolean {
    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    return String(err?.name || '') === 'GatewayError'
        || typeof err?.errorMessage === 'string'
        || typeof err?.error_message === 'string'
        || /^(?:[\w-]+\.)+[\w-]+(?:\s+.*?)?\bcode=\d+(?:\s|$)/.test(message);
}

function getProtocolErrorMessage(err: any): string {
    const direct = String(err?.errorMessage || err?.error_message || '').trim();
    if (direct) return direct;

    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    if (!isGatewayProtocolError(err)) return '';
    return message.match(/\bcode=\d+\b\s*(.*)$/)?.[1]?.trim() || '';
}

function handleApiError(res: Response, err: any): void {
    const protocolMessage = getProtocolErrorMessage(err);
    const payload: any = {
        ok: false,
        error: protocolMessage || (typeof err === 'string' ? err : err?.message) || 'Unknown error',
    };
    if (protocolMessage) payload.errorMessage = protocolMessage;
    const errorCode = Number(err?.code);
    if (Number.isFinite(errorCode) && errorCode !== 0) payload.errorCode = errorCode;
    if (isSoftRuntimeError(err) || isGatewayProtocolError(err)) {
        res.json(payload);
        return;
    }
    res.status(500).json(payload);
}

function sendProviderError(res: Response, err: any): void {
    if (res.headersSent) return;
    if (isSoftRuntimeError(err) || isGatewayProtocolError(err)) {
        res.json({ ok: false, error: (typeof err === 'string' ? err : err?.message) || 'Unknown error' });
        return;
    }
    res.status(500).json({ ok: false, error: (typeof err === 'string' ? err : err?.message) || 'Unknown error' });
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
    createAuthRequired,
    isAdminRole,
    createRequireAdminRole,
    createRequireSuperAdminRole,
    requireDangerConfirmation,
    getAdminUserMutationError,
    getAccountList,
    getAccountIds,
    getAccountsForUser,
    getAccessibleAccounts,
    canAccessAccount,
    isSoftRuntimeError,
    isGatewayProtocolError,
    getProtocolErrorMessage,
    handleApiError,
    sendProviderError,
    resolveAccId,
    getAccId,
    buildKnownFriendGidSettings,
};
