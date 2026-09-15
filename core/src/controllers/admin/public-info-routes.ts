import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const fetch = require('node-fetch');
const store = require('../../models/store');

const {
    createAuthRequired,
    createRequireAdminRole,
} = require('./middleware');

const CHANGELOG_URL = 'https://gitee.com/xlzcandy/qq-classic-farm-update-log/raw/master/README.md';

function mountPublicInfoRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);
    const requireAdminRole = createRequireAdminRole();

    app.get('/api/announcement', (req: Request, res: Response) => {
        try {
            const currentUser = (req as any).currentUser;
            const username = currentUser?.username || null;
            const announcement = store.getAnnouncement();
            const shouldShow = !!announcement.content && store.shouldShowAnnouncement(username || 'guest');
            res.json({
                ok: true,
                data: {
                    content: announcement.content || '',
                    showOnce: announcement.showOnce !== false,
                    updatedAt: announcement.updatedAt || 0,
                    shouldShow,
                },
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/announcement/read', (req: Request, res: Response) => {
        try {
            const currentUser = (req as any).currentUser;
            const username = currentUser?.username || req.body?.username || 'guest';
            if (username && username !== 'guest') store.markAnnouncementRead(username);
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/changelog', async (_req: Request, res: Response) => {
        try {
            const response = await fetch(CHANGELOG_URL);
            if (!response.ok) return res.status(500).json({ ok: false, error: '获取更新日志失败' });
            const data = await response.text();
            res.json({ ok: true, data });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    // 公开：登录页品牌与加群链接配置
    app.get('/api/public/login-config', (_req: Request, res: Response) => {
        try {
            const settings = store.getLoginSettings ? store.getLoginSettings() : {};
            res.json({
                ok: true,
                data: {
                    logoUrl: settings.logoUrl || '',
                    loginSubtitle: settings.loginSubtitle || '',
                    registerSubtitle: settings.registerSubtitle || '',
                    purchaseUrl: settings.purchaseUrl || '',
                    qqGroupUrl: settings.qqGroupUrl || '',
                },
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/admin/announcement', authRequired, requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: store.getAnnouncement() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/announcement', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            const content = String(req.body?.content || '').trim();
            const showOnce = req.body?.showOnce !== false;
            const announcement = store.setAnnouncement(content, showOnce);
            res.json({ ok: true, data: announcement });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountPublicInfoRoutes };
