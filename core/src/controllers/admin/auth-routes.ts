import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { version } = require('../../../package.json');
const { getRuntimeConfig } = require('../../config/config');
const { getSchedulerRegistrySnapshot } = require('../../services/scheduler');
const { createModuleLogger } = require('../../services/logger');
const adminStore = require('../../models/admin-store');
const userStore = require('../../models/user-store');

const {
    getClientIp,
    issueToken,
    createAuthRequired,
    getAccId,
    handleApiError,
} = require('./middleware');

const adminLogger = createModuleLogger('admin');

function mountAuthRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);

    app.post('/api/login', (req: Request, res: Response) => {
        const { username, password } = req.body || {};
        const clientIp = getClientIp(req);
        const userAgent = String(req.headers['user-agent'] || '');

        if (!username || !password) {
            return res.status(401).json({ ok: false, error: '请输入用户名和密码' });
        }

        let result = userStore.validateUser(String(username), String(password), clientIp);

        // 兼容旧的独立管理员账号（admin.json）
        if (result && result.error === 'invalid_credentials') {
            const legacy = adminStore.validateAdmin(String(username), String(password), clientIp);
            if (legacy && !legacy.error) {
                result = { ...legacy, role: 'admin', accountLimit: Number.MAX_SAFE_INTEGER };
            }
        }

        if (result?.error) {
            const statusCode = result.error === 'rate_limit' ? 429 : result.error === 'locked' ? 423 : 401;
            adminLogger.warn('登录失败', { username, error: result.error, ip: clientIp });
            if (typeof userStore.addLoginLog === 'function') {
                userStore.addLoginLog('login_failed', String(username), result.error, clientIp, userAgent);
            }
            return res.status(statusCode).json({
                ok: false,
                error: result.message,
                errorType: result.error,
                remainingMs: result.remainingMs,
            });
        }

        // 非管理员用户需校验卡密状态（封禁 / 过期）
        if (result.role !== 'admin' && result.role !== 'super_admin') {
            if (result.card && result.card.enabled === false) {
                return res.status(403).json({ ok: false, error: '账号已被封禁，请联系管理员' });
            }
            if (result.card && result.card.expiresAt && result.card.expiresAt < Date.now()) {
                return res.status(403).json({ ok: false, error: '账号已过期，请续费后重新登录' });
            }
        }

        const token = issueToken();
        ctx.tokens.set(token, {
            token,
            username: result.username,
            role: result.role,
            qq: result.qq || '',
            card: result.card || null,
            accountLimit: result.accountLimit,
            mustChangePassword: result.mustChangePassword === true,
            createdAt: Date.now(),
        });
        if (typeof userStore.addLoginLog === 'function') {
            userStore.addLoginLog('login_success', result.username, null, clientIp, userAgent);
        }
        adminLogger.info('登录成功', { username: result.username, role: result.role, ip: clientIp });
        return res.json({
            ok: true,
            data: {
                token,
                role: result.role,
                card: result.card || null,
                qq: result.qq || '',
                accountLimit: result.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT,
                user: { username: result.username },
                mustChangePassword: result.mustChangePassword === true,
            },
        });
    });

    app.post('/api/register', (req: Request, res: Response) => {
        const { username, password, cardCode, qq } = req.body || {};
        if (!username || !password || !cardCode) {
            return res.status(400).json({ ok: false, error: '请填写完整信息' });
        }
        const result = userStore.registerUser(String(username), String(password), String(cardCode), qq);
        if (!result.ok) return res.status(400).json(result);
        res.json({ ok: true, data: result.user });
    });

    app.get('/api/card/info/:code', (req: Request, res: Response) => {
        try {
            const { code } = req.params;
            const card = userStore.getAllCards().find((item: any) => item.code === code);
            if (!card) return res.status(404).json({ ok: false, error: '卡密不存在' });
            if (!card.enabled) return res.status(400).json({ ok: false, error: '卡密已被禁用' });
            if (card.usedBy) return res.status(400).json({ ok: false, error: '卡密已被使用' });
            res.json({
                ok: true,
                data: {
                    type: card.type || 'time',
                    days: card.days,
                    value: card.value,
                    durationValue: card.durationValue,
                    durationUnit: card.durationUnit,
                    durationMs: card.durationMs,
                    isPermanent: card.isPermanent === true || card.days === -1,
                    description: card.description,
                },
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/public/renew', (req: Request, res: Response) => {
        try {
            const ip = getClientIp(req);
            const rateLimit = userStore.checkRateLimit(ip);
            if (!rateLimit.allowed) {
                return res.status(429).json({
                    ok: false,
                    error: rateLimit.message,
                    errorType: 'rate_limit',
                    remainingMs: rateLimit.remainingMs,
                });
            }
            const { username, cardCode } = req.body || {};
            if (!username) return res.status(400).json({ ok: false, error: '请提供用户名' });
            if (!cardCode) return res.status(400).json({ ok: false, error: '请提供卡密' });
            const result = userStore.renewUser(String(username), String(cardCode));
            if (!result.ok) return res.status(400).json(result);
            adminLogger.info('公开续费成功', { username, cardType: result.cardType, ip });
            res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/public/reset-password/verify', (req: Request, res: Response) => {
        try {
            const ip = getClientIp(req);
            const rateLimit = userStore.checkRateLimit(ip);
            if (!rateLimit.allowed) {
                return res.status(429).json({ ok: false, error: rateLimit.message, errorType: 'rate_limit', remainingMs: rateLimit.remainingMs });
            }
            const { username, cardCode } = req.body || {};
            if (!username || !cardCode) return res.status(400).json({ ok: false, error: '请提供用户名和卡密' });
            const result = userStore.verifyCardOwnership(String(username), String(cardCode));
            if (!result.ok) return res.status(400).json(result);
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/public/reset-password/confirm', (req: Request, res: Response) => {
        try {
            const ip = getClientIp(req);
            const rateLimit = userStore.checkRateLimit(ip);
            if (!rateLimit.allowed) {
                return res.status(429).json({ ok: false, error: rateLimit.message, errorType: 'rate_limit', remainingMs: rateLimit.remainingMs });
            }
            const { username, cardCode, newPassword } = req.body || {};
            if (!username || !cardCode || !newPassword) {
                return res.status(400).json({ ok: false, error: '请提供用户名、卡密和新密码' });
            }
            const result = userStore.resetPasswordByCard(String(username), String(cardCode), String(newPassword));
            if (!result.ok) return res.status(400).json(result);
            res.json({ ok: true, message: result.message });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    // 登录后：用户自助续费
    app.post('/api/user/renew', authRequired, (req: Request, res: Response) => {
        const currentUser = (req as any).currentUser;
        const { cardCode } = req.body || {};
        if (!currentUser) return res.status(401).json({ ok: false, error: '未登录' });
        if (!cardCode) return res.status(400).json({ ok: false, error: '请提供卡密' });
        const result = userStore.renewUser(currentUser.username, String(cardCode));
        if (!result.ok) return res.status(400).json(result);
        currentUser.card = result.card;
        currentUser.accountLimit = result.accountLimit;
        res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
    });

    app.post('/api/user/change-password', authRequired, (req: Request, res: Response) => {
        const currentUser = (req as any).currentUser;
        const { oldPassword, newPassword } = req.body || {};
        if (!currentUser) return res.status(401).json({ ok: false, error: '未登录' });
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
        }
        const result = userStore.changePassword(currentUser.username, String(oldPassword), String(newPassword));
        return res.json(result);
    });

    app.get('/api/user/me', (req: Request, res: Response) => {
        const currentUser = (req as any).currentUser;
        if (!currentUser) return res.status(401).json({ ok: false, error: '未登录' });
        res.json({
            ok: true,
            data: {
                username: currentUser.username,
                role: currentUser.role,
                qq: currentUser.qq || '',
                card: currentUser.card || null,
                accountLimit: currentUser.accountLimit,
                mustChangePassword: currentUser.mustChangePassword === true,
            },
        });
    });

    // 网关：以下接口需要登录态
    app.use('/api', (req: Request, res: Response, next: any) => {
        const publicPrefixes = ['/login', '/register', '/game-version', '/changelog', '/card/info', '/public/', '/card-claim/', '/announcement'];
        if (publicPrefixes.some(prefix => req.path === prefix || req.path.startsWith(prefix))) return next();
        return authRequired(req, res, next);
    });

    app.get('/api/ping', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/game-version', (_req: Request, res: Response) => {
        res.json({ ok: true, clientVersion: getRuntimeConfig().clientVersion, botVersion: version });
    });

    app.get('/api/auth/validate', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { valid: true } });
    });

    app.get('/api/scheduler', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            if (ctx.provider && typeof ctx.provider.getSchedulerStatus === 'function') {
                const data = await ctx.provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({
                ok: true,
                data: {
                    runtime: getSchedulerRegistrySnapshot(),
                    worker: null,
                    workerError: 'DataProvider does not support scheduler status',
                },
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req: Request, res: Response) => {
        const token = (req as any).adminToken;
        if (token) ctx.tokens.delete(token);
        if (ctx.io && token) {
            for (const socket of ctx.io.sockets.sockets.values()) {
                if (String((socket.data as any).adminToken || '') === String(token)) socket.disconnect(true);
            }
        }
        res.json({ ok: true });
    });
}

module.exports = { mountAuthRoutes };
