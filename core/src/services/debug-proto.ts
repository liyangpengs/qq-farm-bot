export {};
const fs = require('node:fs');
const path = require('node:path');
const { sendMsgAsync } = require('../utils/network');
const { getDataDir } = require('../config/runtime-paths');

/**
 * 任意协议「裸发」探测（抓包 / 反查未定义 proto 的接口用）
 *
 * 用途：当某个功能的 proto 尚未定义、接口名/service 归属未知时，直接按 hex 发一条
 * 请求，把原始响应带回来逐字段解析。典型场景：
 *   - 用空包 / 无效 payload 探测方法是否存在：
 *       code=1000020 参数错误 → 方法存在（只是 payload 不对）
 *       code=1020002 网络繁忙 → 服务或方法不存在
 *   - 反向确认 RPC 挂在哪个 service 下（例：StrokeAnimal 挂 RanchService 而非 AnimalService）
 *
 * ⚠️ 安全：该能力可发送任意协议（含写操作），必须显式开启：
 *   开 → mkdir -p <DATA_DIR> && touch <DATA_DIR>/debug_proto.on
 *   关 → rm <DATA_DIR>/debug_proto.on
 * 未开启时接口一律 403，用完请立即删除开关文件。
 *
 * ★ 与本项目 sendMsgAsync 的适配：
 *   本项目网络层对非零 error_code 会抛 GatewayError（其 code 即 error_code），
 *   而不是把 meta.error_code 随结果返回。探测恰恰依赖错误码判断方法是否存在，
 *   所以这里捕获 GatewayError 并把 e.code 作为 serverErrorCode 回传；其他异常照常抛出。
 */

function getSwitchFile(): string {
    return path.join(getDataDir(), 'debug_proto.on');
}

function isDebugProtoEnabled(): boolean {
    try {
        return fs.existsSync(getSwitchFile());
    } catch {
        return false;
    }
}

function normalizeHex(input: unknown): Buffer {
    const s = String(input || '').replace(/[^0-9a-fA-F]/g, '');
    if (s.length % 2 !== 0) throw new Error('payloadHex 长度必须是偶数');
    return Buffer.from(s, 'hex');
}

interface DebugProtoPayload {
    service?: string;
    method?: string;
    payloadHex?: string;
    timeoutMs?: number;
}

interface DebugProtoResult {
    service: string;
    method: string;
    sentLen: number;
    sentHex: string;
    replyLen: number;
    replyHex: string;
    replyB64: string;
    elapsedMs: number;
    serverErrorCode: number;
    serverErrorMessage: string;
}

async function sendRawProto(payload: DebugProtoPayload = {}): Promise<DebugProtoResult> {
    if (!isDebugProtoEnabled()) {
        const err: any = new Error('调试协议接口未开启（需在数据目录创建 debug_proto.on）');
        err.code = 'DEBUG_PROTO_DISABLED';
        throw err;
    }

    const service = String(payload.service || '').trim();
    const method = String(payload.method || '').trim();
    if (!service || !method) throw new Error('缺少 service 或 method');
    if (!/^[A-Za-z0-9_.]+$/.test(service) || !/^[A-Za-z0-9_]+$/.test(method)) {
        throw new Error('service / method 含非法字符');
    }

    const body = payload.payloadHex ? normalizeHex(payload.payloadHex) : Buffer.alloc(0);
    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || 20000, 1000), 60000);
    const started = Date.now();

    let reply = Buffer.alloc(0);
    let serverErrorCode = 0;
    let serverErrorMessage = '';
    try {
        const sent = await sendMsgAsync(service, method, body, timeoutMs);
        reply = Buffer.from(sent.body || []);
        serverErrorCode = Number((sent.meta && sent.meta.error_code) || 0);
    } catch (e: any) {
        if (e && e.name === 'GatewayError') {
            // 非零 error_code：网络层以 GatewayError 抛出，code 就是我们要读的信号
            serverErrorCode = Number(e.code) || 0;
            serverErrorMessage = String(e.errorMessage || '');
        } else {
            throw e;
        }
    }

    return {
        service,
        method,
        sentLen: body.length,
        sentHex: body.toString('hex'),
        replyLen: reply.length,
        replyHex: reply.toString('hex'),
        replyB64: reply.toString('base64'),
        elapsedMs: Date.now() - started,
        serverErrorCode,
        serverErrorMessage,
    };
}

module.exports = { sendRawProto, isDebugProtoEnabled, getSwitchFile, normalizeHex };
