export {};

const { getAutomation } = require('../models/store');
const { log, logWarn } = require('../utils/utils');

const GOLD_ITEM_ID = 1001;
const COUPON_ITEM_ID = 1002;
const DIAMOND_ITEM_ID = 1004;
const GOLD_BEAN_ITEM_ID = 1005;

const CURRENCY_ALLOW_KEYS: Record<number, string> = {
    [GOLD_ITEM_ID]: 'mystery_shop_allow_gold',
    [COUPON_ITEM_ID]: 'mystery_shop_allow_coupon',
    [DIAMOND_ITEM_ID]: 'mystery_shop_allow_diamond',
    [GOLD_BEAN_ITEM_ID]: 'mystery_shop_allow_gold_bean',
};

const MYSTERY_SHOP_AUTOMATION_KEYS = [
    'mystery_shop_auto_buy',
    'mystery_shop_allow_gold',
    'mystery_shop_allow_coupon',
    'mystery_shop_allow_gold_bean',
    'mystery_shop_allow_diamond',
    'mystery_shop_arrival_notify',
    'mystery_shop_purchase_notify',
] as const;

const AUTO_BUY_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_BUY_INITIAL_DELAY_MS = 10 * 1000;
const AUTO_BUY_AFTER_SAVE_DELAY_MS = 2 * 1000;

interface MysteryShopAutoState {
    lastArrivalKey: string;
    lastPurchaseKey: string;
}

interface MysteryShopDecision {
    skipReason?: 'inactive' | 'disabled';
    visitKey?: string;
    notifyArrival: boolean;
    shouldBuy: boolean;
    skipBuyReason?: 'auto_buy_off' | 'currency_not_allowed' | 'balance_unknown' | 'insufficient';
}

interface MysteryShopPushFlags {
    arrival: boolean;
    purchase: boolean;
}

const defaultState: MysteryShopAutoState = {
    lastArrivalKey: '',
    lastPurchaseKey: '',
};

function createMysteryShopAutoState(): MysteryShopAutoState {
    return { lastArrivalKey: '', lastPurchaseKey: '' };
}

function isMysteryShopWatchEnabled(automation: any = {}): boolean {
    return automation.mystery_shop_auto_buy === true || automation.mystery_shop_arrival_notify === true;
}

function mysteryShopConfigChanged(prevAuto: any = {}, nextAuto: any = {}): boolean {
    return MYSTERY_SHOP_AUTOMATION_KEYS.some(key => !!prevAuto[key] !== !!nextAuto[key]);
}

function isCurrencyAllowed(currencyId: number, automation: any = {}): boolean {
    const key = CURRENCY_ALLOW_KEYS[Number(currencyId) || 0];
    return !!key && automation[key] === true;
}

function canAffordOffer(price: any): { ok: boolean; reason?: 'balance_unknown' | 'insufficient' } {
    if (price?.balance === null || price?.balance === undefined) {
        return { ok: false, reason: 'balance_unknown' };
    }
    if (Number(price.balance) < Number(price.count)) {
        return { ok: false, reason: 'insufficient' };
    }
    return { ok: true };
}

function mysteryShopVisitKey(shop: any): string {
    const npcId = Math.max(0, Number(shop?.npc?.id) || 0);
    const activeTime = Math.max(0, Number(shop?.activeTime) || 0);
    return `${npcId}:${activeTime}`;
}

function decideMysteryShopTick(shop: any, automation: any = {}, state: MysteryShopAutoState = defaultState): MysteryShopDecision {
    const npc = shop?.npc;
    if (!shop?.active || !npc?.id || Number(npc?.reward?.count) <= 0) {
        return { notifyArrival: false, shouldBuy: false, skipReason: 'inactive' };
    }

    const visitKey = mysteryShopVisitKey(shop);
    const notifyArrival = automation.mystery_shop_arrival_notify === true && state.lastArrivalKey !== visitKey;

    if (automation.mystery_shop_auto_buy !== true) {
        return { visitKey, notifyArrival, shouldBuy: false, skipBuyReason: 'auto_buy_off' };
    }
    if (!isCurrencyAllowed(npc.price?.id, automation)) {
        return { visitKey, notifyArrival, shouldBuy: false, skipBuyReason: 'currency_not_allowed' };
    }
    const afford = canAffordOffer(npc.price);
    if (!afford.ok) {
        return { visitKey, notifyArrival, shouldBuy: false, skipBuyReason: afford.reason };
    }
    return { visitKey, notifyArrival, shouldBuy: true };
}

function resolveMysteryShopPushFlags(
    decision: MysteryShopDecision,
    bought: boolean,
    automation: any = {},
    state: MysteryShopAutoState = defaultState,
): MysteryShopPushFlags {
    if (!decision.visitKey) return { arrival: false, purchase: false };
    return {
        arrival: !!decision.notifyArrival,
        purchase: !!(bought && automation.mystery_shop_purchase_notify === true && state.lastPurchaseKey !== decision.visitKey),
    };
}

function commitMysteryShopNotify(state: MysteryShopAutoState, visitKey: string, flags: MysteryShopPushFlags): void {
    if (!visitKey) return;
    if (flags.arrival) state.lastArrivalKey = visitKey;
    if (flags.purchase) state.lastPurchaseKey = visitKey;
}

