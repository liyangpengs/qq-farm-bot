import type { Application, Request, Response } from 'express';
export {};

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { once } = require('node:events');
const { runWithHttpRequestContext } = require('../../app/http-request-context');
const {
    getPerformanceStatus,
    preparePerformanceExport,
    recordHttpRequest,
} = require('../../services/performance-metrics');

function normalizeFallbackRoute(input: unknown): string {
    return String(input || '/api/unknown')
        .split('?')[0]
        .replace(/[a-f0-9]{24,}/gi, ':id')
        .replace(/\/\d{4,}(?=\/|$)/g, '/:id');
}

function createPerformanceMiddleware() {
    return (req: Request, res: Response, next: () => void): void => {
        const requestId = randomUUID();
        const wallStartedAt = Date.now();
        const startedAt = process.hrtime.bigint();
        res.setHeader('X-Request-Id', requestId);
        res.once('finish', () => {
            const finishedAt = Date.now();
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            recordHttpRequest({
                requestId,
                accountId: req.headers['x-account-id'],
                method: req.method,
                route: (req.route && req.route.path) || normalizeFallbackRoute(req.originalUrl),
                statusCode: res.statusCode,
                durationMs,
                startedAt: wallStartedAt,
                finishedAt,
            });
        });
        runWithHttpRequestContext(requestId, next);
    };
}

function mountPerformanceRoutes(app: Application): void {
    app.get('/api/performance/status', (_req: Request, res: Response) => {
        res.json({ ok: true, data: getPerformanceStatus() });
    });

    app.get('/api/performance/export', async (req: Request, res: Response) => {
        const exported = preparePerformanceExport(req.query.days);
        res.status(200);
        res.type('application/x-ndjson');
        res.attachment(`qq-farm-performance-${exported.days}d.jsonl`);
        res.setHeader('X-Performance-File-Count', String(exported.files.length));

        for (const filePath of exported.files) {
            const stream = fs.createReadStream(filePath);
            for await (const chunk of stream) {
                if (!res.write(chunk)) await once(res, 'drain');
            }
        }
        res.end();
    });
}

module.exports = {
    createPerformanceMiddleware,
    mountPerformanceRoutes,
    normalizeFallbackRoute,
};
