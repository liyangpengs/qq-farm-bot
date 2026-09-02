"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WxLoginService = exports.TARGET_APP_ID = void 0;
exports.putLoginBufferByCode = putLoginBufferByCode;
exports.takeLoginBufferByCode = takeLoginBufferByCode;
exports.reissueWxLoginCode = reissueWxLoginCode;
const node_crypto_1 = __importDefault(require("node:crypto"));
const native_protocol_1 = require("./native-protocol");
const QR_CONNECT_URL = 'https://open.weixin.qq.com/connect/qrconnect';
const QR_IMAGE_BASE = 'https://open.weixin.qq.com/connect/qrcode/';
const QR_POLL_URL = 'https://long.open.weixin.qq.com/connect/l/qrconnect';
const CALLBACK_URL = 'https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_oauth';
const LOGIN_BUFFER_URL = 'https://yybadaccess.3g.qq.com/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth';
const OAUTH_APP_ID = 'wxd44977328b36e647';
exports.TARGET_APP_ID = 'wx5306c5978fdb76e4';
const USER_AGENT = 'Mozilla/5.0';
const LOGIN_BUFFER_ACCESS_KEY = 'wgrdg373hy26ww2';
// 一次性 code → loginBuffer 缓存：扫码换取的 code 在添加账号时用于关联长效登录凭证
const codeLoginBuffers = new Map();
function putLoginBufferByCode(code, loginBuffer) {
    if (code && loginBuffer)
        codeLoginBuffers.set(code, loginBuffer);
}
function takeLoginBufferByCode(code) {
    if (!code)
        return '';
    const buffer = codeLoginBuffers.get(code);
    codeLoginBuffers.delete(code);
    return buffer || '';
}
async function reissueWxLoginCode(loginBuffer, appId) {
    return (0, native_protocol_1.getNativeWxLoginCode)(loginBuffer, appId);
}
function cookieHeader(cookies) {
    return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}
