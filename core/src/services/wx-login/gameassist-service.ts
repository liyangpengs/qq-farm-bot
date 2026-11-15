import crypto from 'node:crypto';
import { getNativeWxLoginCode } from './native-protocol';

/**
 * 手游助手（GameAssist）扫码渠道登录服务。
 *
 * 与 PC 端腾讯手游助手同链路（WMPF/ILink 取码栈同构），仅凭据签发不同：
 * - OAuth appid 用手游助手自己的 wxef99873dbfab493c，回调 syzslogin/syzs_oauth
 * - state 必须为官方形状纯数字浮点（100*Math.random()），非数字会被网关判 -109
 * - 换凭据走 302 链 Set-Cookie 签发（.qq.com 域），兼容 camelCase JSON 信封
 * - login_buffer 与铸 code 完全复用应用宝路径（pcyyb_get_wx_login_buffer_auth + native-protocol）
 * - 刷新走 syzs 专线 /v3/syzs_refresh_token（令牌不滚动，仅续期 expires_in）
 */

const QR_CONNECT_URL = 'https://open.weixin.qq.com/connect/qrconnect';
const QR_IMAGE_BASE = 'https://open.weixin.qq.com/connect/qrcode/';
const QR_POLL_URL = 'https://long.open.weixin.qq.com/connect/l/qrconnect';
const GA_CALLBACK_URL = 'https://yybadaccess.3g.qq.com/syzslogin/syzs_oauth';
const GA_REFRESH_URL = 'https://yybadaccess.3g.qq.com/v3/syzs_refresh_token';
const GA_CHECK_LOGIN_URL = 'https://yybadaccess.3g.qq.com/v3/syzs_check_login';
const LOGIN_BUFFER_URL = 'https://yybadaccess.3g.qq.com/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth';
const LOGIN_BUFFER_ACCESS_KEY = 'wgrdg373hy26ww2';
const GA_OAUTH_APP_ID = 'wxef99873dbfab493c';
const TARGET_APP_ID = 'wx5306c5978fdb76e4';
const EXCHANGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export type GaScanStatus = 'waiting' | 'scanned' | 'authorized' | 'cancelled' | 'expired';

export interface GaCredentials {
    openid: string;
    accesstoken: string;
    refreshtoken: string;
    nickname?: string;
    scope?: string;
    expires_in: number;
    expires_at: number;
}

export interface GaLoginSession {
    cookies: Map<string, string>;
    uuid: string;
    state: string;
    oauthCode?: string;
}

interface HttpResult {
    status: number;
    body: Buffer;
    headers: Headers;
}

function cookieHeader(cookies: Map<string, string>): string {
    return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

function storeCookies(cookies: Map<string, string>, headers: Headers): void {
    const headerValue = headers.get('set-cookie');
    const values = typeof (headers as any).getSetCookie === 'function'
        ? (headers as any).getSetCookie()
        : headerValue ? [headerValue] : [];
    for (const value of values) {
        const pair = value.split(';', 1)[0].trim();
        const separator = pair.indexOf('=');
        if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
}

async function request(url: string, cookies: Map<string, string>, init: RequestInit = {}, timeout = 35_000, extraHopCookies?: CookieSink): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        let currentUrl = url;
        let method = init.method || 'GET';
        let body = init.body;
        for (let redirects = 0; redirects <= 6; redirects++) {
            const headers = new Headers(init.headers);
            if (!headers.get('User-Agent')) headers.set('User-Agent', 'Mozilla/5.0');
            if (cookies.size) headers.set('Cookie', cookieHeader(cookies));
            const response = await fetch(currentUrl, { ...init, method, body, headers, redirect: 'manual', signal: controller.signal });
            storeCookies(cookies, response.headers);
            if (extraHopCookies) extraHopCookies(response.headers);
            const location = response.headers.get('location');
            if (response.status < 300 || response.status >= 400 || !location) {
                return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
            }
            currentUrl = new URL(location, currentUrl).toString();
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
                method = 'GET';
                body = undefined;
            }
        }
        throw new Error('Too many redirects while contacting WeChat');
    } finally {
        clearTimeout(timer);
    }
}

