import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Update awareness for the panel.
 *
 * The container cannot update itself, so the optional host-side updater
 * (tools/updater) writes a status file into the shared data volume and watches
 * for request files. These routes only read that status and drop request
 * markers; no git or docker work happens inside the container.
 */
const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../../config/runtime-paths');
const { createAuthRequired } = require('./middleware');

const STATUS_FILE: string = getDataFile('update-status.json');
const REQUEST_FILE: string = getDataFile('update-request.json');
const CHECK_FILE: string = getDataFile('update-check-request');

function readJson(file: string): any {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeJson(file: string, data: any): void {
    ensureDataDir();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

function mountUpdateRoutes(app: Application, ctx: AdminContext): void {
    app.use('/api/update', createAuthRequired(ctx));

    app.get('/api/update/status', (_req: Request, res: Response) => {
        const status = readJson(STATUS_FILE) || { state: 'unknown', hasUpdate: false, checkedAt: 0 };
        const requested = readJson(REQUEST_FILE);
        res.json({ ok: true, data: { ...status, requestPending: !!requested } });
    });

    app.post('/api/update/check', (_req: Request, res: Response) => {
        try {
            ensureDataDir();
            fs.writeFileSync(CHECK_FILE, String(Date.now()));
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error && error.message ? error.message : '无法触发检查' });
        }
    });

    app.post('/api/update/apply', (_req: Request, res: Response) => {
        try {
            writeJson(REQUEST_FILE, { requestedAt: Date.now() });
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error && error.message ? error.message : '无法提交更新请求' });
        }
    });
}

module.exports = { mountUpdateRoutes };
