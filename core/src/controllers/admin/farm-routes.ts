import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Farm-related routes: status, automation, fertilizer, lands, seeds, bag,
 * daily-gifts, accounts start/stop, farm operate, analytics, plant-blacklist.
 */

const { getLevelExpProgress } = require('../../config/gameConfig');
const store = require('../../models/store');

const {
    createAuthRequired,
    getAccId,
    handleApiError,
    resolveAccId,
} = require('./middleware');

function mountFarmRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);

    // API: 完整状态
    app.get('/api/status', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = ctx.provider.getStatus(id);
            if (data && data.status) {
                const { level, exp } = data.status;
                const progress = getLevelExpProgress(level, exp);
                data.levelProgress = progress;
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.get('/api/diamond', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const diamond = await ctx.provider.getDiamondBalance(id);
            res.json({ ok: true, data: { diamond: Math.max(0, Number(diamond) || 0) } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/automation', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        try {
            let lastData = null;
            for (const [k, v] of Object.entries(req.body)) {
                lastData = await ctx.provider.setAutomation(id, k, v);
            }
            res.json({ ok: true, data: lastData || {} });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/fertilizer/buy', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        try {
            const type = String(req.body?.type || 'organic');
            const count = Number(req.body?.count) || 0;
            const bought = await ctx.provider.buyFertilizer(id, type, count);
            res.json({ ok: true, bought });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 检测化肥容器并自动购买
    app.post('/api/fertilizer/check-and-buy', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        try {
            const buyOrganic = req.body?.buyOrganic ?? false;
            const buyNormal = req.body?.buyNormal ?? false;
            const organicCount = Number(req.body?.organicCount) || 0;
            const organicThresholdHours = Number(req.body?.organicThresholdHours) || 0;
            const normalCount = Number(req.body?.normalCount) || 0;
            const normalThresholdHours = Number(req.body?.normalThresholdHours) || 0;

            const result = await ctx.provider.checkAndBuyFertilizer(id, {
                buyOrganic,
                buyNormal,
                organicCount,
                organicThresholdHours,
                normalCount,
                normalThresholdHours,
            });
            res.json({ ok: true, ...result });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农田详情
    app.get('/api/lands', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        try {
            const data = await ctx.provider.getLands(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 背包中当前可对自己农场使用的特殊互动道具。
    app.get('/api/farm/interaction-items', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.getSelfInteractionItems(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 在自己农场按地块编号顺序使用特殊互动道具。
    app.post('/api/farm/interaction-items/use-batch', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.useSelfInteractionItemBatch(id, req.body?.itemId, req.body?.landIds);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 蔬菜黑名单
    app.get('/api/plant-blacklist', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            const list = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: list });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/plant-blacklist', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            const seedId = Number((req.body || {}).seedId);
            if (!seedId) return res.status(400).json({ ok: false, error: 'Missing seedId' });

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];

            if (!current.includes(seedId)) {
                const next = [...current, seedId];
                if (store.setPlantBlacklist) {
                    store.setPlantBlacklist(accountId, next);
                }
            }

            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/plant-blacklist/:seedId', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            const seedId = Number(req.params.seedId);
            if (!seedId) return res.status(400).json({ ok: false, error: 'Missing seedId' });

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            const next = current.filter((id: number) => id !== seedId);

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, next);
            }

            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 批量添加蔬菜黑名单
    app.post('/api/plant-blacklist/batch', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            const seedIds = (req.body || {}).seedIds || [];
            if (!Array.isArray(seedIds)) {
                return res.status(400).json({ ok: false, error: 'seedIds must be an array' });
            }

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            const merged = [...new Set([...current, ...seedIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)])];

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, merged);
            }

            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 清空蔬菜黑名单
    app.delete('/api/plant-blacklist', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, []);
            }

            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(accountId);
            }

            res.json({ ok: true, data: [] });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 种子列表
    app.get('/api/seeds', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        try {
            const data = await ctx.provider.getSeeds(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 背包物品
    app.get('/api/bag', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        try {
            const data = await ctx.provider.getBag(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 使用背包物品
    app.post('/api/bag/use', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const { itemId, count, uid } = req.body;
            if (!itemId) return res.status(400).json({ ok: false, error: '缺少 itemId' });
            const data = await ctx.provider.useItem(id, Number(itemId), Math.max(1, Number(count) || 1), Number(uid) || 0);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 出售背包物品
    app.post('/api/bag/sell', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const { items } = req.body;
            if (!Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ ok: false, error: '缺少出售物品列表' });
            }
            const data = await ctx.provider.sellItems(id, items);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/illustrated', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.getIllustratedSnapshot(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 批量锁定/解锁果实、超变果实和种子。
    app.post('/api/bag/lock', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const { itemUids, locked } = req.body || {};
            if (!Array.isArray(itemUids) || itemUids.length === 0) {
                return res.status(400).json({ ok: false, error: '缺少物品 UID 列表' });
            }
            if (typeof locked !== 'boolean') {
                return res.status(400).json({ ok: false, error: 'locked 必须为布尔值' });
            }
            const data = await ctx.provider.setItemsLocked(id, itemUids, locked);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 页面打开或用户刷新时查询主人侧待拾取宠物礼包。
    app.get('/api/dog/skill-gifts', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.getDogSkillGiftStatus(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 用户手动拾取全部待领取的“同气连枝礼包”。
    app.post('/api/dog/skill-gifts/claim', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.claimDogSkillGifts(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取当前账号的宠物、护主剩余时间和狗粮库存。
    app.get('/api/pets', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.getPetInfo(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 宠物技能静态文案。真实点击技能图标不会发起独立 RPC。
    app.get('/api/pets/skills', (_req: Request, res: Response) => {
        try {
            const data = require('../../services/pets').getPetSkillCatalog();
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 使用狗粮。worker 调用经真实抓包确认的 DogService.AddFood（游戏内狗盆确认行为）。
    app.post('/api/pets/food/use', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const itemId = Number(req.body?.itemId) || 0;
            const count = Math.max(1, Math.trunc(Number(req.body?.count) || 1));
            const uid = Math.max(0, Number(req.body?.uid) || 0);
            if (!itemId) return res.status(400).json({ ok: false, error: '缺少 itemId' });
            const data = await ctx.provider.useDogFood(id, itemId, count, uid);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 上场已获得宠物（DogService.DeployDog）。
    app.post('/api/pets/deploy', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const dogId = Math.max(0, Number(req.body?.dogId) || 0);
            if (!dogId) return res.status(400).json({ ok: false, error: '缺少 dogId' });
            res.json({ ok: true, data: await ctx.provider.deployDog(id, dogId) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 收回当前宠物（DogService.WithdrawDog，真实请求体为空）。
    app.post('/api/pets/withdraw', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            res.json({ ok: true, data: await ctx.provider.withdrawDog(id) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取宠物页守护记录（DogService.GetProtectLogs，真实点击抓包确认）。
    app.get('/api/pets/protect-logs', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            res.json({ ok: true, data: await ctx.provider.getPetProtectLogs(id) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取背包种子列表
    app.get('/api/bag/seeds', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.getBagSeeds(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        try {
            const data = await ctx.provider.getDailyGifts(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 启动账号
    app.post('/api/accounts/:id/start', (req: Request, res: Response) => {
        try {
            const accountId = resolveAccId(ctx, req.params.id);

            const ok = ctx.provider.startAccount(accountId);
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 停止账号
    app.post('/api/accounts/:id/stop', (req: Request, res: Response) => {
        try {
            const accountId = resolveAccId(ctx, req.params.id);

            const ok = ctx.provider.stopAccount(accountId);
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农场一键操作
    app.post('/api/farm/operate', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        try {
            const { opType } = req.body; // 'harvest', 'clear', 'plant', 'all'
            await ctx.provider.doFarmOp(id, opType);
            res.json({ ok: true });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 数据分析
    app.get('/api/analytics', async (req: Request, res: Response) => {
        try {
            const sortBy = req.query.sort || 'exp';
            const { getPlantRankings } = require('../../services/analytics');
            const data = getPlantRankings(sortBy);
            res.json({ ok: true, data });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });


    // ============ 配置管理 API ============

    /**
     * GET /api/config/seeds — 种子列表
     */
    app.get('/api/config/seeds', async (req: Request, res: Response) => {
        try {
            const { getAllSeeds, getItemById, parseSells } = require('../../config/gameConfig');
            const seeds = getAllSeeds();
            // 补充 priceId 字段供前端统一价格显示
            const data = seeds.map((s: any) => {
                const item = getItemById(s.seedId);
                const sellsList = item ? parseSells(item.sells) : [];
                const priceId = sellsList.length > 0 ? sellsList[0].currencyId : 0;
                return { ...s, priceId };
            });
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /**
     * GET /api/config/fruits — 果实列表
     */
    app.get('/api/config/fruits', async (_req: Request, res: Response) => {
        try {
            const { getAllFruits, getPlantByFruitId, getItemImageById, parseSells } = require('../../config/gameConfig');
            const fruits = getAllFruits();
            const data = fruits.map((fruit: any) => {
                const plant = getPlantByFruitId(fruit.id);
                const sellsList = parseSells(fruit.sells);
                const effectiveList = sellsList.length > 0 ? sellsList : parseSells(fruit.cond_sells);
                return {
                    id: fruit.id,
                    name: fruit.name,
                    type: fruit.type,
                    price: effectiveList.length > 0 ? effectiveList[0].price : 0,
                    priceId: effectiveList.length > 0 ? effectiveList[0].currencyId : 0,
                    sellCond: fruit.sell_cond || null,
                    condSells: fruit.cond_sells || null,
                    level: Number(fruit.level) || 0,
                    assetName: fruit.asset_name || '',
                    desc: fruit.desc || '',
                    effectDesc: fruit.effectDesc || '',
                    rarity: Number(fruit.rarity) || 0,
                    maxCount: Number(fruit.max_count) || 9999,
                    maxOwn: Number(fruit.max_own) || 9999,
                    plantId: plant ? plant.id : null,
                    seedId: plant ? plant.seed_id : null,
                    plantName: plant ? plant.name : null,
                    image: getItemImageById(fruit.id) || '',
                };
            });
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /**
     * GET /api/config/items — 道具列表（排除种子和果实）
     */
    app.get('/api/config/items', async (req: Request, res: Response) => {
        try {
            const { getAllItems, getItemsByType, getItemImageById, parseSells } = require('../../config/gameConfig');
            const typeFilter = req.query.type ? Number(req.query.type) : null;
            const items = typeFilter ? getItemsByType(typeFilter) : getAllItems();
            const data = items.map((item: any) => {
                const sellsList = parseSells(item.sells);
                return {
                id: item.id,
                type: item.type,
                name: item.name,
                interactionType: item.interaction_type || '',
                priceId: sellsList.length > 0 ? sellsList[0].currencyId : 0,
                price: sellsList.length > 0 ? sellsList[0].price : 0,
                sellCond: item.sell_cond || null,
                condSells: item.cond_sells || null,
                level: Number(item.level) || 0,
                assetName: item.asset_name || '',
                iconRes: item.icon_res || '',
                maxCount: Number(item.max_count) || 9999,
                maxOwn: Number(item.max_own) || 9999,
                canUse: Number(item.can_use) || 0,
                desc: item.desc || '',
                effectDesc: item.effectDesc || '',
                traitId: Number(item.trait_id) || 0,
                layer: Number(item.layer) || 0,
                rarity: Number(item.rarity) || 0,
                rarityColor: item.rarity_color || '',
                jumps: item.jumps || '',
                image: getItemImageById(item.id) || '',
                };
            });
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

}

module.exports = { mountFarmRoutes };
