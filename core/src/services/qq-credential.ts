export {};
/**
 * QQ 账号启动前的 Code 重签（尽力而为）。
 *
 * 游戏登录 Code 是一次性的：worker 用它建立 WS 连接后即被服务端消费，
 * accounts.json 里保存的永远是「上一次用过的旧值」，因此服务重启后
 * 直接拿旧 Code 连接会被网关以 400 拒绝，表现就是「必须重新扫码/填 Code」。
 *
 * 标准 qq-miniapp-auth 服务的 /api/qq/miniapp/code 必须携带扫码产生的
 * taskId（任务 2 分钟过期、取码后会注销 QQ 会话），无法免扫码续期；
 * 但仓库内置 NapCat 插件的 /miniapp 端点可以凭当前已登录会话直接签发 Code。
 *
 * 因此这里做一次轻量探测：带空 taskId 请求，标准服务会立即返回
 * TASK_EXPIRED（参数校验阶段即返回，不会进入等待授权流程），此时标记
 * 「该服务不支持免扫码重签」并静默回退；支持的服务则返回新 Code 并写回账号。
 * 整个过程失败不影响原有启动流程，也不会占用扫码工作流。
 */

const axios = require('axios').default;
const store = require('../models/store');

const QQ_MINIAPP_APP_ID = '1112386029';
const REQUEST_TIMEOUT_MS = 2500;
/**
 * 这些错误代表「这个授权服务根本不支持免扫码重签」（参数/鉴权/任务模型层面），
 * 重试多少次都是同一个结果，探到一次就停止探测。
 *
 * LOGIN_REQUIRED 不在此列：它表示 NapCat 里的 QQ 当前没有登录，属于可恢复状态
 * （重新登录 NapCat 后就能继续重签），所以每次掉线仍应尝试，并由掉线重登的
 * 次数闸门负责限流。
 */
const UNSUPPORTED_CODES = /^(?:TASK_EXPIRED|LOGOUT_REQUIRED|WORKFLOW_BUSY|INVALID_SIGNATURE|SIGNATURE_REQUIRED)$/i;

/**
 * uin 归一化：只保留数字并去掉前导 0。
 * 插件的 selfProfile 走的是 `String(info.uin || info.user_id || info.qq)`，
 * 不同 NapCat 版本可能给数字或字符串；非数字内容（拿不到资料时的空串）原样返回。
 */
function normalizeUin(raw: any): string {
    const text = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!text) return '';
    const digits = text.replace(/\D/g, '');
    if (!digits) return text;
    return digits.replace(/^0+/, '') || '0';
}

/** 日志里只露末四位，避免把完整 QQ 号写进错误信息。 */
function maskUin(value: string): string {
    const text = String(value || '');
    return text.length <= 4 ? text : `***${text.slice(-4)}`;
}

export interface QqCodeRefreshResult {
    ok: boolean;
    code?: string;
    error?: string;
    /** 未启用 QQ 扫码服务或该服务不支持免扫码重签。 */
    skipped?: boolean;
}

let unsupported = false;

function extractCode(data: any): string {
    if (!data || typeof data !== 'object' || data.ok === false) return '';
    return String(data.code || (data.data && data.data.code) || '').trim();
}

function loginSettings(): any {
    const settings = typeof store.getLoginSettings === 'function' ? store.getLoginSettings() : null;
    if (!settings || settings.qqQrLogin !== true) return null;
    const endpoint = String(settings.napCatEndpoint || '').trim().replace(/\/+$/, '');
    const signature = String(settings.napCatSignature || '').trim();
    if (!endpoint || !signature) return null;
    return { endpoint, signature };
}

/** 仅供测试重置进程内的「服务不支持」标记。 */
function resetQqCodeRefreshState(): void {
    unsupported = false;
}

