import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { getAccId } = require('./middleware');

const ACTIVITY_ERROR_MESSAGES: Record<string, string> = {
    '1034014': '今日青梅种子已经领取，无需重复领取',
    '1034091': '当前爱心不足，无法捐赠',
    '1034092': '今天还没有收获小红花，暂时无法领取公益礼包',
    '1034038': '当前没有可点亮或可领取的星宿奖励，可能已经领取过，请稍后或明天再来看看',
    '1034001': '当前活动暂不可操作，请稍后再试',
    '1034002': '活动尚未开放或已经结束',
    INVALID_EXCHANGE_COUNT: '兑换数量必须是正十进制整数',
    INVALID_SHOP_GOODS_ID: '商品信息无效，请刷新商店后重试',
    SHOP_GOODS_NOT_FOUND: '该商品已不在当前商店目录中，请刷新后重试',
    SHOP_GOODS_UNAVAILABLE: '该商品当前不可兑换，请刷新商店后重试',
    SHOP_BALANCE_UNAVAILABLE: '暂时无法确认星砂余额，请稍后重试',
    INSUFFICIENT_STAR_SAND: '星砂余额不足，无法完成本次兑换',
    SHOP_RESPONSE_INVALID: '商店数据已经变化，请刷新页面后重试',
    SHOP_UNAVAILABLE: '星砂商店暂未开放，请稍后再来看看',
    QIXI_UNAVAILABLE: '鹊桥寄情活动暂未开放或已经结束',
    QIXI_BRIDGE_UNAVAILABLE: '当前没有可领取的鹊桥奖励',
    QIXI_GIFT_UNAVAILABLE: '当前无法赠送鹊羽香囊',
    INSUFFICIENT_QIXI_SACHET: '鹊羽香囊数量不足',
    INVALID_QIXI_FRIEND_GID: '好友 GID 必须是正十进制整数',
    INVALID_QIXI_MESSAGE_TEXT_ID: '祝福文案信息无效，请刷新活动后重试',
    QIXI_RESPONSE_INVALID: '鹊桥活动数据已经变化，请刷新页面后重试',
    QIXI_GIFT_FAILED: '鹊羽香囊赠送失败，请刷新后重试',
    CHARITY_RED_FLOWER_UNAVAILABLE: '公益小红花活动暂未开放或已经结束',
    CHARITY_RED_FLOWER_RESPONSE_INVALID: '公益小红花活动数据已经变化，请刷新页面后重试',
    CHARITY_SEEDS_UNAVAILABLE: '当前没有可领取的小红花种子',
    INSUFFICIENT_CHARITY_LOVE: '当前没有可捐赠的爱心',
    CHARITY_DAILY_GIFT_UNAVAILABLE: '今日公益礼包已经领取或暂不可领取',
    INVALID_WEATHER_BOTTLE_COUNT: '天气瓶购买数量必须是正十进制整数',
    INVALID_WEATHER_NODE: '研究节点信息无效，请刷新活动后重试',
    INVALID_WEATHER_TARGET_GID: '好友 GID 必须是正十进制整数',
    WEATHER_BOTTLE_UNAVAILABLE: '背包中没有可用的雷雨召唤瓶',
    WEATHER_COLLECTION_BOTTLE_UNAVAILABLE: '背包中没有可用的天气采集瓶',
    INSUFFICIENT_WEATHER_BADGE: '雷电徽章不足，无法推进研究',
    WEATHER_STATE_UNAVAILABLE: '当前已有特殊天气，暂时无法召唤降雨',
    WEATHER_RESPONSE_INVALID: '天气活动数据已经变化，请刷新页面后重试',
    WEATHER_UNAVAILABLE: '雨落成诗活动暂未开放或已经结束',
    WEATHER_ACTIVITY_UNAVAILABLE: '雨落成诗活动尚未开放或已经结束',
    WEATHER_SHOP_UNAVAILABLE: '天气采集瓶商店当前不可用',
    WEATHER_SHOP_ALREADY_EXCHANGED: '今日已经兑换过天气采集瓶',
    WEATHER_SCAN_BATCH_TOO_LARGE: '单次最多检查 5 位好友，请分批发起',
    INVALID_WEATHER_FRIEND_GID: '好友信息无效，请刷新活动后重新选择',
    WEATHER_COLLECTOR_UNAVAILABLE: '背包中没有可用的天气采集瓶',
    WEATHER_FRIEND_NOT_THUNDERSTORM: '该好友农场当前不是雷雨天气',
    WEATHER_ALREADY_COLLECTED: '当前这轮雷雨已经采过，下轮雷雨可再次采集',
    WEATHER_SUMMON_UNAVAILABLE: '背包中没有可用的雷雨召唤瓶',
    WEATHER_ALREADY_ACTIVE: '自己的农场当前已有特殊天气',
    WEATHER_FROG_UNAVAILABLE: '背包中没有可用的青蛙使坏瓶',
    WEATHER_CLOUD_UNAVAILABLE: '背包中没有可用的乌云使坏瓶',
    INVALID_WEATHER_LAND_ID: '地块信息无效，请刷新好友天气后重试',
    WEATHER_CLOUD_TARGET_UNAVAILABLE: '好友当前没有可使用乌云使坏瓶的作物',
    WEATHER_ACCOUNT_UNAVAILABLE: '当前账号尚未就绪，请稍后重试',
    INVALID_WEATHER_RESEARCH_NODE: '气象研究节点信息无效，请刷新后重试',
    WEATHER_RESEARCH_UNAVAILABLE: '气象研究数据暂不可用，请刷新后重试',
    WEATHER_RESEARCH_ALREADY_COMPLETED: '该气象研究节点已经完成',
    WEATHER_RESEARCH_LOCKED: '请先完成前置气象研究节点',
    INSUFFICIENT_LIGHTNING_BADGES: '雷电徽章不足',
    '1034007': '活动天气瓶已达到限购次数',
    '1033014': '当前已有特殊天气，暂时无法召唤降雨',
    '1000019': '雷电徽章不足，无法推进研究',
    '1034018': '天气采集瓶不足，无法采集',
    '1034040': '当前这轮雷雨已经采过，下轮雷雨可再次采集',
};