type CookieSink = (headers: Headers) => void;

/** 官方客户端 state=100*Math.random() 的浮点形状（14 位小数）。 */
export function randomNumericState(): string {
    return (Math.random() * 100).toFixed(14);
}

function isNumericState(state: string): boolean {
    return /^[0-9]+\.[0-9]+$/.test(state) || /^[0-9]+$/.test(state);
}

function decodeCookieValue(value: string): string {
    if (!value.includes('%')) return value;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function pickCookie(cookies: Map<string, string>, names: string[]): string {
    for (const name of names) {
        const value = cookies.get(name);
        if (value) return decodeCookieValue(value);
    }
    return '';
}

function parseEnvelopeCredentials(body: Buffer, hopCookies: Map<string, string>): Partial<GaCredentials> {
    const creds: Partial<GaCredentials> = {};
    let data: any;
    try {
        data = JSON.parse(body.toString('utf8'));
    } catch {
        data = null;
    }
    if (data && typeof data === 'object') {
        if (data.code !== undefined && Number(data.code) !== 0) {
            throw new Error(`手游助手凭据签发被拒: code=${String(data.code)} msg=${String(data.msg || '')}`);
        }
        let info = data.userInfo || data.user_info || data;
        if (typeof info === 'string') {
            try {
                info = JSON.parse(info);
            } catch {
                info = {};
            }
        }
        if (info && typeof info === 'object') {
            creds.openid = String(info.openId || info.open_id || '') || undefined;
            creds.accesstoken = String(info.accessToken || info.access_token || '') || undefined;
            creds.refreshtoken = String(info.refreshToken || info.refresh_token || '') || undefined;
            creds.nickname = String(info.username || info.nickname || info.nickName || '') || undefined;
            creds.scope = String(info.scope || '') || undefined;
            const expiresIn = Number(info.expiresIn ?? info.expires_in ?? 0);
            if (expiresIn > 0) creds.expires_in = expiresIn;
            const expireTime = Number(info.expireTime ?? info.expire_time ?? 0);
            if (expireTime > 0) creds.expires_at = expireTime > 1e12 ? expireTime : expireTime * 1000;
        }
    }
    if (!creds.openid || !creds.accesstoken) {
        creds.openid = creds.openid || pickCookie(hopCookies, ['openid']) || undefined;
        creds.accesstoken = creds.accesstoken || pickCookie(hopCookies, ['accesstoken', 'access_token']) || undefined;
        creds.refreshtoken = creds.refreshtoken || pickCookie(hopCookies, ['refreshtoken', 'refresh_token']) || undefined;
        creds.nickname = creds.nickname || pickCookie(hopCookies, ['nickname']) || undefined;
        creds.scope = creds.scope || pickCookie(hopCookies, ['scope']) || undefined;
        const cookieExpiresIn = Number(pickCookie(hopCookies, ['expires_in'])) || 0;
        if (cookieExpiresIn > 0) creds.expires_in = cookieExpiresIn;
    }
    return creds;
}

export class GameAssistLoginService {
    async createQrSession(): Promise<{ session: GaLoginSession; qr: Buffer }> {
        const cookies = new Map<string, string>();
        const state = randomNumericState();
        if (!isNumericState(state)) throw new Error('手游助手 state 生成异常');
        const params = new URLSearchParams({
            appid: GA_OAUTH_APP_ID,
            redirect_uri: GA_CALLBACK_URL,
            response_type: 'code',
            scope: 'snsapi_login,snsapi_runtime_pcsdk',
            state,
            fast_login: '1',
            self_redirect: 'true',
            style: 'black',
        });
        const page = await request(`${QR_CONNECT_URL}?${params}`, cookies);
        if (page.status < 200 || page.status >= 300) throw new Error(`创建手游助手扫码会话失败 (HTTP ${page.status})`);
        const uuid = /\/connect\/qrcode\/([^"'>\s]+)/.exec(page.body.toString('utf8'))?.[1];
        if (!uuid) throw new Error('无法解析手游助手扫码会话');
        const qr = await request(`${QR_IMAGE_BASE}${encodeURIComponent(uuid)}`, cookies);
        if (qr.status < 200 || qr.status >= 300) throw new Error(`下载手游助手二维码失败 (HTTP ${qr.status})`);
        return { session: { cookies, uuid, state }, qr: qr.body };
    }

    async poll(session: GaLoginSession): Promise<GaScanStatus> {
        if (session.oauthCode) return 'authorized';
        const params = new URLSearchParams({ uuid: session.uuid, _: String(Date.now()) });
        const response = await request(`${QR_POLL_URL}?${params}`, session.cookies, {}, 35_000);
        if (response.status < 200 || response.status >= 300) throw new Error(`手游助手扫码轮询失败 (HTTP ${response.status})`);
        const body = response.body.toString('utf8');
        const errcode = /wx_errcode\s*=\s*(\d+)/.exec(body)?.[1];
        if (errcode === '408') return 'waiting';
        if (errcode === '404') return 'scanned';
        if (errcode === '403') return 'cancelled';
        if (errcode === '402') return 'expired';
        if (errcode === '405') {
            const code = /wx_code\s*=\s*'([^']+)'/.exec(body)?.[1];
            if (!code) throw new Error('手游助手授权回包缺少 code');
            session.oauthCode = code;
            return 'authorized';
        }
        throw new Error('手游助手扫码轮询返回无法识别');
    }

    /** 用授权 code 换 syzs 凭据（302 链 cookie 签发为主，兼容 JSON 信封）。 */
    async confirm(session: GaLoginSession): Promise<GaCredentials> {
        if (!session.oauthCode) throw new Error('等待扫码授权');
        if (!isNumericState(session.state)) throw new Error('手游助手 state 必须为纯数字');
        const hopCookies = new Map<string, string>();
        const sink: CookieSink = (headers) => storeCookies(hopCookies, headers);
        const params = new URLSearchParams({
            login_type: 'wx',
            domain: '1',
            syzs_prefix: '',
            code: session.oauthCode,
            state: session.state,
        });
        const callback = await request(`${GA_CALLBACK_URL}?${params}`, session.cookies, {
            headers: {
                'Accept': 'text/html,application/json',
                'Referer': 'https://open.weixin.qq.com/',
                'User-Agent': EXCHANGE_UA,
            },
        }, 35_000, sink);
        if (callback.status < 200 || callback.status >= 400) throw new Error(`手游助手授权回调失败 (HTTP ${callback.status})`);

        const creds = parseEnvelopeCredentials(callback.body, hopCookies) as GaCredentials;
        if (!creds.openid || !creds.accesstoken) {
            throw new Error(`手游助手凭据缺失（openid/accesstoken 均未取得，回调 cookie: ${Array.from(hopCookies.keys()).join(',') || '无'}）`);
        }
        // scope 仅警告不阻断：网关回包的 scope 形态存在编码/子集差异，凭据可用性由后续 login_buffer 实际校验
        const scope = String(creds.scope || '');
        if (scope && !scope.split(',').some(s => s.trim() === 'snsapi_runtime_pcsdk')) {
            console.warn(`[gameassist] scope 子集告警: "${scope}"（cookie: ${Array.from(hopCookies.keys()).join(',')}）`);
        }
        const expiresIn = Number(creds.expires_in) > 0 ? Number(creds.expires_in) : 7200;
        return {
            openid: creds.openid,
            accesstoken: creds.accesstoken,
            refreshtoken: String(creds.refreshtoken || ''),
            nickname: creds.nickname || undefined,
            scope: scope || 'snsapi_login,snsapi_runtime_pcsdk',
            expires_in: expiresIn,
            expires_at: creds.expires_at && Number(creds.expires_at) > 0 ? Number(creds.expires_at) : Date.now() + expiresIn * 1000,
        };
    }

    destroy(session: GaLoginSession): void {
        session.cookies.clear();
        session.oauthCode = undefined;
    }
}

function signedHeaders(payload: string, businessid: string): Record<string, string> {
    const timestamp = String(Date.now());
    const nonce = String(crypto.randomInt(1000, 10000));
    const signature = crypto.createHash('md5').update(`${payload}${timestamp}${LOGIN_BUFFER_ACCESS_KEY}${nonce}`).digest('hex');
    return {
        'Content-Type': 'application/json',
        'Ual-Access-Businessid': businessid,
        'Ual-Access-Timestamp': timestamp,
        'Ual-Access-Nonce': nonce,
        'Ual-Access-Signature': signature,
    };
}

async function postJson(url: string, payload: string, businessid: string): Promise<any> {
    const response = await fetch(url, {
        method: 'POST',
        headers: signedHeaders(payload, businessid),
        body: payload,
        signal: AbortSignal.timeout(35_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`手游助手接口返回 HTTP ${response.status}`);
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('手游助手接口返回非 JSON 数据');
    }
}

/** syzs 专线刷新：令牌不滚动，仅续期 expiresIn（官方客户端每 2 小时一次）。 */
export async function refreshGaCredential(record: { openid: string, accesstoken: string, refreshtoken: string }): Promise<{ expires_in: number, expires_at: number, accesstoken: string, refreshtoken: string }> {
    const payload = JSON.stringify({
        userInfo: {
            openId: record.openid,
            refreshToken: record.refreshtoken,
            accessToken: record.accesstoken,
            loginType: 'WX',
        },
    });
    const data = await postJson(GA_REFRESH_URL, payload, 'syzslogin');
    if (Number(data?.code) !== 0) {
        throw new Error(`手游助手凭据续期失败: code=${String(data?.code)} msg=${String(data?.msg || '')}`);
    }
    const info = data.userInfo || data.user_info || {};
    const expiresIn = Number(info.expiresIn ?? info.expires_in ?? 0) > 0
        ? Number(info.expiresIn ?? info.expires_in)
        : 7200;
    return {
        expires_in: expiresIn,
        expires_at: Date.now() + expiresIn * 1000,
        accesstoken: String(info.accessToken || info.access_token || record.accesstoken),
        refreshtoken: String(info.refreshToken || info.refresh_token || record.refreshtoken),
    };
}

/** syzs check-login：刷新被拒时追问会话是否仍有效。 */
export async function checkGaLogin(record: { openid: string, accesstoken: string, refreshtoken: string }): Promise<boolean> {
    try {
        const payload = JSON.stringify({
            userInfo: {
                openId: record.openid,
                refreshToken: record.refreshtoken,
                accessToken: record.accesstoken,
                loginType: 'WX',
            },
        });
        const data = await postJson(GA_CHECK_LOGIN_URL, payload, 'syzslogin');
        return Number(data?.code) === 0;
    } catch {
        return false;
    }
}

/** 用 syzs 凭据换 login_buffer（复用应用宝 pc_yyb_auth 路径，同网关同 host 身份）。 */
export async function issueGaFarmCode(creds: { openid: string, accesstoken: string }): Promise<string> {
    const payload = JSON.stringify({
        extInfo: {
            listS: {
                unionid: { value: [creds.openid] },
                user_id: { value: [creds.openid] },
                access_token: { value: [creds.accesstoken] },
            },
            listI: { user_type: { value: [0] } },
        },
    });
    const data = await postJson(LOGIN_BUFFER_URL, payload, 'pc_yyb_auth');
    const loginBuffer = data?.code === 0 ? data?.ext_info?.list_s?.login_buffer?.value?.[0] : '';
    if (typeof loginBuffer !== 'string' || !loginBuffer) {
        throw new Error(`手游助手 login_buffer 签发失败: code=${String(data?.code)} msg=${String(data?.msg || '')}`);
    }
    return getNativeWxLoginCode(loginBuffer, TARGET_APP_ID);
}