/**
 * 当前进程能否对 QQ 账号做免扫码重签（掉线重登的准入条件）。
 *
 * 需要启用 QQ 扫码服务并填好 NapCat 地址与签名；一旦探测到该服务不支持
 * 免扫码重签（标准 qq-miniapp-auth 就是这种），这里直接返回 false，
 * 避免掉线后反复重登必然失败、把账号日志刷满。
 */
function isQqCodeRefreshConfigured(): boolean {
    if (unsupported) return false;
    return !!loginSettings();
}

async function tryRefreshQqGameCode(accountId: unknown): Promise<QqCodeRefreshResult> {
    if (unsupported) return { ok: false, skipped: true, error: '当前 QQ 授权服务不支持免扫码重签' };
    const settings = loginSettings();
    if (!settings) return { ok: false, skipped: true, error: '未启用 QQ 扫码服务' };

    const accounts = (store.getAccounts().accounts || []);
    const account = accounts.find((item: any) => String(item.id) === String(accountId));
    if (!account) return { ok: false, error: '账号不存在' };

    // 仓库内置 NapCat 插件走 /miniapp；外部服务默认走 /api/qq/miniapp/code。
    // 可用 FARM_QQ_CODE_REFRESH_PATH 显式指定端点路径。
    const path = String(process.env.FARM_QQ_CODE_REFRESH_PATH || '/api/qq/miniapp/code').trim();
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-API-Signature': settings.signature,
    };
    // 内置插件使用 Bearer token 鉴权；未额外配置时省略，由插件自行放行。
    const pluginToken = String(process.env.FARM_NAPCAT_PLUGIN_TOKEN || '').trim();
    if (pluginToken) headers.Authorization = `Bearer ${pluginToken}`;

    try {
        const response = await axios.post(`${settings.endpoint}${path}`, {
            appId: QQ_MINIAPP_APP_ID,
            taskId: '',
            uin: String(account.uin || account.qq || '').trim(),
        }, {
            timeout: REQUEST_TIMEOUT_MS,
            validateStatus: () => true,
            headers,
        });
        const data = response?.data;
        const code = extractCode(data);
        if (code) {
            // 内置 NapCat 插件的 /miniapp 忽略请求里的 uin，签发的永远是
            // 「当前 NapCat 里登录那个 QQ」的 Code，并把真实 uin 一并回传。
            // 我们之前拿到 Code 就直接写盘，两个 QQ 账号（或在 NapCat 里换过号）时
            // 会把 A 的 Code 写进 B 的账号，然后以 B 的名义跑 A 的农场，面板完全不报错。
            // 这里做一次守卫：两边都能解析出 uin 且不一致时拒绝写入。
            const issuedUin: string = normalizeUin(data?.uin);
            const expectedUin: string = normalizeUin(account.uin || account.qq);
            if (issuedUin && expectedUin && issuedUin !== expectedUin) {
                return {
                    ok: false,
                    error: `QQ 授权服务返回的账号(${maskUin(issuedUin)})与当前账号(${maskUin(expectedUin)})不一致，已拒绝写入。`
                        + '请确认 NapCat 里登录的是同一个 QQ。',
                };
            }
            store.addOrUpdateAccount({ id: String(account.id), code });
            return { ok: true, code };
        }
        const reason = String(data?.code || data?.error || '').trim();
        // 只有明确的「服务不支持免扫码重签」才永久停止探测；其余失败（含 NapCat
        // 掉线、临时 5xx）保留重试机会，由掉线重登的次数闸门限流。
        if (UNSUPPORTED_CODES.test(reason)) unsupported = true;
        return { ok: false, skipped: unsupported, error: reason || 'QQ 授权服务未返回新 Code' };
    }
    catch (error: any) {
        return { ok: false, error: String((error && error.message) || 'QQ Code 重签请求失败') };
    }
}

module.exports = {
    QQ_MINIAPP_APP_ID,
    tryRefreshQqGameCode,
    isQqCodeRefreshConfigured,
    resetQqCodeRefreshState,
};
