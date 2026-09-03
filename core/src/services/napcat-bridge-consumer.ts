export {};

/**
 * NapCat bridge 客户端（farm-bot → bridge Unix socket）。
 *
 * bridge 服务端（napcat-bridge/server.js）监听一个 Unix socket，负责：
 *  - 按需拉起/回收一个临时 QQ 实例（扫码登录用，不踢主实例）；
 *  - 通过 owner 租约隔离：多个调用方同时扫码会互相冲突（409 busy）。
 *
 * 本模块只做一件事：把参数拼进 URL/body，通过 socket 走 HTTP 转发给 bridge，
 * 再把 bridge 的 JSON 响应规范化成 { ok, data } 或抛错。
 */
const http = require('node:http');

const SOCKET_PATH = process.env.NAPCAT_BRIDGE_SOCKET || '/run/qqfarm-napcat-bridge/bridge.sock';

interface BridgeResult {
    [key: string]: any;
}

class NapCatBridgeError extends Error {
    public readonly statusCode?: number;
    public readonly busy?: boolean;
    public readonly retryAfterMs?: number;

    constructor(message: string, opts: { statusCode?: number; busy?: boolean; retryAfterMs?: number } = {}) {
        super(message);
        this.name = 'NapCatBridgeError';
        this.statusCode = opts.statusCode;
        this.busy = opts.busy;
        this.retryAfterMs = opts.retryAfterMs;
    }
}

function requestBridge(
    method: string,
    pathWithOwner: string,
    body: Record<string, any> | null = null,
    timeoutMs = 70000,
): Promise<BridgeResult> {
    return new Promise((resolve, reject) => {
        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const req = http.request(
            {
                socketPath: SOCKET_PATH,
                path: pathWithOwner,
                method,
                timeout: timeoutMs,
                headers: payload
                    ? {
                          'content-type': 'application/json',
                          'content-length': payload.length,
                      }
                    : {},
            },
            (res: any) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    let data: any = null;
                    try {
                        data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                    }
                    catch {
                        return reject(new NapCatBridgeError(`QQ 登录桥接返回非 JSON（HTTP ${res.statusCode}）`, { statusCode: res.statusCode }));
                    }
                    if (res.statusCode < 200 || res.statusCode >= 300 || !data.ok) {
                        const error: any = new NapCatBridgeError(
                            data.error || `QQ 登录桥接失败（HTTP ${res.statusCode}）`,
                            {
                                statusCode: res.statusCode,
                                busy: res.statusCode === 409 || res.statusCode === 449 || !!data.busy,
                                retryAfterMs: Number(data.retryAfterMs) || 0,
                            },
                        );
                        return reject(error);
                    }
                    resolve(data.data || {});
                });
            },
        );
        req.on('timeout', () => req.destroy(new NapCatBridgeError('QQ 登录桥接请求超时')));
        req.on('error', (error: any) => reject(new NapCatBridgeError(`QQ 登录桥接不可用: ${error.message}`)));
        if (payload) req.write(payload);
        req.end();
    });
}

function withOwner(path: string, owner: string): string {
    const value = String(owner || '').trim();
    if (!value) return path;
    return `${path}?owner=${encodeURIComponent(value)}`;
}

module.exports = {
    NapCatBridgeError,

    /** 健康检查：确认 bridge socket 可连。 */
    checkNapCatBridge: (): Promise<BridgeResult> =>
        requestBridge('GET', '/health', null, 5000),

    /** 生成/取二维码。首次调用会按需拉起临时 QQ 实例（最长数十秒）。 */
    getNapCatQrCode: (owner = ''): Promise<BridgeResult> =>
        requestBridge('GET', withOwner('/qrcode', owner), null, 70000),

    /** 无副作用轮询扫码状态：绝不重启会话。 */
    getNapCatLoginStatus: (owner = ''): Promise<BridgeResult> =>
        requestBridge('GET', withOwner('/status', owner), null, 10000),

    /** 只读当前二维码图数据（含高清重建 URL）。 */
    getNapCatQrImage: (owner = ''): Promise<BridgeResult> =>
        requestBridge('GET', withOwner('/image', owner), null, 10000),

    /** 取授权码（Code）。uin 传扫码目标 QQ，可空；bridge 侧校验 uin 与 profile 一致性。 */
    authorizeNapCatFarm: (uin = '', owner = ''): Promise<BridgeResult> =>
        requestBridge('POST', '/authorize', { uin, owner }, 90000),

    /** 主动交回扫码租约（关页面/切走时调），失败可安静吞错。 */
    releaseNapCatScanLease: (owner = ''): Promise<BridgeResult> =>
        requestBridge('POST', '/release', { owner }, 5000),

    /** 页面恢复时软重新占用（不换码、不重启会话）。 */
    reclaimNapCatScanLease: (owner = ''): Promise<BridgeResult> =>
        requestBridge('POST', '/reclaim', { owner }, 8000),
};