function storeCookies(cookies, headers) {
    const headerValue = headers.get('set-cookie');
    const values = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : headerValue ? [headerValue] : [];
    for (const value of values) {
        const pair = value.split(';', 1)[0].trim();
        const separator = pair.indexOf('=');
        if (separator > 0)
            cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
}
async function request(url, cookies, init = {}, timeout = 35_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        let currentUrl = url;
        let method = init.method || 'GET';
        let body = init.body;
        for (let redirects = 0; redirects <= 5; redirects++) {
            const headers = new Headers(init.headers);
            headers.set('User-Agent', USER_AGENT);
            if (cookies.size)
                headers.set('Cookie', cookieHeader(cookies));
            const response = await fetch(currentUrl, { ...init, method, body, headers, redirect: 'manual', signal: controller.signal });
            storeCookies(cookies, response.headers);
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
    }
    finally {
        clearTimeout(timer);
    }
}
function requiredCookie(cookies, name) {
    const value = cookies.get(name);
    if (!value)
        throw new Error(`WeChat OAuth callback did not provide ${name}`);
    return value;
}
class WxLoginService {
    async createQrSession() {
        const cookies = new Map();
        const params = new URLSearchParams({
            appid: OAUTH_APP_ID,
            redirect_uri: `${CALLBACK_URL}?login_type=WX`,
            response_type: 'code',
            scope: 'snsapi_login,snsapi_runtime_pcsdk',
            state: 'web',
            fast_login: '1',
            self_redirect: 'true',
        });
        const page = await request(`${QR_CONNECT_URL}?${params}`, cookies);
        if (page.status < 200 || page.status >= 300)
            throw new Error(`Unable to create WeChat QR session (HTTP ${page.status})`);
        const uuid = /\/connect\/qrcode\/([^"'>\s]+)/.exec(page.body.toString('utf8'))?.[1];
        if (!uuid)
            throw new Error('Unable to parse the WeChat QR session');
        const qr = await request(`${QR_IMAGE_BASE}${encodeURIComponent(uuid)}`, cookies);
        if (qr.status < 200 || qr.status >= 300)
            throw new Error(`Unable to download WeChat QR image (HTTP ${qr.status})`);
        return { session: { cookies, uuid }, qr: qr.body };
    }
    async poll(session) {
        if (session.oauthCode)
            return 'authorized';
        const params = new URLSearchParams({ uuid: session.uuid, _: String(Date.now()) });
        const response = await request(`${QR_POLL_URL}?${params}`, session.cookies, {}, 35_000);
        if (response.status < 200 || response.status >= 300)
            throw new Error(`WeChat QR polling failed (HTTP ${response.status})`);
        const body = response.body.toString('utf8');
        const errcode = /wx_errcode\s*=\s*(\d+)/.exec(body)?.[1];
        if (errcode === '408')
            return 'waiting';
        if (errcode === '404')
            return 'scanned';
        if (errcode === '403')
            return 'cancelled';
        if (errcode === '402')
            return 'expired';
        if (errcode === '405') {
            const code = /wx_code\s*=\s*'([^']+)'/.exec(body)?.[1];
            if (!code)
                throw new Error('WeChat authorization response did not include a code');
            session.oauthCode = code;
            return 'authorized';
        }
        throw new Error('Unrecognized WeChat QR polling response');
    }
    async confirm(session) {
        if (!session.oauthCode)
            throw new Error('Waiting for scan authorization');
        const params = new URLSearchParams({ login_type: 'WX', code: session.oauthCode, state: 'web' });
        const callback = await request(`${CALLBACK_URL}?${params}`, session.cookies);
        if (callback.status < 200 || callback.status >= 400)
            throw new Error(`WeChat authorization callback failed (HTTP ${callback.status})`);
        const openid = requiredCookie(session.cookies, 'openid');
        const accessToken = requiredCookie(session.cookies, 'accesstoken');
        const payload = JSON.stringify({ extInfo: { listS: { unionid: { value: [openid] }, user_id: { value: [openid] }, access_token: { value: [accessToken] } }, listI: { user_type: { value: [0] } } } });
        const timestamp = String(Date.now());
        const nonce = String(node_crypto_1.default.randomInt(1000, 10000));
        const signature = node_crypto_1.default.createHash('md5').update(`${payload}${timestamp}${LOGIN_BUFFER_ACCESS_KEY}${nonce}`).digest('hex');
        const response = await request(LOGIN_BUFFER_URL, session.cookies, {
            method: 'POST', body: payload,
            headers: { 'Content-Type': 'application/json', 'Ual-Access-Businessid': 'pc_yyb_auth', 'Ual-Access-Timestamp': timestamp, 'Ual-Access-Nonce': nonce, 'Ual-Access-Signature': signature },
        });
        if (response.status < 200 || response.status >= 300)
            throw new Error(`Unable to obtain WeChat login buffer (HTTP ${response.status})`);
        const data = JSON.parse(response.body.toString('utf8'));
        const loginBuffer = data?.code === 0 ? data?.ext_info?.list_s?.login_buffer?.value?.[0] : '';
        if (typeof loginBuffer !== 'string' || !loginBuffer)
            throw new Error('WeChat login buffer response is invalid');
        session.cookies.clear();
        session.openid = openid;
        session.loginBuffer = loginBuffer;
        return { openid, loginBuffer };
    }
    async issueCode(session, appId) {
        if (!session.loginBuffer)
            throw new Error('WeChat login session has not been confirmed');
        return (0, native_protocol_1.getNativeWxLoginCode)(session.loginBuffer, appId);
    }
    destroy(session) {
        session.cookies.clear();
        session.oauthCode = undefined;
        session.openid = undefined;
        session.loginBuffer = undefined;
    }
}
exports.WxLoginService = WxLoginService;
//# sourceMappingURL=service.js.map