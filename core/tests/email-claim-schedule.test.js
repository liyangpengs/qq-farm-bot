const assert = require('node:assert/strict');
const test = require('node:test');

const {
    configureEmailClaim,
    getEmailClaimHour,
    isEmailClaimTimeReached,
    resetEmailClaimStateForTest,
} = require('../dist/services/email');
const { normalizeAccountConfig, DEFAULT_ACCOUNT_CONFIG } = require('../dist/models/store/shared-state');

test('邮箱领取默认 10 点，并允许用户设置为 0 点', () => {
    resetEmailClaimStateForTest();
    assert.equal(getEmailClaimHour(), 10);

    configureEmailClaim({ hour: 0 });
    assert.equal(getEmailClaimHour(), 0);

    configureEmailClaim({ hour: 23 });
    assert.equal(getEmailClaimHour(), 23);

    configureEmailClaim({ hour: 24 });
    assert.equal(getEmailClaimHour(), 23, '非法值保持当前有效值');

    configureEmailClaim({ hour: -1 });
    assert.equal(getEmailClaimHour(), 23, '负数不会被悄悄改成午夜');

    configureEmailClaim({ hour: 'abc' });
    assert.equal(getEmailClaimHour(), 23, '非法值保持当前有效值');
    for (const invalid of [1.5, '10.5', '10abc', '1e1', '', null, true, [], {}, Infinity, Number.NaN]) {
        configureEmailClaim({ hour: invalid });
        assert.equal(getEmailClaimHour(), 23, '无效配置不改变执行时刻');
    }
    resetEmailClaimStateForTest();
});

test('邮箱只在配置的整点到达后进入检查窗口', () => {
    const at = (iso) => Date.parse(iso);
    assert.equal(isEmailClaimTimeReached(10, at('2026-08-26T09:59:59+08:00')), false);
    assert.equal(isEmailClaimTimeReached(10, at('2026-08-26T10:00:00+08:00')), true);
    assert.equal(isEmailClaimTimeReached(10, at('2026-08-26T23:59:59+08:00')), true);

    assert.equal(isEmailClaimTimeReached(0, at('2026-08-25T23:59:59+08:00')), true, '0 点窗口在当天任意时刻都已经打开');
    assert.equal(isEmailClaimTimeReached(0, at('2026-08-26T00:00:00+08:00')), true);
});

test('邮箱小时会写入账号配置，并兼容旧配置默认 10 点', () => {
    assert.equal(normalizeAccountConfig({ emailClaimHour: 0 }, DEFAULT_ACCOUNT_CONFIG).emailClaimHour, 0);
    assert.equal(normalizeAccountConfig({ emailClaimHour: 10 }, DEFAULT_ACCOUNT_CONFIG).emailClaimHour, 10);
    assert.equal(normalizeAccountConfig({ emailClaimHour: 25 }, DEFAULT_ACCOUNT_CONFIG).emailClaimHour, 10);
    assert.equal(normalizeAccountConfig({}, DEFAULT_ACCOUNT_CONFIG).emailClaimHour, 10);
});

test('邮箱时间保存拒绝非法输入，且不影响同次提交中的其他配置', () => {
    const shared = require('../dist/models/store/shared-state');
    const accountConfig = require('../dist/models/store/account-config');
    const previousFallback = shared.accountFallbackConfig;
    const previousDefault = shared.globalConfig.defaultAccountConfig;
    try {
        const baseline = shared.cloneAccountConfig(previousFallback);
        for (const invalid of [-1, 24, 10.5, '10.5', '10abc', '1e1', '', ' ', null, undefined, true, [], {}, Infinity, Number.NaN]) {
            const payload = { emailClaimHour: invalid, automation: { sell: !baseline.automation.sell } };
            assert.throws(() => accountConfig.applyConfigSnapshot(payload, { persist: false, accountId: '' }), error => error.code === 'INVALID_CONFIG');
            assert.throws(() => accountConfig.setAccountConfigSnapshot('', payload, false), error => error.code === 'INVALID_CONFIG');
            assert.deepEqual(shared.accountFallbackConfig, baseline);
            assert.equal(normalizeAccountConfig({ emailClaimHour: invalid }, DEFAULT_ACCOUNT_CONFIG).emailClaimHour, 10);
        }
        for (const hour of [0, 10, 23, '0', '23']) {
            const saved = accountConfig.applyConfigSnapshot({ emailClaimHour: hour }, { persist: false, accountId: '' });
            assert.equal(saved.emailClaimHour, Number(hour));
        }
    } finally {
        shared.accountFallbackConfig = previousFallback;
        shared.globalConfig.defaultAccountConfig = previousDefault;
    }
});
