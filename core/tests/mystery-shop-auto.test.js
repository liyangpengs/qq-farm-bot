const assert = require('node:assert/strict');
const test = require('node:test');

const {
    GOLD_ITEM_ID,
    COUPON_ITEM_ID,
    DIAMOND_ITEM_ID,
    GOLD_BEAN_ITEM_ID,
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
    createMysteryShopAutoState,
} = require('../dist/services/mystery-shop-auto');

function automation(overrides = {}) {
    return {
        mystery_shop_auto_buy: false,
        mystery_shop_allow_gold: true,
        mystery_shop_allow_coupon: false,
        mystery_shop_allow_gold_bean: false,
        mystery_shop_allow_diamond: false,
        mystery_shop_arrival_notify: false,
        mystery_shop_purchase_notify: false,
        ...overrides,
    };
}

function shop(overrides = {}) {
    const npcOverrides = overrides.npc || {};
    const { price: priceOverrides, reward: rewardOverrides, ...npcRest } = npcOverrides;
    const { npc: _ignored, ...shopRest } = overrides;
    return {
        active: true,
        activeTime: 1_700_000_000_000,
        expireTime: Date.now() + (2 * 3600000) + (5 * 60000),
        npc: {
            id: 7,
            reward: { id: 20001, name: '艾草种子', count: 8, ...(rewardOverrides || {}) },
            price: {
                id: GOLD_ITEM_ID,
                name: '金币',
                count: 48000,
                balance: 100000,
                ...(priceOverrides || {}),
            },
            ...npcRest,
        },
        ...shopRest,
    };
}

const PRICE_TEXT = (48000).toLocaleString();

test('watch is enabled by auto-buy or arrival notify', () => {
    assert.equal(isMysteryShopWatchEnabled(automation()), false);
    assert.equal(isMysteryShopWatchEnabled(automation({ mystery_shop_auto_buy: true })), true);
    assert.equal(isMysteryShopWatchEnabled(automation({ mystery_shop_arrival_notify: true })), true);
    assert.equal(isMysteryShopWatchEnabled(automation({ mystery_shop_purchase_notify: true })), false);
});

test('currency allow list defaults to gold only', () => {
    const auto = automation();
    assert.equal(isCurrencyAllowed(GOLD_ITEM_ID, auto), true);
    assert.equal(isCurrencyAllowed(COUPON_ITEM_ID, auto), false);
    assert.equal(isCurrencyAllowed(GOLD_BEAN_ITEM_ID, auto), false);
    assert.equal(isCurrencyAllowed(DIAMOND_ITEM_ID, auto), false);
    assert.equal(isCurrencyAllowed(DIAMOND_ITEM_ID, automation({ mystery_shop_allow_diamond: true })), true);
});

test('unknown or insufficient balance cannot be spent', () => {
    assert.deepEqual(canAffordOffer({ count: 10, balance: null }), { ok: false, reason: 'balance_unknown' });
    assert.deepEqual(canAffordOffer({ count: 10, balance: undefined }), { ok: false, reason: 'balance_unknown' });
    assert.deepEqual(canAffordOffer({ count: 10, balance: 9 }), { ok: false, reason: 'insufficient' });
    assert.deepEqual(canAffordOffer({ count: 10, balance: 10 }), { ok: true });
});

test('inactive shop is skipped', () => {
    const decision = decideMysteryShopTick({ active: false, npc: null }, automation({ mystery_shop_auto_buy: true }));
    assert.equal(decision.skipReason, 'inactive');
    assert.equal(decision.shouldBuy, false);
    assert.equal(decision.notifyArrival, false);
});

test('auto-buy skips disallowed currency and unknown balance', () => {
    const auto = automation({ mystery_shop_auto_buy: true, mystery_shop_arrival_notify: true });
    const coupon = decideMysteryShopTick(shop({ npc: { price: { id: COUPON_ITEM_ID, name: '点券', count: 25, balance: 100 } } }), auto);
    assert.equal(coupon.shouldBuy, false);
    assert.equal(coupon.skipBuyReason, 'currency_not_allowed');
    assert.equal(coupon.notifyArrival, true);

    const unknown = decideMysteryShopTick(shop({ npc: { price: { balance: null } } }), auto);
    assert.equal(unknown.shouldBuy, false);
    assert.equal(unknown.skipBuyReason, 'balance_unknown');
});

test('auto-buy proceeds when currency is allowed and balance is enough', () => {
    const decision = decideMysteryShopTick(
        shop(),
        automation({ mystery_shop_auto_buy: true }),
    );
    assert.equal(decision.shouldBuy, true);
    assert.equal(decision.visitKey, mysteryShopVisitKey(shop()));
});

test('arrival notify is once per visit and purchase can merge on the same tick', () => {
    const auto = automation({
        mystery_shop_auto_buy: true,
        mystery_shop_arrival_notify: true,
        mystery_shop_purchase_notify: true,
    });
    const state = createMysteryShopAutoState();
    const offer = shop();
    const first = decideMysteryShopTick(offer, auto, state);
    const flags = resolveMysteryShopPushFlags(first, true, auto, state);
    assert.deepEqual(flags, { arrival: true, purchase: true });
    const merged = buildMysteryShopPush(offer, flags);
    assert.equal(merged.title, '神秘商人已自动购买');
    assert.match(merged.content, /到货 艾草种子 x8/);
    assert.match(merged.content, new RegExp(`花费 ${PRICE_TEXT} 金币`));

    commitMysteryShopNotify(state, first.visitKey, flags);
    const second = decideMysteryShopTick(offer, auto, state);
    assert.equal(second.notifyArrival, false);
    const later = resolveMysteryShopPushFlags(second, true, auto, state);
    assert.deepEqual(later, { arrival: false, purchase: false });
});

test('purchase-only and arrival-only messages stay separate', () => {
    const offer = shop();
    const purchase = buildMysteryShopPush(offer, { arrival: false, purchase: true });
    assert.equal(purchase.title, '神秘商人已自动购买');
    assert.match(purchase.content, /购买 艾草种子 x8/);

    const arrival = buildMysteryShopPush(offer, { arrival: true, purchase: false });
    assert.equal(arrival.title, '神秘商人到货');
    assert.match(arrival.content, /艾草种子 x8/);
    assert.match(arrival.content, new RegExp(`价格 ${PRICE_TEXT} 金币`));
});

test('config change detection covers mystery shop keys', () => {
    assert.equal(
        mysteryShopConfigChanged(automation(), automation({ mystery_shop_auto_buy: true })),
        true,
    );
    assert.equal(mysteryShopConfigChanged(automation(), automation()), false);
});

test('checkMysteryShopTick buys once and returns a merged push', async () => {
    const state = createMysteryShopAutoState();
    const offer = shop();
    const auto = automation({
        mystery_shop_auto_buy: true,
        mystery_shop_arrival_notify: true,
        mystery_shop_purchase_notify: true,
    });
    let bought = 0;
    const first = await checkMysteryShopTick({
        getAutomation: () => auto,
        getShop: async () => offer,
        buy: async () => {
            bought += 1;
            return { ok: true };
        },
        state,
    });
    assert.equal(bought, 1);
    assert.equal(first.bought, true);
    assert.equal(first.push.title, '神秘商人已自动购买');

    const second = await checkMysteryShopTick({
        getAutomation: () => auto,
        getShop: async () => offer,
        buy: async () => {
            bought += 1;
            return { ok: true };
        },
        state,
    });
    assert.equal(bought, 2);
    assert.equal(second.bought, true);
    assert.equal(second.push, undefined);
});