function activityErrorResponse(error: any): { code: string; message: string } {
    const rawMessage = String(error?.message || error || '活动操作失败');
    const protocolCode = String(error?.code || rawMessage.match(/\bcode=(\d+)\b/)?.[1] || '');
    const friendlyMessage = ACTIVITY_ERROR_MESSAGES[protocolCode];
    if (friendlyMessage) return { code: protocolCode, message: friendlyMessage };

    if (rawMessage.includes('当前没有可领取的游记奖励')) {
        return { code: 'NO_PASS_REWARD', message: '当前没有可领取的游记奖励，请完成新的游记等级后再试' };
    }
    if (rawMessage.includes('指定节令当前不可领取')) {
        return { code: 'SOLAR_TERM_UNAVAILABLE', message: '当前节令奖励暂不可领取，请在开放后再试' };
    }
    if (rawMessage.includes('服务端未发现星座活动')) {
        return { code: 'CONSTELLATION_UNAVAILABLE', message: '观星礼录活动暂未开放或已经结束' };
    }
    if (rawMessage.includes('服务端未发现可用游记')) {
        return { code: 'PASS_UNAVAILABLE', message: '千星游记活动暂未开放或已经结束' };
    }
    if (rawMessage.includes('服务端未发现指定节令')) {
        return { code: 'SOLAR_TERM_NOT_FOUND', message: '未找到该节令活动，请刷新页面后再试' };
    }
    if (rawMessage.includes('当前赛季未发现活动商店')) {
        return { code: 'SHOP_UNAVAILABLE', message: '星砂商店暂未开放，请稍后再来看看' };
    }
    if (rawMessage.includes('当前赛季数据为空')) {
        return { code: 'SEASON_UNAVAILABLE', message: '当前活动数据暂未开放，请稍后刷新重试' };
    }
    if (rawMessage.includes('termId 必须')) {
        return { code: 'INVALID_SOLAR_TERM', message: '节令信息已失效，请刷新页面后重试' };
    }
    if (rawMessage === '账号未运行' || rawMessage === '账号已离线') {
        return { code: 'ACCOUNT_OFFLINE', message: '当前账号尚未运行，请先启动账号后再试' };
    }
    if (rawMessage === 'API Timeout' || rawMessage.includes('请求超时')) {
        return { code: 'ACTIVITY_TIMEOUT', message: '活动服务响应超时，请稍后重试' };
    }
    if (rawMessage.includes('连接未打开') || rawMessage.includes('账号尚未登录')) {
        return { code: 'GAME_OFFLINE', message: '游戏连接尚未就绪，请稍后重试' };
    }
    if (rawMessage.includes('请求队列已满')) {
        return { code: 'ACTIVITY_BUSY', message: '活动操作过于频繁，请稍后再试' };
    }
    if (rawMessage.includes('发送失败') || rawMessage.includes('请求被中断')) {
        return { code: 'ACTIVITY_REQUEST_INTERRUPTED', message: '活动请求未能完成，请稍后重试' };
    }
    if (rawMessage.includes('不匹配的活动 ID') || rawMessage.includes('未知操作类型') || rawMessage.includes('回包缺少动态状态')) {
        return { code: 'ACTIVITY_DATA_CHANGED', message: '活动数据已经更新，请刷新页面后再试' };
    }
    return { code: protocolCode || 'ACTIVITY_OPERATION_FAILED', message: '活动操作失败，请刷新页面后重试' };
}

