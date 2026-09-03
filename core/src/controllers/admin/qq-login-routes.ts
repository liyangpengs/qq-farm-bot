export {};

import crypto from 'node:crypto';
import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';

const {
    NapCatBridgeError,
    getNapCatQrCode,
    getNapCatLoginStatus,
    getNapCatQrImage,
    authorizeNapCatFarm,
    reclaimNapCatScanLease,
} = require('../../services/napcat-bridge-consumer');
const { createAuthRequired } = require('./middleware');

const TASK_TTL_MS = 6 * 60_000; // QQ 扫码窗口比微信长（拉起临时实例数十秒）
type Status = 'waiting' | 'scanned' | 'authorized' | 'ready_for_code' | 'failed';
interface Task {
    id: string;
    owner: string;
    createdAt: number;
    status: Status;
    qr: Buffer;
    qrImage?: Buffer;
    qrDecodeUrl?: string;
    code?: string;
    uin?: string;
}
const tasks = new Map<string, Task>();

function ownerOf(req: Request): string {
    return String((req as any).adminUser || '').trim() || 'default';
}

function publicTask(task: Task) {
    return {
        task_id: task.id,
        status: task.status,
        has_qr: task.qr ? task.qr.length > 0 : false,
        expires_at: Math.floor((task.createdAt + TASK_TTL_MS) / 1000),
    };
}

function findTask(req: Request, res: Response, allowOwner: string): Task | null {
    const task = tasks.get(String(req.params.taskId || ''));
    if (!task || task.owner !== allowOwner) {
        res.status(404).json({ ok: false, error: 'Login task not found or expired' });
        return null;
    }
    if (Date.now() - task.createdAt > TASK_TTL_MS) {
        tasks.delete(task.id);
        res.status(404).json({ ok: false, error: 'Login task not found or expired' });
        return null;
    }
    return task;
}

async function ensureQr(task: Task): Promise<Task> {
    if (task.qr && task.qr.length > 0) {
        return task;
    }
    // 懒触发：首次才真正拉起临时 QQ 实例（耗时数十秒），避免每次进面板都冷启动
    const data = await getNapCatQrCode(task.owner);
    const b64 = String(data?.image || data?.qr || '');
    if (b64) {
        try { task.qr = Buffer.from(b64, 'base64'); } catch { task.qr = Buffer.alloc(0); }
    }
    task.qrDecodeUrl = String(data?.decodeUrl || '');
    return task;
}

function mountQqLoginRoutes(app: Application, ctx: AdminContext): void {
    app.use('/api/qq-login', createAuthRequired(ctx));

    app.post('/api/qq-login/tasks', async (req: Request, res: Response) => {
        const owner = ownerOf(req);
        try {
            const task: Task = {
                id: crypto.randomBytes(32).toString('hex'),
                owner,
                createdAt: Date.now(),
                status: 'waiting',
                qr: Buffer.alloc(0),
            };
            tasks.set(task.id, task);
            try {
                await ensureQr(task);
            } catch (error: any) {
                if (error instanceof NapCatBridgeError && error.busy) {
                    // 他人正在扫码：保留任务但不生成自己码，前端可看 busy 提示
                    res.json({
                        ok: true,
                        data: { ...publicTask(task), qr_url: `/api/qq-login/tasks/${task.id}/qr`, busy: true, retryAfterMs: error.retryAfterMs },
                    });
                    return;
                }
                throw error;
            }
            res.json({ ok: true, data: { ...publicTask(task), qr_url: `/api/qq-login/tasks/${task.id}/qr` } });
        } catch (error: any) {
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/qq-login/tasks/:taskId/qr', async (req: Request, res: Response) => {
        const task = findTask(req, res, ownerOf(req));
        if (!task)
            return;
        try {
            await ensureQr(task);
        } catch (error: any) {
            res.status(502).json({ ok: false, error: error.message });
            return;
        }
        if (task.qr && task.qr.length > 0) {
            res.type('png').send(task.qr);
        }
        else {
            res.status(404).json({ ok: false, error: 'QR not ready' });
        }
    });

    app.get('/api/qq-login/tasks/:taskId/status', async (req: Request, res: Response) => {
        const task = findTask(req, res, ownerOf(req));
        if (!task)
            return;
        try {
            const data = await getNapCatLoginStatus(task.owner);
            const bridgeStatus = String(data?.status || 'waiting');
            if (bridgeStatus === 'scanned') {
                task.status = 'scanned';
            }
            else if (bridgeStatus === 'authorized' || bridgeStatus === 'confirmed' || bridgeStatus === 'logged_in') {
                task.status = 'authorized';
            }
            else if (bridgeStatus === 'waiting' || bridgeStatus === 'scan_expired' || bridgeStatus === 'idle') {
                task.status = 'waiting';
            }
            else {
                task.status = 'waiting';
            }
            res.json({ ok: true, data: publicTask(task) });
        } catch (error: any) {
            if (error instanceof NapCatBridgeError && error.busy) {
                res.status(409).json({ ok: false, error: error.message, busy: true, retryAfterMs: error.retryAfterMs });
                return;
            }
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/qq-login/tasks/:taskId/code', async (req: Request, res: Response) => {
        const task = findTask(req, res, ownerOf(req));
        if (!task)
            return;
        try {
            // 先软重新占用，避免 5s 空闲租约被他人抢占
            await reclaimNapCatScanLease(task.owner).catch(() => undefined);
            const data = await authorizeNapCatFarm('', task.owner);
            const authorization = data?.authorization;
            const code = typeof authorization === 'string' ? authorization : String(data?.authorization?.code || data?.code || '');
            if (!code)
                throw new Error('未获取到 QQ 登录 Code');
            task.code = code;
            task.uin = String(data?.profile?.uin || data?.uin || '');
            task.status = 'ready_for_code';
            const result = {
                code,
                uin: task.uin,
                email: String(data?.profile?.email || ''),
                nick: String(data?.profile?.nick || data?.profile?.nickname || ''),
            };
            res.json({ ok: true, data: result });
            // 返回后清理：码已消费，租约也已在 bridge 侧释放
            tasks.delete(task.id);
        } catch (error: any) {
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    app.delete('/api/qq-login/tasks/:taskId', (req: Request, res: Response) => {
        const task = findTask(req, res, ownerOf(req));
        if (!task)
            return;
        tasks.delete(task.id);
        res.json({ ok: true });
    });
}

module.exports = { mountQqLoginRoutes };