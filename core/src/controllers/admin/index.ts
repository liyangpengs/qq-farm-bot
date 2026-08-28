import type { AdminContext } from './context';
export {};

/**
 * Admin panel HTTP server orchestrator.
 * Thin wrapper that wires up Express, routes, Socket.IO, and shared context.
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { CONFIG } = require('../../config/config');
const { getResourcePath } = require('../../config/runtime-paths');
const { createModuleLogger } = require('../../services/logger');

const { createAdminContext } = require('./context');
const { mountAuthRoutes } = require('./auth-routes');
const { mountAccountRoutes } = require('./account-routes');
const { mountFarmRoutes } = require('./farm-routes');
const { mountFriendRoutes } = require('./friend-routes');
const { mountActivityCenterRoutes } = require('./activity-center-routes');
const { mountCommerceRoutes } = require('./commerce-routes');
const { createPerformanceMiddleware, mountPerformanceRoutes } = require('./performance-routes');
const { mountWxLoginRoutes } = require('./wx-login-routes');
const {
    setupSocketIO,
    emitRealtimeStatus: _emitStatus,
    emitRealtimeLog: _emitLog,
    emitRealtimeAccountLog: _emitAccountLog,
} = require('./socket');

const adminLogger = createModuleLogger('admin');

let ctx: AdminContext | null = null;

function startAdminServer(dataProvider: any): void {
    if (ctx) return;

    ctx = createAdminContext(dataProvider);

    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api', createPerformanceMiddleware());

    ctx.app = app;

    app.use((req: any, res: any, next: any) => {
        const allowedOrigins: string[] = CONFIG.ALLOWED_ORIGINS || ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
        const origin = req.headers.origin;

        if (origin && allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
        } else if (!origin) {
            res.header('Access-Control-Allow-Origin', '*');
        }

        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PUT');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-admin-token, x-proxy-api-key, x-proxy-api-url, x-proxy-app-id');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Max-Age', '86400');

        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    const webDist = path.join(__dirname, '../../../../web/dist');
    if (fs.existsSync(webDist)) {
        app.use(express.static(webDist));
    } else {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (_req: any, res: any) => res.send('web build not found. Please build the web project.'));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // Mount route modules
    mountAuthRoutes(app, ctx);
    mountWxLoginRoutes(app, ctx);
    mountFarmRoutes(app, ctx);
    mountFriendRoutes(app, ctx);
    mountAccountRoutes(app, ctx);
    mountActivityCenterRoutes(app, ctx);
    mountCommerceRoutes(app, ctx);
    mountPerformanceRoutes(app);

    // SPA fallback
    app.get('*', (req: any, res: any) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
             return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        if (fs.existsSync(webDist)) {
            res.sendFile(path.join(webDist, 'index.html'));
        } else {
            res.status(404).send('web build not found. Please build the web project.');
        }
    });

    const port: number = CONFIG.adminPort || 3007;
    ctx.server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    // Setup Socket.IO
    setupSocketIO(ctx);

}

function emitRealtimeStatus(accountId: string, status: any): void {
    if (!ctx) return;
    _emitStatus(ctx, accountId, status);
}

function emitRealtimeLog(entry: any): void {
    if (!ctx) return;
    _emitLog(ctx, entry);
}

function emitRealtimeAccountLog(entry: any): void {
    if (!ctx) return;
    _emitAccountLog(ctx, entry);
}

module.exports = {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
