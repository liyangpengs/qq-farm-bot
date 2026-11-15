import type { Application, Request, Response } from 'express';
import { GameAssistLoginService } from '../../services/wx-login/gameassist-service';
import * as credentials from '../../services/gameassist/credentials';

export { };

const { createAuthRequired } = require('./middleware');
const { createModuleLogger } = require('../../services/logger');

const logger = createModuleLogger('gameassist');
const CH_LOG = '手游助手扫码';
const TASK_TTL_MS = 10 * 60 * 1000;

const loginService = new GameAssistLoginService();
const scanTasks = new Map<string, { session: any, qr: Buffer, createdAt: number }>();
let taskSeq = 0;

function pruneTasks(): void {
    const now = Date.now();
    for (const [id, task] of scanTasks) {
        if (now - task.createdAt > TASK_TTL_MS) {
            try { loginService.destroy(task.session); } catch { /* ignore */ }
            scanTasks.delete(id);
        }
    }
}

function findTask(req: Request, res: Response): { session: any, qr: Buffer, createdAt: number } | null {
    pruneTasks();
    const task = scanTasks.get(String(req.params.taskId || ''));
    if (!task) {
        res.status(404).json({ ok: false, error: '扫码任务不存在或已过期，请重新获取二维码' });
        return null;
    }
    return task;
}

/**
 * 手游助手扫码登录渠道：
 * 与 PC 端腾讯手游助手同链路（WMPF/ILink 取码栈同构，仅凭据签发不同）。
 * 面板展示二维码 → 微信扫码 → 服务器完成 syzs OAuth 换凭据 → 复用
 * pcyyb_get_wx_login_buffer_auth + native protocol 铸农场 code；
 * 凭据入库后由 syzs 专线（/v3/syzs_refresh_token）自动续期，无需重新扫码。
 */
export function mountGameAssistRoutes(app: Application, ctx: any): void {
    const authRequired = createAuthRequired(ctx);

    app.post('/api/gameassist-login/tasks', authRequired, async (_req: Request, res: Response) => {
        pruneTasks();
        try {
            const { session, qr } = await loginService.createQrSession();
            const taskId = `ga-${Date.now()}-${++taskSeq}`;
            scanTasks.set(taskId, { session, qr, createdAt: Date.now() });
            return res.json({ ok: true, data: { task_id: taskId, qr_url: `/api/gameassist-login/tasks/${taskId}/qr` } });
        } catch (error: any) {
            return res.status(502).json({ ok: false, error: error && error.message ? error.message : String(error) });
        }
    });

    app.get('/api/gameassist-login/tasks/:taskId/qr', authRequired, (req: Request, res: Response) => {
        const task = findTask(req, res);
        if (task) res.type('jpeg').send(task.qr);
    });

    app.get('/api/gameassist-login/tasks/:taskId/status', authRequired, async (req: Request, res: Response) => {
        const task = findTask(req, res);
        if (!task) return;
        try {
            const status = await loginService.poll(task.session);
            return res.json({ ok: true, data: { status } });
        } catch (error: any) {
            scanTasks.delete(String(req.params.taskId || ''));
            return res.status(502).json({ ok: false, error: error && error.message ? error.message : String(error) });
        }
    });

    app.post('/api/gameassist-login/tasks/:taskId/confirm', authRequired, async (req: Request, res: Response) => {
        const task = findTask(req, res);
        if (!task) return;
        try {
            const creds = await loginService.confirm(task.session);
            credentials.upsert(creds);
            loginService.destroy(task.session);
            scanTasks.delete(String(req.params.taskId || ''));
            logger.info(`扫码凭据已入库（openid ${String(creds.openid).slice(0, 10)}…${creds.nickname ? `，昵称 ${creds.nickname}` : ''}）`, { channel: CH_LOG, result: 'success' });
            // 立即铸一枚农场 code，前端走 POST /api/accounts 原通道创建账号
            const code = await credentials.mintFarmCodeByCredentials(creds.openid);
            return res.json({ ok: true, data: { code, openid: creds.openid, nickname: creds.nickname || '', expires_in: creds.expires_in } });
        } catch (error: any) {
            scanTasks.delete(String(req.params.taskId || ''));
            return res.status(502).json({ ok: false, error: error && error.message ? error.message : String(error) });
        }
    });

    app.post('/api/gameassist-login/credentials/bind', authRequired, (req: Request, res: Response) => {
        try {
            const record = credentials.bind(String((req.body as any)?.account_id || ''), String((req.body as any)?.openid || ''));
            logger.info(`凭据已绑定账号 ${(req.body as any)?.account_id}`, { channel: CH_LOG, result: 'success' });
            return res.json({ ok: true, data: { openid: record.openid, accountId: record.accountId } });
        } catch (error: any) {
            return res.status(400).json({ ok: false, error: error && error.message ? error.message : String(error) });
        }
    });

    app.get('/api/gameassist-login/credentials', authRequired, (_req: Request, res: Response) => {
        return res.json({ ok: true, data: { items: credentials.list() } });
    });
}
