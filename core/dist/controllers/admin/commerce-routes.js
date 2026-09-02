"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { getAccId } = require('./middleware');
const ERROR_MESSAGES = {
    INVALID_GOODS_ID: '商品信息无效，请刷新商城后重试',
    INVALID_PURCHASE_COUNT: '购买数量必须是有效的正整数',
    GOODS_NOT_FOUND: '商品已不在当前商城中，请刷新后重试',
    GOODS_UNAVAILABLE: '商品当前不可购买',
    PURCHASE_LIMIT_EXCEEDED: '购买数量超过剩余限购数量',
    INSUFFICIENT_BALANCE: '货币余额不足，无法完成购买',
    INVALID_MYSTERY_NPC_ID: '神秘商人信息无效，请刷新后重试',
    MYSTERY_OFFER_STALE: '神秘商人货品已变化，请刷新后重试',
    MYSTERY_PURCHASE_NOT_CONFIRMED: '购买结果未确认，请刷新后查看',
};
function friendlyError(error) {
    const raw = String(error?.message || error || '操作失败');
    const code = String(error?.code || raw.match(/\bcode=(\d+)\b/)?.[1] || 'COMMERCE_OPERATION_FAILED');
    if (ERROR_MESSAGES[code])
        return { code, message: ERROR_MESSAGES[code] };
    if (raw.includes('账号未运行') || raw.includes('账号已离线') || raw.includes('连接未打开') || raw.includes('账号尚未登录')) {
        return { code: 'ACCOUNT_OFFLINE', message: '当前账号尚未运行，请启动账号后重试' };
    }
    if (raw.includes('请求超时') || raw === 'API Timeout') {
        return { code: 'COMMERCE_TIMEOUT', message: '游戏服务响应超时，请稍后重试' };
    }
    return { code, message: raw || '操作失败，请刷新后重试' };
}
function mountCommerceRoutes(app, ctx) {
    const withAccount = (handler) => {
        return async (req, res) => {
            const accountId = getAccId(ctx, req);
            if (!accountId)
                return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            try {
                const data = await handler(accountId, req);
                return res.json({ ok: true, data });
            }
            catch (error) {
                const result = friendlyError(error);
                return res.json({ ok: false, error: result.message, errorCode: result.code });
            }
        };
    };
    app.get('/api/game-mall', withAccount((accountId, req) => (ctx.provider.getMallCatalog(accountId, req.query.slotType, req.query.subSlotType))));
    app.post('/api/game-mall/purchase', withAccount((accountId, req) => (ctx.provider.purchaseMallProduct(accountId, req.body?.goodsId, req.body?.count))));
    app.get('/api/mystery-shop', withAccount((accountId) => (ctx.provider.getMysteryShop(accountId))));
    app.post('/api/mystery-shop/purchase', withAccount((accountId, req) => (ctx.provider.purchaseMysteryOffer(accountId, req.body?.npcId))));
}
module.exports = { mountCommerceRoutes };
//# sourceMappingURL=commerce-routes.js.map