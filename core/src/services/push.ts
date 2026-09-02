export {};
/**
 * 推送接口封装（基于 pushoo）
 */

const crypto = require('node:crypto');
const axios = require('axios').default;
const pushoo = require('pushoo').default;

const DINGTALK_WEBHOOK_PREFIX = 'https://oapi.dingtalk.com/robot/send?access_token=';
const MEOW_DEFAULT_BASE_URL = 'https://api.chuckfang.com';

function assertRequiredText(name: string, value: any): string {
    const text: string = String(value || '').trim();
    if (!text) {
        throw new Error(`${name} 不能为空`);
    }
    return text;
}

function createDingTalkSign(secretInput: any, timestampInput: any): string {
    const secret = assertRequiredText('钉钉加签密钥', secretInput);
    const timestamp = Math.trunc(Number(timestampInput));
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error('钉钉加签时间戳无效');
    }
    return crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${secret}`, 'utf8')
        .digest('base64');
}

function buildDingTalkWebhook(endpointInput: any, tokenInput: any, secretInput: any = '', timestampInput: any = Date.now()): string {
    const endpoint = String(endpointInput || '').trim();
    const token = String(tokenInput || '').trim();
    const credential = assertRequiredText('钉钉 Webhook 地址', endpoint || token);
    const rawUrl = /^https?:\/\//i.test(credential)
        ? credential
        : `${DINGTALK_WEBHOOK_PREFIX}${encodeURIComponent(credential)}`;

    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('钉钉 Webhook 地址格式无效');
    }
    const isOfficialWebhook = url.protocol === 'https:'
        && url.hostname.toLowerCase() === 'oapi.dingtalk.com'
        && url.pathname === '/robot/send'
        && !!url.searchParams.get('access_token');
    if (!isOfficialWebhook) {
        throw new Error('钉钉 Webhook 地址格式无效');
    }

    const secret = String(secretInput || '').trim();
    if (secret) {
        const timestamp = Math.trunc(Number(timestampInput));
        const sign = createDingTalkSign(secret, timestamp);
        url.searchParams.set('timestamp', String(timestamp));
        url.searchParams.set('sign', sign);
    }
    return url.toString();
}

async function sendDingTalkMessage(payload: any): Promise<any> {
    const url = buildDingTalkWebhook(payload.endpoint, payload.token, payload.secret);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);
    const response = await axios.post(url, {
        msgtype: 'text',
        text: {
            content: `${title}\n${content}`,
        },
    });
    return response.data;
}

/**
 * 发送 MeoW 推送（鸿蒙 MeoW 消息推送 API）
 * @param payload
 * @param payload.token 必填 用户昵称（作为路径参数）
 * @param payload.endpoint 可选 自定义接口地址（默认 https://api.chuckfang.com）
 * @param payload.title 必填 推送标题
 * @param payload.content 必填 推送内容
 * @returns MeoW 推送结果
 */
async function sendMeowMessage(payload: any): Promise<any> {
    const nickname = assertRequiredText('MeoW 昵称', payload.token);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);
    const baseUrl = String(payload.endpoint || MEOW_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error('MeoW 接口地址格式无效');
    }
    const url = `${baseUrl}/${encodeURIComponent(nickname)}`;
    const response = await axios.post(url, {
        title,
        msg: content,
    });
    const data: any = (response && response.data && typeof response.data === 'object') ? response.data : {};
    const status: number = Number(data.status);
    if (Number.isFinite(status) && status !== 200) {
        // MeoW 业务状态码非 200 视为失败，转为 error 结构便于统一结果判断
        return {
            status,
            error: {
                message: String(data.msg || data.message || 'MeoW 推送失败'),
            },
        };
    }
    return data;
}

/**
 * 发送推送
 * @param payload
 * @param payload.channel 必填 推送渠道（pushoo 平台名，如 webhook）
 * @param payload.endpoint Webhook 接口地址（webhook、dingtalk 渠道使用）
 * @param payload.token 除 webhook、dingtalk 外的渠道必填；兼容旧版钉钉 access token
 * @param payload.secret 钉钉机器人加签密钥（可选）
 * @param payload.title 必填 推送标题
 * @param payload.content 必填 推送内容
 * @returns 推送结果
 */
async function sendPushooMessage(payload: any = {}): Promise<{ ok: boolean; code: string; msg: string; raw: any }> {
    const channel: string = assertRequiredText('channel', payload.channel);
    const endpoint: string = String(payload.endpoint || '').trim();
    const rawToken: string = String(payload.token || '').trim();
    const secret: string = String(payload.secret || '').trim();
    const token: string = channel === 'webhook' || channel === 'dingtalk'
        ? rawToken
        : assertRequiredText('token', rawToken);
    const title: string = assertRequiredText('title', payload.title);
    const content: string = assertRequiredText('content', payload.content);

    const options: any = {};
    if (channel === 'webhook') {
        const url: string = assertRequiredText('endpoint', endpoint);
        options.webhook = { url, method: 'POST' };
    }

    const request: any = { title, content };
    if (token) request.token = token;
    if (channel === 'webhook') request.options = options;

    const result: any = channel === 'dingtalk'
        ? await sendDingTalkMessage({ endpoint, token, secret, title, content })
        : channel === 'meow'
            ? await sendMeowMessage({ endpoint, token, title, content })
            : await pushoo(channel, request);

    const raw: any = (result && typeof result === 'object') ? result : { data: result };
    const hasError: boolean = !!(raw && raw.error);
    const code: string = String(raw.code || raw.errcode || (hasError ? 'error' : 'ok'));
    const message: string = String(raw.msg || raw.errmsg || raw.message || (hasError ? (raw.error.message || 'push failed') : 'ok'));
    const ok: boolean = !hasError && (code === 'ok' || code === '0' || code === '' || String(raw.status || '').toLowerCase() === 'success');

    return {
        ok,
        code,
        msg: message,
        raw,
    };
}

module.exports = {
    buildDingTalkWebhook,
    createDingTalkSign,
    sendMeowMessage,
    sendPushooMessage,
};
