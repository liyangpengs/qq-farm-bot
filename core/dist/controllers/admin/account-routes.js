"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Account CRUD routes, account-logs, logs, and settings routes.
 */
const store = require('../../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef } = require('../../services/account-resolver');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig, getDevicePresets, getTimeZoneOptions } = require('../../config/config');
const { getAccId, getAccountIds, handleApiError, getAccountList, requireAccountOwner, resolveAccId, } = require('./middleware');
function mountAccountRoutes(app, ctx) {
    // API: 账号管理
    app.get('/api/accounts', (req, res) => {
        try {
            const data = ctx.provider.getAccounts(req.adminUser);
            res.json({ ok: true, data });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList(ctx, req.adminUser);
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }
            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (ctx.provider && typeof ctx.provider.setRuntimeAccountName === 'function') {
                ctx.provider.setRuntimeAccountName(accountId, remark);
            }
            if (ctx.provider && ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    app.post('/api/accounts', (req, res) => {
        try {
            const rawBody = (req.body && typeof req.body === 'object') ? req.body : {};
            const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : '';
            const body = typeof rawBody.name === 'string' ? { ...rawBody, name: requestedName } : rawBody;
            // 备注允许留空（扫码登录场景），新增账号由存储层默认命名为 账号{id}
            const username = String(req.adminUser || '');
            const visibleAccounts = getAccountList(ctx, username);
            const remarkMatchedAccount = !body.id && requestedName
                ? visibleAccounts.find((account) => String(account.name || '').trim() === requestedName)
                : null;
            const isRemarkRelogin = !!remarkMatchedAccount;
            const updateRef = body.id || (remarkMatchedAccount && remarkMatchedAccount.id) || '';
            const isUpdate = !!updateRef;
            // 更新已有账号时必须属于当前管理员
            if (isUpdate) {
                const owned = requireAccountOwner(ctx, req, updateRef);
                if (owned.denied) {
                    return res.status(403).json({ ok: false, error: '无权操作该账号' });
                }
            }
            const resolvedUpdateId = isUpdate ? resolveAccId(ctx, updateRef) : '';
            const payload = isUpdate
                ? { ...body, id: resolvedUpdateId || String(updateRef), owner: username }
                : { ...body, owner: username };
            // 扫码换取的一次性 code 关联的 loginBuffer：挂到账号上用于后续自动续码
            if (payload.code && !payload.loginBuffer) {
                try {
                    const { takeLoginBufferByCode } = require('../../services/wx-login/service');
                    const loginBuffer = takeLoginBufferByCode(String(payload.code));
                    if (loginBuffer)
                        payload.loginBuffer = loginBuffer;
                }
                catch {
                    // 忽略：未配置 wx-login 服务时不影响添加账号
                }
            }
            let wasRunning = false;
            if (isUpdate && ctx.provider.isAccountRunning) {
                wasRunning = ctx.provider.isAccountRunning(payload.id);
            }
            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = ctx.provider.getAccounts(username);
                const oldAccount = oldAccounts.accounts.find((a) => a.id === payload.id);
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段（owner 为内部字段，不计入）
                    const payloadKeys = Object.keys(payload).filter((key) => key !== 'owner');
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }
            const data = addOrUpdateAccount(payload);
            if (ctx.provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts.at(-1) || {}).id || '');
                const accountName = payload.name || '';
                ctx.provider.addAccountLog(isUpdate ? 'update' : 'add', isRemarkRelogin
                    ? `通过备注重新登录账号: ${accountName || accountId}`
                    : isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`, accountId, accountName);
            }
            // 如果是新增，自动启动
            if (!isUpdate) {
                const newAcc = data.accounts.at(-1);
                if (newAcc)
                    ctx.provider.startAccount(newAcc.id);
            }
            else if (isRemarkRelogin) {
                // Adding with an existing remark is a relogin operation, including for stopped accounts.
                ctx.provider.restartAccount(payload.id);
            }
            else if (wasRunning && !onlyRemarkChanged) {
                // 如果是更新，且之前在运行，且不是仅修改备注，则重启
                ctx.provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        }
        catch (e) {
            if (e?.code === 'MAX_ACCOUNTS_REACHED') {
                return res.status(400).json({ ok: false, error: e.message, code: 'MAX_ACCOUNTS_REACHED' });
            }
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    app.delete('/api/accounts/:id', (req, res) => {
        try {
            const owned = requireAccountOwner(ctx, req, req.params.id);
            if (owned.denied) {
                return res.status(403).json({ ok: false, error: '无权操作该账号' });
            }
            const resolvedId = owned.id || String(req.params.id || '');
            const before = ctx.provider.getAccounts(req.adminUser);
            const target = findAccountByRef(before.accounts || [], req.params.id);
            ctx.provider.stopAccount(resolvedId);
            const data = deleteAccount(resolvedId);
            if (ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 账号日志
    app.get('/api/account-logs', (req, res) => {
        try {
            const limit = Number.parseInt(req.query.limit) || 100;
            let list = ctx.provider.getAccountLogs ? ctx.provider.getAccountLogs(limit) : [];
            if (!Array.isArray(list))
                list = [];
            // 只返回当前管理员名下账号的日志
            const username = String(req.adminUser || '');
            const ownedIds = new Set(getAccountIds(ctx, username));
            list = list.filter((entry) => {
                const accId = String((entry && entry.accountId) || '');
                return !accId || ownedIds.has(accId);
            });
            // 与当前 web 前端保持一致：直接返回数组
            res.json(list);
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 日志
    app.get('/api/logs', (req, res) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const username = String(req.adminUser || '');
        let id = '';
        if (queryAccountIdRaw) {
            if (queryAccountIdRaw === 'all') {
                id = '';
            }
            else {
                const owned = requireAccountOwner(ctx, req, queryAccountIdRaw);
                if (owned.denied) {
                    return res.status(403).json({ ok: false, error: '无权查看该账号' });
                }
                id = owned.id || '';
            }
        }
        else {
            id = getAccId(ctx, req);
        }
        // 如果没有指定账号ID，获取当前管理员名下所有账号的日志
        if (!id) {
            const accountIds = getAccountIds(ctx, username);
            const allLogs = [];
            const options = {
                limit: Number.parseInt(req.query.limit) || 100,
                tag: req.query.tag || '',
                module: req.query.module || '',
                event: req.query.event || '',
                keyword: req.query.keyword || '',
                isWarn: req.query.isWarn,
                timeFrom: req.query.timeFrom || '',
                timeTo: req.query.timeTo || '',
            };
            for (const accId of accountIds) {
                const logs = ctx.provider.getLogs(accId, options);
                if (Array.isArray(logs)) {
                    allLogs.push(...logs);
                }
            }
            // 按时间排序并限制数量
            allLogs.sort((a, b) => (b.time || 0) - (a.time || 0));
            const limitedLogs = allLogs.slice(0, options.limit);
            return res.json({ ok: true, data: limitedLogs });
        }
        // 指定了账号ID且通过权限检查，返回该账号的日志
        const options = {
            limit: Number.parseInt(req.query.limit) || 100,
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        const list = ctx.provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });
    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req, res) => {
        const username = String(req.adminUser || '');
        const rawRef = String(req.headers['x-account-id'] || '').trim();
        if (!rawRef)
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            // accountId=all 只清空当前管理员名下账号的日志
            if (rawRef === 'all') {
                const ownedIds = getAccountIds(ctx, username);
                for (const accId of ownedIds) {
                    ctx.provider.clearLogs(accId);
                }
                if (ctx.io && ctx.provider && typeof ctx.provider.getLogs === 'function') {
                    const allLogs = [];
                    for (const accId of ownedIds) {
                        const logs = ctx.provider.getLogs(accId, { limit: 100 });
                        if (Array.isArray(logs))
                            allLogs.push(...logs);
                    }
                    ctx.io.to(`account:all:${username}`).emit('logs:snapshot', {
                        accountId: 'all',
                        logs: allLogs,
                    });
                }
                return res.json({ ok: true, data: { cleared: 'all' } });
            }
            const owned = requireAccountOwner(ctx, req, rawRef);
            if (owned.denied) {
                return res.status(403).json({ ok: false, error: '无权操作该账号' });
            }
            const id = owned.id || '';
            if (!id)
                return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            const data = ctx.provider.clearLogs(id);
            if (ctx.io && ctx.provider && typeof ctx.provider.getLogs === 'function') {
                const accountLogs = ctx.provider.getLogs(id, { limit: 100 });
                ctx.io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });
                const ownedAll = [];
                for (const accId of getAccountIds(ctx, username)) {
                    const logs = ctx.provider.getLogs(accId, { limit: 100 });
                    if (Array.isArray(logs))
                        ownedAll.push(...logs);
                }
                ctx.io.to(`account:all:${username}`).emit('logs:snapshot', {
                    accountId: 'all',
                    logs: ownedAll,
                });
            }
            res.json({ ok: true, data });
        }
        catch (e) {
            handleApiError(res, e);
        }
    });
    // API: 设置页统一保存（单次写入；运行中账号等待 worker revision ACK）
    app.post('/api/settings/save', async (req, res) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        try {
            const data = await ctx.provider.saveSettings(id, req.body || {});
            const unconfirmed = data && data.status === 'unconfirmed';
            res.status(unconfirmed ? 202 : 200).json({
                ok: !unconfirmed,
                saved: !!(data && data.saved),
                stopped: !!(data && data.status === 'stopped'),
                confirmed: !!(data && data.confirmed),
                unconfirmed: !!unconfirmed,
                status: data?.status,
                code: unconfirmed ? data.confirmationError?.code : undefined,
                error: unconfirmed ? (data.confirmationError?.message || '配置已保存，但 worker 尚未确认应用') : undefined,
                data: data || {},
            });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 设置面板主题
    app.post('/api/settings/theme', async (req, res) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await ctx.provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 保存下线提醒配置
    app.post('/api/settings/offline-reminder', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const channel = String(body.channel || '').trim().toLowerCase();
            if (channel === 'dingtalk') {
                try {
                    const { buildDingTalkWebhook } = require('../../services/push');
                    buildDingTalkWebhook(body.endpoint, body.token, body.secret);
                }
                catch (error) {
                    return res.status(400).json({ ok: false, error: error?.message || '钉钉 Webhook 地址格式无效' });
                }
            }
            const data = store.setOfflineReminder ? store.setOfflineReminder(body) : {};
            res.json({ ok: true, data: data || {} });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 测试下线提醒推送（不落盘）
    app.post('/api/settings/offline-reminder/test', async (req, res) => {
        try {
            const saved = store.getOfflineReminder ? store.getOfflineReminder() : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };
            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const secret = String(cfg.secret || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();
            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }
            if (channel === 'webhook' && !endpoint) {
                return res.status(400).json({ ok: false, error: 'Webhook 渠道需要填写接口地址' });
            }
            if (channel === 'dingtalk' && !endpoint && !token) {
                return res.status(400).json({ ok: false, error: '钉钉渠道需要填写 Webhook 地址' });
            }
            if (channel !== 'webhook' && channel !== 'dingtalk' && !token) {
                return res.status(400).json({ ok: false, error: '当前推送渠道需要填写 Token' });
            }
            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const { sendPushooMessage } = require('../../services/push');
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                secret,
                title: `${titleBase}（测试）`,
                content: `${msgBase}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`,
            });
            if (!ret) {
                return res.status(400).json({ ok: false, error: '推送失败：无返回结果' });
            }
            const isSuccess = ret.ok ||
                ret.code === 'ok' ||
                ret.code === '0' ||
                String(ret.msg || '').includes('成功') ||
                String(ret.raw?.status || '').toLowerCase() === 'success';
            if (!isSuccess && ret.msg && !String(ret.msg).includes('成功')) {
                return res.status(400).json({ ok: false, error: ret.msg || '推送失败', data: ret });
            }
            return res.json({ ok: true, data: ret, message: ret.msg || '推送成功' });
        }
        catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 获取配置
    app.get('/api/settings', async (req, res) => {
        try {
            const id = getAccId(ctx, req);
            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = id ? store.getIntervals(id) : {};
            const strategy = id ? store.getPlantingStrategy(id) : null;
            const preferredSeed = id ? store.getPreferredSeed(id) : null;
            const friendQuietHours = id ? store.getFriendQuietHours(id) : null;
            const automation = id ? store.getAutomation(id) : {};
            const stealDelaySeconds = id && (typeof store.getStealDelaySeconds === 'function') ? store.getStealDelaySeconds(id) : 0;
            const plantOrderRandom = id && (typeof store.getPlantOrderRandom === 'function') ? store.getPlantOrderRandom(id) : false;
            const plantDelaySeconds = id && (typeof store.getPlantDelaySeconds === 'function') ? store.getPlantDelaySeconds(id) : 0;
            const fertilizerBuyOrganicCount = id && (typeof store.getFertilizerBuyOrganicCount === 'function') ? store.getFertilizerBuyOrganicCount(id) : 0;
            const fertilizerBuyOrganicThresholdHours = id && (typeof store.getFertilizerBuyOrganicThresholdHours === 'function') ? store.getFertilizerBuyOrganicThresholdHours(id) : 10;
            const fertilizerBuyNormalCount = id && (typeof store.getFertilizerBuyNormalCount === 'function') ? store.getFertilizerBuyNormalCount(id) : 0;
            const fertilizerBuyNormalThresholdHours = id && (typeof store.getFertilizerBuyNormalThresholdHours === 'function') ? store.getFertilizerBuyNormalThresholdHours(id) : 10;
            const fertilizerBuyCheckIntervalMinutes = id && (typeof store.getFertilizerBuyCheckIntervalMinutes === 'function') ? store.getFertilizerBuyCheckIntervalMinutes(id) : 30;
            const bagSeedPriority = id && (typeof store.getBagSeedPriority === 'function') ? store.getBagSeedPriority(id) : [];
            const bagSeedLandTypes = id && (typeof store.getBagSeedLandTypes === 'function') ? store.getBagSeedLandTypes(id) : {};
            const bagSeedFallbackStrategy = id && (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const autoAcceptFriendMinLevel = id && (typeof store.getAutoAcceptFriendMinLevel === 'function') ? store.getAutoAcceptFriendMinLevel(id) : 0;
            const autoAcceptRequireOwnLevel = id && (typeof store.getAutoAcceptRequireOwnLevel === 'function') ? store.getAutoAcceptRequireOwnLevel(id) : false;
            const autoAcceptHarvestStealEnabled = id && (typeof store.getAutoAcceptHarvestStealEnabled === 'function') ? store.getAutoAcceptHarvestStealEnabled(id) : true;
            const autoAcceptHarvestStealHarvest = id && (typeof store.getAutoAcceptHarvestStealHarvest === 'function') ? store.getAutoAcceptHarvestStealHarvest(id) : 8;
            const autoAcceptHarvestStealSteal = id && (typeof store.getAutoAcceptHarvestStealSteal === 'function') ? store.getAutoAcceptHarvestStealSteal(id) : 1;
            const ui = store.getUI();
            const offlineReminder = store.getOfflineReminder
                ? store.getOfflineReminder()
                : { channel: 'webhook', endpoint: '', token: '', secret: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 0 };
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, fertilizerBuyOrganicCount, fertilizerBuyOrganicThresholdHours, fertilizerBuyNormalCount, fertilizerBuyNormalThresholdHours, fertilizerBuyCheckIntervalMinutes, bagSeedPriority, bagSeedLandTypes, bagSeedFallbackStrategy, autoAcceptFriendMinLevel, autoAcceptRequireOwnLevel, autoAcceptHarvestStealEnabled, autoAcceptHarvestStealHarvest, autoAcceptHarvestStealSteal, ui, offlineReminder } });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 获取默认配置
    app.get('/api/settings/default', (_req, res) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '无法获取默认配置' });
            }
            res.json({ ok: true, data: defaultConfig });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    app.get('/api/settings/device-presets', (_req, res) => {
        try {
            res.json({ ok: true, data: getDevicePresets() });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    app.get('/api/settings/system-config', (_req, res) => {
        try {
            res.json({
                ok: true,
                data: {
                    saved: store.getSystemConfig(),
                    default: getDefaultSystemConfig(),
                    current: getRuntimeConfig(),
                    timeZones: getTimeZoneOptions(),
                },
            });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    app.post('/api/settings/system-config', (req, res) => {
        try {
            const { serverUrl, clientVersion, platform, os, timeZone, deviceInfo } = req.body || {};
            const previous = getRuntimeConfig();
            const saved = store.setSystemConfig({ serverUrl, clientVersion, platform, os, timeZone, deviceInfo });
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            const transportChanged = previous.serverUrl !== saved.serverUrl
                || previous.clientVersion !== saved.clientVersion
                || previous.platform !== saved.platform
                || previous.os !== saved.os;
            if (transportChanged && ctx.provider && typeof ctx.provider.getAccounts === 'function'
                && typeof ctx.provider.isAccountRunning === 'function'
                && typeof ctx.provider.restartAccount === 'function') {
                const accounts = ctx.provider.getAccounts()?.accounts || [];
                for (const account of accounts) {
                    if (account?.id && ctx.provider.isAccountRunning(account.id)) {
                        ctx.provider.restartAccount(account.id);
                    }
                }
            }
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    app.post('/api/settings/system-config/reset', (_req, res) => {
        try {
            const previous = getRuntimeConfig();
            const saved = getDefaultSystemConfig();
            store.setSystemConfig(saved);
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            const transportChanged = previous.serverUrl !== saved.serverUrl
                || previous.clientVersion !== saved.clientVersion
                || previous.platform !== saved.platform
                || previous.os !== saved.os;
            if (transportChanged && ctx.provider && typeof ctx.provider.getAccounts === 'function'
                && typeof ctx.provider.isAccountRunning === 'function'
                && typeof ctx.provider.restartAccount === 'function') {
                const accounts = ctx.provider.getAccounts()?.accounts || [];
                for (const account of accounts) {
                    if (account?.id && ctx.provider.isAccountRunning(account.id)) {
                        ctx.provider.restartAccount(account.id);
                    }
                }
            }
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
}
module.exports = { mountAccountRoutes };
//# sourceMappingURL=account-routes.js.map