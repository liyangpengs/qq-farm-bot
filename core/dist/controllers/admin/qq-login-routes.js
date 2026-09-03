"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const { NapCatBridgeError, getNapCatQrCode, getNapCatLoginStatus, getNapCatQrImage, authorizeNapCatFarm, reclaimNapCatScanLease, } = require('../../services/napcat-bridge-consumer');
const { createAuthRequired } = require('./middleware');
const TASK_TTL_MS = 6 * 60_000; // QQ 扫码窗口比微信长（拉起临时实例数十秒）
const tasks = new Map();
function ownerOf(req) {
    return String(req.adminUser || '').trim() || 'default';
}
function publicTask(task) {
    return {
        task_id: task.id,
        status: task.status,
        has_qr: task.qr ? task.qr.length > 0 : false,
        expires_at: Math.floor((task.createdAt + TASK_TTL_MS) / 1000),
    };
}
function findTask(req, res, allowOwner) {
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
async function ensureQr(task) {
    if (task.qr && task.qr.length > 0) {
        return task;
    }
    // 懒触发：首次才真正拉起临时 QQ 实例（耗时数十秒），避免每次进面板都冷启动
    const data = await getNapCatQrCode(task.owner);
    const b64 = String(data?.image || data?.qr || '');
    if (b64) {
        try {
            task.qr = Buffer.from(b64, 'base64');
        }
        catch {
            task.qr = Buffer.alloc(0);
        }
    }
    task.qrDecodeUrl = String(data?.decodeUrl || '');
    return task;
}
function mountQqLoginRoutes(app, ctx) {
    app.use('/api/qq-login', createAuthRequired(ctx));
    app.post('/api/qq-login/tasks', async (req, res) => {
        const owner = ownerOf(req);
        try {
            const task = {
                id: node_crypto_1.default.randomBytes(32).toString('hex'),
                owner,
                createdAt: Date.now(),
                status: 'waiting',
                qr: Buffer.alloc(0),
            };
            tasks.set(task.id, task);
            try {
                await ensureQr(task);
            }
            catch (error) {
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
        }
        catch (error) {
            res.status(502).json({ ok: false, error: error.message });
        }
    });
    app.get('/api/qq-login/tasks/:taskId/qr', async (req, res) => {
        const task = findTask(req, res, ownerOf(req));
        if (!task)
            return;
        try {
            await ensureQr(task);
        }
        catch (error) {
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
    app.get('/api/qq-login/tasks/:taskId/status', async (req, res) => {
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
        }
        catch (error) {
            if (error instanceof NapCatBridgeError && error.busy) {
                res.status(409).json({ ok: false, error: error.message, busy: true, retryAfterMs: error.retryAfterMs });
                return;
            }
            res.status(502).json({ ok: false, error: error.message });
        }
    });
    app.post('/api/qq-login/tasks/:taskId/code', async (req, res) => {
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
        }
        catch (error) {
            res.status(502).json({ ok: false, error: error.message });
        }
    });
    app.delete('/api/qq-login/tasks/:taskId', (req, res) => {
        const task = findTask(req, res, ownerOf(req));
        if (!task)
            return;
        tasks.delete(task.id);
        res.json({ ok: true });
    });
}
module.exports = { mountQqLoginRoutes };
//# sourceMappingURL=qq-login-routes.js.map