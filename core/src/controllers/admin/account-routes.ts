import type { Application, Request, Response } from 'express';
import type { OfflineReminderChannel } from '../../types/config';
import type { AdminContext } from './context';
import { normalizePushChannel, readPushChannels, singlePushChannel } from '../../config/push-channels';
export {};

/**
 * Account CRUD routes, account-logs, logs, and settings routes.
 */

const store = require('../../models/store');
const { pushChannelError, sendPushChannels } = require('../../services/push');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef } = require('../../services/account-resolver');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig, getDevicePresets, getTimeZoneOptions } = require('../../config/config');

const {
    getAccId,
    getAccountIds,
    handleApiError,
    getAccountList,
    resolveAccId,
} = require('./middleware');

function mountAccountRoutes(app: Application, ctx: AdminContext): void {

    // API: 账号管理
    app.get('/api/accounts', (req: Request, res: Response) => {
        try {
            const data = ctx.provider.getAccounts();
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList(ctx);
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
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/accounts', async (req: Request, res: Response) => {
        try {
            const rawBody = (req.body && typeof req.body === 'object') ? req.body : {};
            const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : '';
            const body = typeof rawBody.name === 'string' ? { ...rawBody, name: requestedName } : rawBody;
            if (!requestedName) {
                return res.status(400).json({ ok: false, error: '账号备注不能为空' });
            }
            const visibleAccounts = getAccountList(ctx);
            const remarkMatchedAccount = !body.id && requestedName
                ? visibleAccounts.find((account: any) => String(account.name || '').trim() === requestedName)
                : null;
            const isRemarkRelogin = !!remarkMatchedAccount;
            const updateRef = body.id || (remarkMatchedAccount && remarkMatchedAccount.id) || '';
            const isUpdate = !!updateRef;

            const resolvedUpdateId = isUpdate ? resolveAccId(ctx, updateRef) : '';
            const payload = isUpdate ? { ...body, id: resolvedUpdateId || String(updateRef) } : body;
            let wasRunning = false;
            if (isUpdate && ctx.provider.isAccountRunning) {
                wasRunning = ctx.provider.isAccountRunning(payload.id);
            }

            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = ctx.provider.getAccounts();
                const oldAccount = oldAccounts.accounts.find((a: any) => a.id === payload.id);
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段
                    const payloadKeys = Object.keys(payload);
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
                ctx.provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isRemarkRelogin
                        ? `通过备注重新登录账号: ${accountName || accountId}`
                        : isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }
            // 如果是新增，自动启动
            if (!isUpdate) {
                const newAcc = data.accounts.at(-1);
                if (newAcc) await ctx.provider.startAccount(newAcc.id);
            } else if (isRemarkRelogin) {
                // Adding with an existing remark is a relogin operation, including for stopped accounts.
                await ctx.provider.restartAccount(payload.id);
            } else if (wasRunning && !onlyRemarkChanged) {
                // 如果是更新，且之前在运行，且不是仅修改备注，则重启
                await ctx.provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/accounts/:id', async (req: Request, res: Response) => {
        try {
            const resolvedId = resolveAccId(ctx, req.params.id) || String(req.params.id || '');

            const before = ctx.provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);
            await ctx.provider.stopAccount(resolvedId);
            const data = deleteAccount(resolvedId);
            if (ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req: Request, res: Response) => {
        try {
            const limit = Number.parseInt(req.query.limit as string) || 100;
            let list: any[] = ctx.provider.getAccountLogs ? ctx.provider.getAccountLogs(limit) : [];
            if (!Array.isArray(list)) list = [];

            // 与当前 web 前端保持一致：直接返回数组
            res.json(list);
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 日志
    app.get('/api/logs', (req: Request, res: Response) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(ctx, queryAccountIdRaw)) : getAccId(ctx, req);
        // 如果没有指定账号ID，获取所有账号的日志
        if (!id) {
            const accountIds = getAccountIds(ctx);
            const allLogs: any[] = [];
            const options = {
                limit: Number.parseInt(req.query.limit as string) || 100,
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
            allLogs.sort((a: any, b: any) => (b.time || 0) - (a.time || 0));
            const limitedLogs = allLogs.slice(0, options.limit);

            return res.json({ ok: true, data: limitedLogs });
        }

        // 指定了账号ID且通过权限检查，返回该账号的日志
        const options = {
            limit: Number.parseInt(req.query.limit as string) || 100,
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
    app.delete('/api/logs', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = ctx.provider.clearLogs(id);

            if (ctx.io && ctx.provider && typeof ctx.provider.getLogs === 'function') {
                const accountLogs = ctx.provider.getLogs(id, { limit: 100 });
                ctx.io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });

                const allLogs = ctx.provider.getLogs('', { limit: 100 });
                ctx.io.to('account:all').emit('logs:snapshot', {
                    accountId: 'all',
                    logs: Array.isArray(allLogs) ? allLogs : [],
                });
            }

            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置页统一保存（单次写入；运行中账号等待 worker revision ACK）
    app.post('/api/settings/save', async (req: Request, res: Response) => {
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
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置面板主题
    app.post('/api/settings/theme', async (req: Request, res: Response) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await ctx.provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    function channelListError(entries: unknown): string {
        if (!Array.isArray(entries)) return '推送渠道列表格式无效';
        const seen = new Set<string>();
        for (const raw of entries) {
            if (!raw || typeof raw !== 'object' || typeof raw.enabled !== 'boolean') return '推送渠道配置格式无效';
            const entry = normalizePushChannel(raw);
            if (seen.has(entry.channel)) return '推送渠道重复';
            seen.add(entry.channel);
            const error = pushChannelError(entry, entry.enabled);
            if (error) return error;
        }
        return '';
    }

    app.post('/api/settings/offline-reminder', (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            if (Object.hasOwn(body, 'notificationTypes')) {
                const types = body.notificationTypes;
                if (!types || typeof types !== 'object' || Array.isArray(types) || Object.values(types).some(value => typeof value !== 'boolean')) {
                    return res.status(400).json({ ok: false, error: '通知类型的开关值无效' });
                }
            }
            let error = '';
            if (Object.hasOwn(body, 'channels')) {
                error = channelListError(body.channels);
            } else if (Object.hasOwn(body, 'enabled')) {
                if (typeof body.enabled !== 'boolean' || !body.channel) {
                    error = '请指定要修改的渠道和启用状态';
                } else {
                    error = pushChannelError(singlePushChannel(store.getOfflineReminder(), body), body.enabled);
                }
            } else if (['channel', 'endpoint', 'token', 'secret'].some(key => Object.hasOwn(body, key))) {
                const saved = store.getOfflineReminder();
                const entry = singlePushChannel(saved, body);
                error = pushChannelError(entry, entry.channel !== saved.channel);
            }
            if (error) return res.status(400).json({ ok: false, error });
            res.json({ ok: true, data: store.setOfflineReminder(body) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 指定渠道时只测试该渠道，草稿参数不写入配置。
    app.post('/api/settings/offline-reminder/test', async (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const saved = store.getOfflineReminder();
            const single = ['channel', 'endpoint', 'token', 'secret'].some(key => Object.hasOwn(body, key));
            let targets: OfflineReminderChannel[];
            if (single) {
                const entry = singlePushChannel(saved, body);
                const error = pushChannelError(entry, true);
                if (error) return res.status(400).json({ ok: false, error });
                targets = [entry];
            } else {
                if (Object.hasOwn(body, 'channels')) {
                    const error = channelListError(body.channels);
                    if (error) return res.status(400).json({ ok: false, error });
                }
                targets = readPushChannels(body.channels ? body : saved).filter(entry => entry.enabled);
                if (!targets.length) return res.status(400).json({ ok: false, error: '请先配置并启用推送渠道' });
            }

            const title = String(body.title ?? saved.title ?? '').trim() || '账号下线提醒';
            const msg = String(body.msg ?? saved.msg ?? '').trim() || '账号下线';
            const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
            const results = await sendPushChannels(targets, { title: `${title}（测试）`, content: `${msg}\n\n这是一条通知测试消息。\n时间: ${ts}` });
            if (single) {
                const [result] = results;
                return result.ok
                    ? res.json({ ok: true, data: result, message: result.msg })
                    : res.status(400).json({ ok: false, error: result.msg, data: result });
            }
            const data = results.map(({ channel, ok, msg }) => ({ channel, ok, msg }));
            const sent = data.filter(result => result.ok).length;
            if (!sent) return res.status(400).json({ ok: false, error: data.map(r => `${r.channel}: ${r.msg}`).join('；'), data });
            return res.json({ ok: true, message: `测试完成，${sent}/${data.length} 个渠道成功`, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req: Request, res: Response) => {
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
            const bagSeedMultiLandReservationEnabled = id && (typeof store.getBagSeedMultiLandReservationEnabled === 'function') ? store.getBagSeedMultiLandReservationEnabled(id) : false;
            const bagSeedLandTypes = id && (typeof store.getBagSeedLandTypes === 'function') ? store.getBagSeedLandTypes(id) : {};
            const bagSeedFallbackStrategy = id && (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const autoAcceptFriendMinLevel = id && (typeof store.getAutoAcceptFriendMinLevel === 'function') ? store.getAutoAcceptFriendMinLevel(id) : 0;
            const autoAcceptRequireOwnLevel = id && (typeof store.getAutoAcceptRequireOwnLevel === 'function') ? store.getAutoAcceptRequireOwnLevel(id) : false;
            const autoAcceptHarvestStealEnabled = id && (typeof store.getAutoAcceptHarvestStealEnabled === 'function') ? store.getAutoAcceptHarvestStealEnabled(id) : true;
            const autoAcceptHarvestStealHarvest = id && (typeof store.getAutoAcceptHarvestStealHarvest === 'function') ? store.getAutoAcceptHarvestStealHarvest(id) : 8;
            const autoAcceptHarvestStealSteal = id && (typeof store.getAutoAcceptHarvestStealSteal === 'function') ? store.getAutoAcceptHarvestStealSteal(id) : 1;
            const ui = store.getUI();
            const offlineReminder = store.getOfflineReminder();
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, fertilizerBuyOrganicCount, fertilizerBuyOrganicThresholdHours, fertilizerBuyNormalCount, fertilizerBuyNormalThresholdHours, fertilizerBuyCheckIntervalMinutes, bagSeedPriority, bagSeedMultiLandReservationEnabled, bagSeedLandTypes, bagSeedFallbackStrategy, autoAcceptFriendMinLevel, autoAcceptRequireOwnLevel, autoAcceptHarvestStealEnabled, autoAcceptHarvestStealHarvest, autoAcceptHarvestStealSteal, ui, offlineReminder } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取默认配置
    app.get('/api/settings/default', (_req: Request, res: Response) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '无法获取默认配置' });
            }
            res.json({ ok: true, data: defaultConfig });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/device-presets', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: getDevicePresets() });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/system-config', (_req: Request, res: Response) => {
        try {
            res.json({
                ok: true,
                data: {
                    saved: store.getSystemConfig(),
                    default: getDefaultSystemConfig(),
                    current: getRuntimeConfig(),
                    timeZones: getTimeZoneOptions(),
                    loginSettings: store.getLoginSettings
                        ? store.getLoginSettings()
                        : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' },
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/login-config', (_req: Request, res: Response) => {
        try {
            const loginSettings = store.getLoginSettings
                ? store.getLoginSettings()
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/login-config', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const loginSettings = store.setLoginSettings
                ? store.setLoginSettings({
                    wechatQrLogin: body.wechatQrLogin,
                    qqQrLogin: body.qqQrLogin,
                    napCatEndpoint: body.napCatEndpoint,
                    napCatSignature: body.napCatSignature,
                })
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/system-config', (req: Request, res: Response) => {
        try {
            const { serverUrl, clientVersion, wxClientVersion, platform, os, timeZone, deviceInfo } = req.body || {};
            const saved = store.setSystemConfig({ serverUrl, clientVersion, wxClientVersion, platform, os, timeZone, deviceInfo });
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            // Keep live sessions intact. A new login must use a fresh one-time Code.
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/system-config/reset', (_req: Request, res: Response) => {
        try {
            const saved = getDefaultSystemConfig();
            store.setSystemConfig(saved);
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            // Keep live sessions intact. A new login must use a fresh one-time Code.
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
}

module.exports = { mountAccountRoutes };
