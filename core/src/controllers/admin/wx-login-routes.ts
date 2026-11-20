import crypto from 'node:crypto';
import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import { WxLoginService } from '../../services/wx-login/service';
import type { ScanStatus, WxLoginSession } from '../../services/wx-login/service';

export { };

const { createAuthRequired } = require('./middleware');
const store = require('../../models/store');

const TARGET_APP_ID = 'wx5306c5978fdb76e4';
const TASK_TTL_MS = 110_000;
type Status = ScanStatus | 'ready_for_code' | 'failed';
interface Task { id: string; createdAt: number; status: Status; session: WxLoginSession; qr: Buffer; code?: string; pending?: Promise<void>; }
const tasks = new Map<string, Task>();
const wxLogin = new WxLoginService();

function destroy(task: Task): void { wxLogin.destroy(task.session); task.code = undefined; tasks.delete(task.id); }
function publicTask(task: Task) { return { task_id: task.id, app_id: TARGET_APP_ID, status: task.status, expires_at: Math.floor((task.createdAt + TASK_TTL_MS) / 1000) }; }
function findTask(req: Request, res: Response): Task | null {
    const task = tasks.get(String(req.params.taskId || ''));
    if (!task || Date.now() - task.createdAt > TASK_TTL_MS) { if (task) destroy(task); res.status(404).json({ ok: false, error: 'Login task not found or expired' }); return null; }
    return task;
}
async function createTask(): Promise<Task> {
    const { session, qr } = await wxLogin.createQrSession();
    const task: Task = { id: crypto.randomBytes(32).toString('hex'), createdAt: Date.now(), status: 'waiting', session, qr };
    tasks.set(task.id, task);
    return task;
}
async function poll(task: Task): Promise<void> { if (task.status === 'authorized' || task.status === 'ready_for_code') return; task.status = await wxLogin.poll(task.session); }
async function confirm(task: Task): Promise<void> {
    if (task.status !== 'authorized') throw new Error('Waiting for scan authorization');
    await wxLogin.confirm(task.session);
    task.status = 'ready_for_code';
}
async function consumeCode(task: Task): Promise<void> { if (task.status !== 'ready_for_code') throw new Error('Login code is not ready'); task.code = await wxLogin.issueCode(task.session, TARGET_APP_ID); }

function mountWxLoginRoutes(app: Application, ctx: AdminContext): void {
    app.use('/api/wx-login', createAuthRequired(ctx));

    app.post('/api/wx-login/tasks', async (req, res) => { if (req.body?.app_id && req.body.app_id !== TARGET_APP_ID) return res.status(400).json({ ok: false, error: 'Unsupported app_id' }); try { const task = await createTask(); res.json({ ok: true, data: { ...publicTask(task), qr_url: `/api/wx-login/tasks/${task.id}/qr` } }); } catch (error: any) { res.status(502).json({ ok: false, error: error.message }); } });
    app.get('/api/wx-login/tasks/:taskId/qr', (req, res) => { const task = findTask(req, res); if (task) res.type('jpeg').send(task.qr); });
    app.delete('/api/wx-login/tasks/:taskId', (req, res) => {
        const task = tasks.get(String(req.params.taskId || ''));
        if (!task) return res.status(404).json({ ok: false, error: 'Login task not found or expired' });
        destroy(task);
        return res.json({ ok: true });
    });
    app.get('/api/wx-login/tasks/:taskId/status', async (req, res) => { const task = findTask(req, res); if (!task) return; try { if (!task.pending) task.pending = poll(task).finally(() => { task.pending = undefined; }); await task.pending; const data = publicTask(task); if (task.status === 'cancelled' || task.status === 'expired') destroy(task); res.json({ ok: true, data }); } catch (error: any) { task.status = 'failed'; destroy(task); res.status(502).json({ ok: false, error: error.message }); } });
    app.post('/api/wx-login/tasks/:taskId/confirm', async (req, res) => { const task = findTask(req, res); if (!task) return; try { if (!task.pending) task.pending = confirm(task).finally(() => { task.pending = undefined; }); await task.pending; res.json({ ok: true, data: publicTask(task) }); } catch (error: any) { task.status = 'failed'; destroy(task); res.status(502).json({ ok: false, error: error.message }); } });
    app.post('/api/wx-login/tasks/:taskId/code', async (req, res) => {
        const task = findTask(req, res);
        if (!task) return;
        try {
            if (!task.pending) task.pending = consumeCode(task).finally(() => { task.pending = undefined; });
            await task.pending;
            // 续期凭据随 Code 一起下发：前端在新增/重新登录账号时一并提交，之后就能免扫码续期。
            const credential = {
                wxid: task.session.openid || '',
                refreshtoken: task.session.refreshtoken || '',
                accesstoken: task.session.accesstoken || '',
                loginBuffer: task.session.loginBuffer || '',
                expires_in: Number(task.session.expires_in) || 0,
                expires_at: Number(task.session.expires_at) || 0,
                wxCredentialRefreshedAt: Number(task.session.expires_at) ? Date.now() : 0,
            };
            const body: any = (req.body && typeof req.body === 'object') ? req.body : {};
            const accountId = String(body.account_id || body.accountId || '').trim();
            // 只要拿到长效凭证就写回：部分环境不回传 refreshtoken，
            // 但 loginBuffer 仍可直接换 Code，不能因为缺 refreshtoken 就丢掉整套凭据。
            let credentialSaveError = '';
            if (accountId && (credential.refreshtoken || credential.loginBuffer)) {
                // 编辑重扫场景：直接把新凭据写回账号，避免只更新 Code 导致下次续期用旧 token。
                try {
                    store.addOrUpdateAccount({
                        id: accountId,
                        code: task.code,
                        wxid: credential.wxid,
                        refreshtoken: credential.refreshtoken,
                        accesstoken: credential.accesstoken,
                        loginBuffer: credential.loginBuffer,
                        expires_in: credential.expires_in,
                        expires_at: credential.expires_at,
                        wxCredentialRefreshedAt: credential.wxCredentialRefreshedAt,
                        wxCredentialLastAttemptAt: Date.now(),
                        wxCredentialRefreshError: '',
                    });
                } catch (error: any) {
                    // 账号不存在时 addOrUpdateAccount 是静默跳过（不抛错），能走到这里
                    // 说明是写盘失败：长效凭据没落盘，重启后必然丢，不能回报成功让前端
                    // 以为免扫码续期已经生效。同时把原因落日志，别只靠前端 toast。
                    credentialSaveError = String((error && error.message) || error);
                    console.error(`[微信登录] 账号 ${accountId} 长效凭据保存失败：${credentialSaveError}`);
                }
            }
            const data = { openid: task.session.openid, app_id: TARGET_APP_ID, code: task.code, nickname: task.session.nickname || '', credential, err_msg: 'login:ok' };
            destroy(task);
            if (credentialSaveError) {
                return res.status(500).json({ ok: false, error: `凭据保存失败，请重试：${credentialSaveError}` });
            }
            res.json({ ok: true, data });
        } catch (error: any) {
            task.status = 'failed';
            destroy(task);
            res.status(502).json({ ok: false, error: error.message });
        }
    });
}
module.exports = { mountWxLoginRoutes };