function remainingLabel(expireTime: number): string {
    const diff = Math.max(0, Number(expireTime) || 0) - Date.now();
    if (diff <= 0) return '';
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}小时${minutes}分`;
}

function buildMysteryShopPush(shop: any, flags: MysteryShopPushFlags): { title: string; content: string } | null {
    if (!flags.arrival && !flags.purchase) return null;
    const npc = shop?.npc;
    const item = `${npc?.reward?.name || '神秘商品'} x${Number(npc?.reward?.count) || 0}`;
    const price = `${Number(npc?.price?.count || 0).toLocaleString()} ${npc?.price?.name || '货币'}`;
    const remain = remainingLabel(shop?.expireTime);
    const remainLine = remain ? `\n剩余 ${remain}` : '';

    if (flags.arrival && flags.purchase) {
        return {
            title: '神秘商人已自动购买',
            content: `到货 ${item}\n花费 ${price}${remainLine}`,
        };
    }
    if (flags.purchase) {
        return {
            title: '神秘商人已自动购买',
            content: `购买 ${item}\n花费 ${price}`,
        };
    }
    return {
        title: '神秘商人到货',
        content: `${item}\n价格 ${price}${remainLine}`,
    };
}

function skipBuyLog(decision: MysteryShopDecision, shop: any): string {
    const currencyName = shop?.npc?.price?.name || '该货币';
    if (decision.skipBuyReason === 'currency_not_allowed') {
        return `神秘商人自动购买已跳过：未允许使用${currencyName}`;
    }
    if (decision.skipBuyReason === 'insufficient') {
        return `神秘商人自动购买已跳过：${currencyName}余额不足`;
    }
    if (decision.skipBuyReason === 'balance_unknown') {
        return `神秘商人自动购买已跳过：未能读取${currencyName}余额`;
    }
    return '';
}

async function checkMysteryShopTick(options: {
    getAutomation?: () => any;
    getShop?: () => Promise<any>;
    buy?: (npcId: number) => Promise<any>;
    state?: MysteryShopAutoState;
} = {}): Promise<{ skipped?: boolean; reason?: string; bought?: boolean; push?: { title: string; content: string } | null }> {
    const automation = (options.getAutomation || getAutomation)() || {};
    const state = options.state || defaultState;
    if (!isMysteryShopWatchEnabled(automation)) {
        return { skipped: true, reason: 'disabled' };
    }

    const commerce = require('./commerce');
    const getShop = options.getShop || commerce.getMysteryShop;
    const buy = options.buy || ((npcId: number) => commerce.purchaseMysteryOffer(npcId));

    let shop: any;
    try {
        shop = await getShop();
    } catch (err: any) {
        logWarn('商城', `神秘商人检查失败: ${err.message}`, {
            module: 'shop', event: '神秘商人自动购买', result: 'error', error: err.message,
        });
        return { skipped: true, reason: 'error' };
    }

    const decision = decideMysteryShopTick(shop, automation, state);
    if (decision.skipReason === 'inactive' || decision.skipReason === 'disabled') {
        return { skipped: true, reason: decision.skipReason };
    }

    let bought = false;
    if (decision.shouldBuy) {
        try {
            await buy(shop.npc.id);
            bought = true;
            log('商城', `神秘商人自动购买成功：${shop.npc.reward.name} x${shop.npc.reward.count}，花费 ${shop.npc.price.count} ${shop.npc.price.name}`, {
                module: 'shop',
                event: '神秘商人自动购买',
                result: 'success',
                itemId: shop.npc.reward.id,
                count: shop.npc.reward.count,
                currencyId: shop.npc.price.id,
                price: shop.npc.price.count,
            });
        } catch (err: any) {
            logWarn('商城', `神秘商人自动购买失败: ${err.message}`, {
                module: 'shop', event: '神秘商人自动购买', result: 'error', error: err.message,
            });
        }
    } else {
        const message = skipBuyLog(decision, shop);
        if (message) {
            log('商城', message, {
                module: 'shop',
                event: '神秘商人自动购买',
                result: 'skip',
                reason: decision.skipBuyReason,
                currencyId: shop.npc.price?.id,
            });
        }
    }

    const flags = resolveMysteryShopPushFlags(decision, bought, automation, state);
    if (!flags.arrival && !flags.purchase) {
        return { bought };
    }
    commitMysteryShopNotify(state, String(decision.visitKey), flags);
    return { bought, push: buildMysteryShopPush(shop, flags) };
}

module.exports = {
    GOLD_ITEM_ID,
    COUPON_ITEM_ID,
    DIAMOND_ITEM_ID,
    GOLD_BEAN_ITEM_ID,
    MYSTERY_SHOP_AUTOMATION_KEYS,
    AUTO_BUY_CHECK_INTERVAL_MS,
    AUTO_BUY_INITIAL_DELAY_MS,
    AUTO_BUY_AFTER_SAVE_DELAY_MS,
    createMysteryShopAutoState,
    isMysteryShopWatchEnabled,
    mysteryShopConfigChanged,
    isCurrencyAllowed,
    canAffordOffer,
    mysteryShopVisitKey,
    decideMysteryShopTick,
    resolveMysteryShopPushFlags,
    commitMysteryShopNotify,
    buildMysteryShopPush,
    checkMysteryShopTick,
};
