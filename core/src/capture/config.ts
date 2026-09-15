// @ts-nocheck
export {};
/**
 * 抓包服务配置
 *
 * 配置文件位于 <dataDir>/capture/config.json，首次启动自动生成默认配置。
 * 环境变量优先级最高，可覆盖配置文件（适用于 Docker/二进制部署）。
 *
 * 环境变量：
 * - CAPTURE_API_HOST / CAPTURE_API_PORT / CAPTURE_API_TOKEN
 * - CAPTURE_PROXY_BIND      逗号分隔，代理监听 IP（默认 0.0.0.0）
 * - CAPTURE_ADVERTISE_IPS   逗号分隔，对外公布的 IP（'auto' 表示自动检测）
 * - CAPTURE_PREFER_ORDER    逗号分隔，排序优先级 tailscale,lan,other
 * - CAPTURE_PORTS           代理端口，如 "18000"（兼容旧范围写法，实际只取首个端口）
 * - CAPTURE_HOSTS           逗号分隔，需要中间人抓取的域名（支持 *. 通配）
 * - CAPTURE_AUTOSTOP_SEC    代理自动停止秒数
 * - CAPTURE_SESSION_TTL_MS  会话过期时间
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/;

const DEFAULT_CONFIG = Object.freeze({
  apiHost: '127.0.0.1',
  apiPort: 8450,
  apiToken: '',
  proxyBind: ['0.0.0.0'],
  advertiseIps: ['auto'],
  preferOrder: ['tailscale', 'lan', 'other'],
  proxyPortFrom: 18000,
  proxyPortTo: 18000,
  captureHosts: [
    '*.nqf.qq.com',
    'q.qq.com',
    '*.qzone.qq.com',
    '*.qq.com',
  ],
  autoStopSec: 900,
  sessionTtlMs: 60 * 60 * 1000,
  logLevel: 'info',
});

/** 默认数据目录（与 bot 完全一致：FARM_DATA_DIR 优先，pkg 模式用 exe 同级 data） */
function getDefaultDataDir() {
  if (process.env.CAPTURE_DATA_DIR) return path.resolve(process.env.CAPTURE_DATA_DIR);
  // 复用 bot 的运行时路径解析，保证嵌入模式与独立模式的 CA/配置落点一致
  try {
    const { getDataDir } = require('../config/runtime-paths');
    return getDataDir();
  } catch {
    return path.join(__dirname, '../../data');
  }
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parsePortRange(value, fallbackFrom, fallbackTo) {
  const match = String(value || '').match(PORT_RANGE_RE);
  if (!match) return { from: Number(fallbackFrom), to: Number(fallbackTo) };
  const from = Number.parseInt(match[1], 10);
  const to = match[2] === undefined ? from : Number.parseInt(match[2], 10);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1024 || to > 65535 || from > to) {
    return { from: Number(fallbackFrom), to: Number(fallbackTo) };
  }
  return { from, to: from };
}

function applyEnvOverrides(config) {
  const env = process.env;
  const next = { ...config };

  if (env.CAPTURE_API_HOST !== undefined) next.apiHost = String(env.CAPTURE_API_HOST).trim();
  if (env.CAPTURE_API_PORT !== undefined) next.apiPort = Number.parseInt(env.CAPTURE_API_PORT, 10);
  if (env.CAPTURE_API_TOKEN !== undefined) next.apiToken = String(env.CAPTURE_API_TOKEN).trim();
  if (env.CAPTURE_PROXY_BIND !== undefined) next.proxyBind = splitList(env.CAPTURE_PROXY_BIND);
  if (env.CAPTURE_ADVERTISE_IPS !== undefined) next.advertiseIps = splitList(env.CAPTURE_ADVERTISE_IPS);
  if (env.CAPTURE_PREFER_ORDER !== undefined) next.preferOrder = splitList(env.CAPTURE_PREFER_ORDER);
  if (env.CAPTURE_HOSTS !== undefined) next.captureHosts = splitList(env.CAPTURE_HOSTS);
  if (env.CAPTURE_PORTS !== undefined) {
    const range = parsePortRange(env.CAPTURE_PORTS, next.proxyPortFrom, next.proxyPortTo);
    next.proxyPortFrom = range.from;
    next.proxyPortTo = range.to;
  }
  if (env.CAPTURE_AUTOSTOP_SEC !== undefined) {
    next.autoStopSec = Math.max(60, Number.parseInt(env.CAPTURE_AUTOSTOP_SEC, 10) || DEFAULT_CONFIG.autoStopSec);
  }
  if (env.CAPTURE_SESSION_TTL_MS !== undefined) {
    next.sessionTtlMs = Math.max(60_000, Number.parseInt(env.CAPTURE_SESSION_TTL_MS, 10) || DEFAULT_CONFIG.sessionTtlMs);
  }
  return next;
}

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const proxyPort = Number.parseInt(input.proxyPortFrom ?? DEFAULT_CONFIG.proxyPortFrom, 10) || DEFAULT_CONFIG.proxyPortFrom;
  return {
    ...DEFAULT_CONFIG,
    ...input,
    apiHost: String(input.apiHost ?? DEFAULT_CONFIG.apiHost).trim() || DEFAULT_CONFIG.apiHost,
    apiPort: Number.parseInt(input.apiPort ?? DEFAULT_CONFIG.apiPort, 10) || DEFAULT_CONFIG.apiPort,
    apiToken: String(input.apiToken ?? '').trim(),
    proxyBind: splitList(input.proxyBind ?? DEFAULT_CONFIG.proxyBind),
    advertiseIps: splitList(input.advertiseIps ?? DEFAULT_CONFIG.advertiseIps),
    preferOrder: splitList(input.preferOrder ?? DEFAULT_CONFIG.preferOrder),
    captureHosts: splitList(input.captureHosts ?? DEFAULT_CONFIG.captureHosts),
    proxyPortFrom: proxyPort,
    proxyPortTo: proxyPort,
    autoStopSec: Math.max(60, Number.parseInt(input.autoStopSec ?? DEFAULT_CONFIG.autoStopSec, 10) || DEFAULT_CONFIG.autoStopSec),
    sessionTtlMs: Math.max(60_000, Number.parseInt(input.sessionTtlMs ?? DEFAULT_CONFIG.sessionTtlMs, 10) || DEFAULT_CONFIG.sessionTtlMs),
    logLevel: String(input.logLevel ?? DEFAULT_CONFIG.logLevel),
  };
}

function getConfigPath(dataDir) {
  return path.join(dataDir, 'capture', 'config.json');
}

function loadConfig(options = {}) {
  const dataDir = options.dataDir || getDefaultDataDir();
  const configPath = getConfigPath(dataDir);

  let fileConfig = {};
  try {
    if (fs.existsSync(configPath)) {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (error) {
    // 配置损坏时回退默认值
    fileConfig = { loadError: error.message };
  }

  const config = normalizeConfig(fileConfig);
  const finalConfig = applyEnvOverrides(config);

  // 首次启动写入默认配置，便于用户编辑
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    }
  } catch {
    // 无写权限时忽略
  }

  return { config: finalConfig, dataDir, configPath };
}

function saveConfig(config, dataDir) {
  const targetDir = dataDir || getDefaultDataDir();
  const configPath = getConfigPath(targetDir);
  const normalized = normalizeConfig(config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function getHostname() {
  return os.hostname();
}

module.exports = {
  DEFAULT_CONFIG,
  applyEnvOverrides,
  getConfigPath,
  getDefaultDataDir,
  getHostname,
  loadConfig,
  normalizeConfig,
  parsePortRange,
  saveConfig,
  splitList,
};