function handleActivityApiError(res: Response, error: any): Response {
    const result = activityErrorResponse(error);
    return res.json({ ok: false, error: result.message, errorCode: result.code });
}

function mountActivityCenterRoutes(app: Application, ctx: AdminContext): void {
    const withAccount = (handler: (accountId: string, req: Request, res: Response) => Promise<any>) => {
        return async (req: Request, res: Response) => {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            try {
                const data = await handler(accountId, req, res);
                if (!res.headersSent) return res.json({ ok: true, data });
                return undefined;
            } catch (error: any) {
                return handleActivityApiError(res, error);
            }
        };
    };

    const mountGet = (path: string, providerMethod: string): void => {
        app.get(path, withAccount((accountId: string) => ctx.provider[providerMethod](accountId)));
    };

    mountGet('/api/activity-center/activities', 'getActivityDirectorySnapshot');
    mountGet('/api/activity-center/snapshot', 'getActivityCenterSnapshot');
    mountGet('/api/activity-center/season', 'getCurrentSeasonEvent');
    mountGet('/api/activity-center/stellar', 'getCurrentStellarActivity');
    mountGet('/api/activity-center/shop', 'getCurrentStarSandShop');
    mountGet('/api/activity-center/solar-terms', 'getCurrentSolarTerms');
    mountGet('/api/activity-center/qingmei', 'getCurrentQingMeiActivity');
    mountGet('/api/activity-center/qixi', 'getCurrentQixiActivity');
    mountGet('/api/activity-center/charity-red-flower', 'getCurrentCharityRedFlowerActivity');
    mountGet('/api/activity-center/weather', 'getCurrentWeatherActivity');
    mountGet('/api/activity-center/weather/friends', 'getWeatherFriends');

    app.post('/api/activity-center/pass/claim', withAccount((accountId: string) => (
        ctx.provider.claimBattlePassRewards(accountId)
    )));

    app.post('/api/activity-center/constellation/light', withAccount((accountId: string) => (
        ctx.provider.lightConstellation(accountId)
    )));

    app.post('/api/activity-center/shop/exchange', withAccount((accountId: string, req: Request) => (
        ctx.provider.exchangeStarSandGoods(accountId, req.body?.goodsId, req.body?.count)
    )));

    app.post('/api/activity-center/solar-terms/:termId/claim', withAccount((accountId: string, req: Request, res: Response) => {
        const termId = String(req.params.termId || '');
        if (!/^[1-9]\d*$/.test(termId)) {
            res.status(400).json({ ok: false, error: 'termId 必须是正十进制整数' });
            return Promise.resolve(undefined);
        }
        return ctx.provider.claimSolarTerm(accountId, termId);
    }));

    app.post('/api/activity-center/qingmei/daily-seed/claim', withAccount((accountId: string) => (
        ctx.provider.claimQingMeiDailySeed(accountId)
    )));

    app.post('/api/activity-center/qingmei/brew/start', withAccount((accountId: string, req: Request) => (
        ctx.provider.startQingMeiBrew(accountId, req.body?.ingredients ?? req.body?.count)
    )));

    app.post('/api/activity-center/qingmei/brew/continue', withAccount((accountId: string) => (
        ctx.provider.continueQingMeiBrew(accountId)
    )));

    app.post('/api/activity-center/qingmei/brew/settle', withAccount((accountId: string) => (
        ctx.provider.settleQingMeiBrew(accountId)
    )));

    app.post('/api/activity-center/qixi/bridge/claim', withAccount((accountId: string) => (
        ctx.provider.claimQixiBridgeRewards(accountId)
    )));

    app.post('/api/activity-center/charity-red-flower/seeds/claim', withAccount((accountId: string) => (
        ctx.provider.claimCharityRedFlowerSeeds(accountId)
    )));
    app.post('/api/activity-center/charity-red-flower/love/donate', withAccount((accountId: string) => (
        ctx.provider.donateCharityRedFlowerLove(accountId)
    )));
    app.post('/api/activity-center/charity-red-flower/daily-gift/claim', withAccount((accountId: string) => (
        ctx.provider.claimCharityRedFlowerDailyGift(accountId)
    )));

    app.post('/api/activity-center/weather/research/light', withAccount((accountId: string, req: Request) => (
        ctx.provider.lightWeatherResearch(accountId, req.body?.nodeId ?? req.body?.node_id)
    )));
    app.post('/api/activity-center/weather/bottle/buy', withAccount((accountId: string, req: Request) => (
        ctx.provider.buyWeatherBottle(accountId, req.body?.count)
    )));
    app.post('/api/activity-center/weather/bottle/collect', withAccount((accountId: string, req: Request) => (
        ctx.provider.collectWeatherBottle(accountId, req.body?.targetGid ?? req.body?.target_gid)
    )));
    app.post('/api/activity-center/weather/rain/summon', withAccount((accountId: string) => (
        ctx.provider.summonWeatherRain(accountId)
    )));

    // 抓包验证后的天气活动接口；保留独立路由供当前 Web 与兼容客户端使用。
    app.post('/api/activity-center/weather/shop/exchange', withAccount((accountId: string) => (
        ctx.provider.exchangeWeatherCollectorBottle(accountId)
    )));
    app.post('/api/activity-center/weather/friends/scan', withAccount((accountId: string, req: Request) => (
        ctx.provider.scanWeatherFriends(accountId, req.body?.friendGids ?? req.body?.friend_gids ?? req.body?.gids)
    )));
    app.post('/api/activity-center/weather/collect', withAccount((accountId: string, req: Request) => (
        ctx.provider.useWeatherCollectorBottle(accountId, req.body?.friendGid)
    )));
    app.post('/api/activity-center/weather/summon', withAccount((accountId: string) => (
        ctx.provider.useWeatherSummonBottle(accountId)
    )));
    app.post('/api/activity-center/weather/mischief/frog', withAccount((accountId: string, req: Request) => (
        ctx.provider.useWeatherFrogBottle(accountId, req.body?.friendGid)
    )));
    app.post('/api/activity-center/weather/mischief/cloud', withAccount((accountId: string, req: Request) => (
        ctx.provider.useWeatherCloudBottle(accountId, req.body?.friendGid, req.body?.landId)
    )));
    app.post('/api/activity-center/weather/research/:nodeId/advance', withAccount((accountId: string, req: Request, res: Response) => {
        const nodeId = String(req.params.nodeId || '');
        if (!/^[1-9]\d*$/.test(nodeId)) {
            res.status(400).json({ ok: false, error: 'nodeId 必须是正十进制整数' });
            return Promise.resolve(undefined);
        }
        return ctx.provider.advanceWeatherResearch(accountId, nodeId);
    }));

    app.post('/api/activity-center/qixi/gift', withAccount((accountId: string, req: Request) => (
        ctx.provider.giftQixiSachet(accountId, req.body?.friendGid, req.body?.messageTextId ?? 15)
    )));
}

module.exports = { mountActivityCenterRoutes };
