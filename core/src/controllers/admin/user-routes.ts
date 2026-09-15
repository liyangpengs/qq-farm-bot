import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { createModuleLogger } = require('../../services/logger');
const userStore = require('../../models/user-store');

const {
    createAuthRequired,
    createRequireAdminRole,
    createRequireSuperAdminRole,
    requireDangerConfirmation,
    getAdminUserMutationError,
} = require('./middleware');

const adminLogger = createModuleLogger('admin');

function invalidateSessions(ctx: AdminContext, predicate: (session: any) => boolean): void {
    for (const [token, session] of ctx.tokens.entries()) {
        if (predicate(session)) {
            ctx.tokens.delete(token);
            if (ctx.io) {
                for (const socket of ctx.io.sockets.sockets.values()) {
                    if (String((socket.data as any).adminToken || '') === String(token)) socket.disconnect(true);
                }
            }
        }
    }
}

function updateSessions(ctx: AdminContext, predicate: (session: any) => boolean, update: (session: any) => void): void {
    for (const session of ctx.tokens.values()) {
        if (predicate(session)) update(session);
    }
}

function mountUserRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);
    const requireAdminRole = createRequireAdminRole();
    const requireSuperAdminRole = createRequireSuperAdminRole();

    app.get('/api/admin/users', authRequired, requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: userStore.getAllUsers() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/admin/users-with-password', authRequired, requireSuperAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: userStore.getAllUsersWithPassword() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/users/clear-expired', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'CLEAR_EXPIRED_USERS')) return;
            const result = userStore.clearExpiredUsers();
            if (result.ok && result.deletedCount > 0) {
                for (const username of result.deletedUsers) {
                    invalidateSessions(ctx, (session: any) => session.username === username);
                }
                adminLogger.info('清理到期用户', { admin: (req as any).currentUser.username, deletedCount: result.deletedCount });
            }
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/users/:username', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_USER_STATUS')) return;
            const { username } = req.params;
            const mutationError = getAdminUserMutationError((req as any).currentUser, username);
            if (mutationError) return res.status(403).json({ ok: false, error: mutationError });
            const user = userStore.updateUser(username, req.body || {});
            if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
            res.json({ ok: true, data: user });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/users/:username/edit', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'EDIT_USER')) return;
            const { username } = req.params;
            const mutationError = getAdminUserMutationError((req as any).currentUser, username);
            if (mutationError) return res.status(403).json({ ok: false, error: mutationError });

            const { newUsername, password, accountLimit, expiresAt, isPermanent, qq } = req.body || {};
            const result = userStore.editUser(username, { newUsername, password, accountLimit, expiresAt, isPermanent, qq });
            if (!result.ok) return res.status(400).json(result);

            adminLogger.warn('编辑用户资料', {
                admin: (req as any).currentUser?.username || '',
                username,
                newUsername: result.user?.username || username,
            });
            updateSessions(
                ctx,
                (session: any) => session.username === username || session.username === newUsername,
                (session: any) => {
                    session.username = result.user.username;
                    session.card = result.user.card;
                    session.accountLimit = result.user.accountLimit;
                    session.qq = result.user.qq || '';
                },
            );
            res.json({ ok: true, data: result.user });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.delete('/api/admin/users/:username', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'DELETE_USER')) return;
            const { username } = req.params;
            const currentUser = (req as any).currentUser;
            if (currentUser && currentUser.username === username) {
                return res.status(400).json({ ok: false, error: '不能删除自己的账号' });
            }
            const mutationError = getAdminUserMutationError(currentUser, username);
            if (mutationError) return res.status(403).json({ ok: false, error: mutationError });

            const result = userStore.deleteUser(username, true);
            if (!result.ok) return res.status(400).json(result);
            invalidateSessions(ctx, (session: any) => session.username === username);
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/users/:username/renew', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'RENEW_USER')) return;
            const { username } = req.params;
            const { cardCode } = req.body || {};
            if (!cardCode) return res.status(400).json({ ok: false, error: '请提供卡密' });
            const result = userStore.renewUser(username, String(cardCode));
            if (!result.ok) return res.status(400).json(result);
            updateSessions(
                ctx,
                (session: any) => session.username === username,
                (session: any) => {
                    session.card = result.card;
                    session.accountLimit = result.accountLimit;
                },
            );
            res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    // 登录日志
    app.get('/api/admin/login-logs', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            const limit = Number.parseInt(String((req.query as any).limit || '100'), 10) || 100;
            const offset = Number.parseInt(String((req.query as any).offset || '0'), 10) || 0;
            res.json({ ok: true, data: userStore.getLoginLogs(limit, offset) });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.delete('/api/admin/login-logs', authRequired, requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json(userStore.clearLoginLogs());
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountUserRoutes };
