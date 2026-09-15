// @ts-nocheck
export {};
/**
 * 登录 Code / openID 提取器
 *
 * QQ 农场小程序打开时，会将 `qq.login()` 拿到的登录码放进
 * 网关 WebSocket 地址（如 `wss://gate-obt.nqf.qq.com/prod/ws?platform=...&code=<CODE>&openID=`）。
 * 中间人代理抓取到该请求后，用本模块从请求头/正文中提取 code 与 openID。
 *
 * 规则：
 * - 网关域名（*.nqf.qq.com）上的任意非空 code 直接采用；
 * - 其他抓取域名上，code 长度 >= 16 才采用（避免 URL 追踪参数等噪声）；
 * - WebSocket 升级请求的 code 一律放宽长度要求；
 * - 同时尝试从 JSON 请求体中提取 code/openid（限长 1MB）。
 */

const MAX_BODY_SCAN_BYTES = 1024 * 1024;

const WHITESPACE_RE = /\s+/;
const WEBSOCKET_UPGRADE_RE = /^websocket$/i;
const TRAILING_DOT_RE = /\.$/;
const NOISE_CODE_RE = /^(?:0|1|true|false|null|undefined)$/i;

/** 解析 HTTP 请求头（截止 \r\n\r\n），返回结构化对象或 null */
function parseHttpHead(buffer) {
  if (!buffer || buffer.length === 0) return null;
  const text = buffer.toString('latin1');
  const headerEnd = text.indexOf('\r\n\r\n');
  const block = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const lines = block.split('\r\n');
  const requestLine = (lines[0] || '').trim();
  if (!requestLine) return null;

  const parts = requestLine.split(WHITESPACE_RE);
  if (parts.length < 2) return null;
  const method = parts[0].toUpperCase();
  const target = parts[1];

  const headers = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!headers[key]) headers[key] = value;
  }

  return {
    method,
    target,
    version: parts[2] || 'HTTP/1.1',
    headers,
    headerEnd,
    isUpgrade: WEBSOCKET_UPGRADE_RE.test(headers.upgrade || ''),
  };
}

/** 从 URL/目标字符串提取查询参数
 * @returns {Map<string, string>} 查询参数映射 */
function extractQuery(target) {
  const params = new Map();
  if (!target || typeof target !== 'string') return params;
  const queryIndex = target.indexOf('?');
  if (queryIndex < 0) return params;
  const query = target.slice(queryIndex + 1);
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    let value = part.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // 保留原始值
    }
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

/** 通配域名匹配：`*.nqf.qq.com` 同时匹配裸域 `nqf.qq.com` 与任意子域 */
function matchesHostPattern(host, pattern) {
  const normalizedHost = String(host || '').toLowerCase().replace(TRAILING_DOT_RE, '');
  const normalizedPattern = String(pattern || '').toLowerCase().replace(TRAILING_DOT_RE, '');
  if (!normalizedHost || !normalizedPattern) return false;
  if (normalizedHost === normalizedPattern) return true;
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost.endsWith(`.${suffix}`) || normalizedHost === suffix;
  }
  return false;
}

function matchesAnyHostPattern(host, patterns) {
  return (Array.isArray(patterns) ? patterns : []).some(pattern => matchesHostPattern(host, pattern));
}

function isGatewayHost(host, config) {
  const gatewayPatterns = Array.isArray(config?.gatewayHosts)
    ? config.gatewayHosts
    : ['*.nqf.qq.com'];
  return matchesAnyHostPattern(host, gatewayPatterns);
}

function isCaptureHost(host, config) {
  return matchesAnyHostPattern(host, config?.captureHosts || []);
}

function isValidCode(code, { gatewayHost, isUpgrade } = {}) {
  const value = String(code || '');
  if (value.length < 4) return false;
  // 常见噪声：纯数字短串、布尔值
  if (NOISE_CODE_RE.test(value)) return false;
  if (gatewayHost || isUpgrade) return true;
  return value.length >= 16;
}

/** 深扫 JSON 对象，收集 code/openid 字符串字段 */
function scanJsonBody(text) {
  const result = { code: '', openId: '' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  const stack = [parsed];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string') {
        const lower = key.toLowerCase();
        if (lower === 'code' && !result.code) result.code = value;
        if ((lower === 'openid' || lower === 'open_id') && !result.openId) result.openId = value;
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
  return result;
}

/**
 * 从 HTTP 请求中提取登录信息
 * @param {object} input
 * @param {string} input.host - 连接的目标主机（CONNECT 行解析结果）
 * @param {Buffer|string} [input.head] - 已解析的请求头字节
 * @param {object} [input.parsedHead] - parseHttpHead 的解析结果（优先）
 * @param {Buffer|string} [input.body] - 请求体（可选）
 * @param {object} [input.config] - 抓包服务配置（captureHosts/gatewayHosts）
 * @returns {{ code: string, openId: string, matched: boolean }} 提取到的登录信息
 */
function extractLoginInfo({ host, head, parsedHead, body, config = {} }) {
  const info = { code: '', openId: '', matched: false };
  if (!host) return info;

  const parsed = parsedHead || (head ? parseHttpHead(Buffer.isBuffer(head) ? head : Buffer.from(head)) : null);
  if (!parsed) return info;

  const gatewayHost = isGatewayHost(host, config);
  const isUpgrade = parsed.isUpgrade;
  const params = extractQuery(parsed.target);

  const code = params.get('code') || '';
  if (code && isValidCode(code, { gatewayHost, isUpgrade })) {
    info.code = code;
  }

  const openId = params.get('openID') || params.get('openid') || '';
  if (openId) info.openId = openId;

  // 尝试从请求体提取
  if (body && body.length > 0 && (!info.code || !info.openId)) {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    if (text.length <= MAX_BODY_SCAN_BYTES) {
      const bodyInfo = scanJsonBody(text);
      if (!info.code && bodyInfo.code && isValidCode(bodyInfo.code, { gatewayHost, isUpgrade })) {
        info.code = bodyInfo.code;
      }
      if (!info.openId && bodyInfo.openId) info.openId = bodyInfo.openId;
    }
  }

  info.matched = !!(info.code || info.openId);
  return info;
}

module.exports = {
  extractLoginInfo,
  extractQuery,
  isCaptureHost,
  isGatewayHost,
  isValidCode,
  matchesAnyHostPattern,
  matchesHostPattern,
  parseHttpHead,
  scanJsonBody,
};
