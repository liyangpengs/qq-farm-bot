import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { createModuleLogger } = require('../../services/logger');
const userStore = require('../../models/user-store');

const {
    createAuthRequired,
    createRequireAdminRole,
    requireDangerConfirmation,
} = require('./middleware');

const adminLogger = createModuleLogger('admin');

function mountCardRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);
    const requireAdminRole = createRequireAdminRole();

    app.get('/api/admin/cards', authRequired, requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: userStore.getAllCards() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/cards', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const count = Number.parseInt(body.count, 10) || 0;
            const confirmation = count > 1 ? 'CREATE_CARDS_BATCH' : 'CREATE_CARD';
            if (!requireDangerConfirmation(req, res, confirmation)) return;

            const { description, days, type, durationValue, durationUnit, isPermanent, value } = body;
            if (!description || (days === undefined && durationValue === undefined && value === undefined && !isPermanent)) {
                return res.status(400).json({ ok: false, error: '请提供描述和时长' });
            }

            const cardType = type === 'quota' ? 'quota' : 'time';
            const permanentRequested = isPermanent === true || Number(days) === -1 || Number(durationValue) === -1;
            const requestedValue = Number(cardType === 'quota' ? (value ?? days) : (durationValue ?? days));
            if (cardType === 'time' && !permanentRequested && (!Number.isFinite(requestedValue) || requestedValue <= 0)) {
                return res.status(400).json({ ok: false, error: '时间卡时长必须大于 0，永久卡请使用 -1' });
            }
            if (cardType === 'quota' && (!Number.isFinite(requestedValue) || requestedValue <= 0)) {
                return res.status(400).json({ ok: false, error: '额度卡数量必须大于 0' });
            }

            const durationOptions = { durationValue, durationUnit, isPermanent, value };
            if (count > 1) {
                const cards = userStore.createCardsBatch(description, days, count, cardType, durationOptions);
                return res.json({ ok: true, data: cards, batch: true, count: cards.length });
            }
            const card = userStore.createCard(description, days, cardType, durationOptions);
            res.json({ ok: true, data: card });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/cards/batch-delete', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'DELETE_CARDS_BATCH')) return;
            const { codes } = req.body || {};
            if (!Array.isArray(codes) || codes.length === 0) {
                return res.status(400).json({ ok: false, error: '请提供要删除的卡密列表' });
            }
            const result = userStore.deleteCardsBatch(codes);
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/cards/:code', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_CARD_STATUS')) return;
            const { code } = req.params;
            const card = userStore.updateCard(code, req.body || {});
            if (!card) return res.status(404).json({ ok: false, error: '卡密不存在' });
            res.json({ ok: true, data: card });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.delete('/api/admin/cards/:code', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'DELETE_CARD')) return;
            const { code } = req.params;
            const deleted = userStore.deleteCard(code);
            if (!deleted) return res.status(404).json({ ok: false, error: '卡密不存在' });
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    // 公开：卡密领取状态
    app.get('/api/card-claim/status', (_req: Request, res: Response) => {
        try {
            const status = userStore.getCardClaimStatus();
            const availableTimeCards = userStore.getAvailableTimeCardCount();
            res.json({ ok: true, enabled: status.enabled, availableTimeCards });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/card-claim/status', authRequired, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_CARD_CLAIM_STATUS')) return;
            const { enabled } = req.body;
            const availableTimeCards = userStore.getAvailableTimeCardCount();
            if (enabled && availableTimeCards <= 0) {
                return res.status(400).json({ ok: false, error: '可领取时间卡密库存不足，无法开启卡密领取功能', availableTimeCards });
            }
            const status = userStore.setCardClaimStatus(enabled);
            res.json({ ok: true, enabled: status.enabled, availableTimeCards });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/card-claim/claim', (req: Request, res: Response) => {
        try {
            const userAgent = String(req.headers['user-agent'] || '');
            const username = (req.body && req.body.username) || null;
            userStore.clearExpiredClaimRecords();
            const claim = userStore.claimCardByUA(userAgent, username);
            if (!claim.ok) {
                const payload: any = { ok: false, error: claim.error };
                if (claim.remainingMs) payload.remainingMs = claim.remainingMs;
                return res.status(400).json(payload);
            }
            res.json({ ok: true, cardCode: claim.cardCode, days: claim.days, description: claim.description });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/admin/card-claim/records', authRequired, requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: userStore.getCardClaimRecords() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountCardRoutes };
