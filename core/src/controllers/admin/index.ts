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
const { mountWxLoginRoutes } = require('./wx-login-routes');
const { mountQqLoginRoutes } = require('./qq-login-routes');
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

    const { getWebRootInfo } = require('../../config/runtime-paths');
    const resolveActiveWebDirs = (): string[] => {
        const { webRoot, fallbackRoots } = getWebRootInfo();
        return [webRoot, ...fallbackRoots];
    };
    const staticMiddlewareCache = new Map<string, any>();
    const serveDynamicWeb = (req: any, res: any, next: any) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config') || req.path.startsWith('/socket.io')) return next();
        const dirs = resolveActiveWebDirs();
        for (const cached of staticMiddlewareCache.keys()) {
            if (!dirs.includes(cached)) staticMiddlewareCache.delete(cached);
        }
        let idx = 0;
        const step = (err?: any) => {
            if (err) return next(err);
            if (idx >= dirs.length) return next();
            const dir = dirs[idx++];
            let mw = staticMiddlewareCache.get(dir);
            if (!mw) {
                mw = express.static(dir);
                staticMiddlewareCache.set(dir, mw);
            }
            mw(req, res, step);
        };
        step();
    };
    const sendDynamicIndex = (res: any, fallbackStatus: number) => {
        for (const dir of resolveActiveWebDirs()) {
            const indexPath = path.join(dir, 'index.html');
            if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
        }
        if (fallbackStatus !== 200) res.status(fallbackStatus);
        res.send('web build not found. Please build the web project.');
    };
    const [webDist] = resolveActiveWebDirs();
    app.use(serveDynamicWeb);
    if (!fs.existsSync(webDist)) {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (_req: any, res: any) => sendDynamicIndex(res, 200));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // Mount route modules
    mountAuthRoutes(app, ctx);
    mountWxLoginRoutes(app, ctx);
    mountQqLoginRoutes(app, ctx);
    mountFarmRoutes(app, ctx);
    mountFriendRoutes(app, ctx);
    mountAccountRoutes(app, ctx);
    mountActivityCenterRoutes(app, ctx);
    mountCommerceRoutes(app, ctx);

    // SPA fallback
    app.get('*', (req: any, res: any) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
             return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        return sendDynamicIndex(res, 404);
    });

    const port: number = CONFIG.adminPort || 3007;
    ctx.server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    // Setup Socket.IO
    setupSocketIO(ctx);

}

async function stopAdminServer(): Promise<void> {
    const server = ctx?.server;
    if (!server) return;
    ctx?.io?.disconnectSockets(true);
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections?.();
    await closed;
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
    startAdminServer, stopAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
