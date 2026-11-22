import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 调试接口（仅用于抓包 / 协议取证，默认关闭）
 * - GET  /api/debug/proto   查询「裸发任意协议」开关状态
 * - POST /api/debug/proto   裸发任意协议并返回原始响应（hex/base64）
 *   body: { service, method, payloadHex?, timeoutMs? }
 *
 * 鉴权由 auth-routes 里 app.use('/api', authRequired) 统一负责；
 * 账号头仅用于与其他账号接口保持一致，裸发本身走当前在线连接（见 network.ts）。
 *
 * 用法示例：
 *   curl -H 'x-admin-token: <token>' -H 'x-account-id: <id>' \
 *     -H 'Content-Type: application/json' \
 *     -d '{"service":"gamepb.animalpb.RanchService","method":"StrokeAnimal"}' \
 *     http://127.0.0.1:3007/api/debug/proto
 *
 * 返回 data.serverErrorCode：
 *   1000020 = 方法存在但参数不对（方法名/服务名猜对了）
 *   1020002 = 服务或方法不存在（换 service 再试）
 * 详见 services/debug-proto.ts 顶部注释。**用完请删掉开关文件**。
 */
const { getAccId, handleApiError } = require('./middleware');
const { sendRawProto, isDebugProtoEnabled, getSwitchFile } = require('../../services/debug-proto');

function mountDebugRoutes(app: Application, ctx: AdminContext): void {
    app.get('/api/debug/proto', (_req: Request, res: Response) => {
        return res.json({
            ok: true,
            data: {
                enabled: isDebugProtoEnabled(),
                switchFile: getSwitchFile(),
                hint: '创建该文件开启；用完请立即删除。账号需已登录在线。',
            },
        });
    });

    app.post('/api/debug/proto', async (req: Request, res: Response) => {
        if (!getAccId(ctx, req)) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        if (!isDebugProtoEnabled()) {
            return res.status(403).json({
                ok: false,
                error: '调试协议接口未开启（需在数据目录创建 debug_proto.on）',
                errorCode: 'DEBUG_PROTO_DISABLED',
            });
        }
        try {
            const { service, method, payloadHex, timeoutMs } = req.body || {};
            const data = await sendRawProto({ service, method, payloadHex, timeoutMs });
            return res.json({ ok: true, data });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });
}

module.exports = { mountDebugRoutes };
