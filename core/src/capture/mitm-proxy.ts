// @ts-nocheck
export {};
/**
 * 选择性 MITM 代理
 *
 * 每次抓包会话只使用配置的单个代理端口（默认 18000），按配置的 IP
 * （局域网 / Tailscale）监听。处理 iPhone 的 HTTP 代理连接：
 *
 * - CONNECT 到抓取域名（captureHosts）→ TLS 中间人，解析 HTTP 头提取登录 code，
 *   升级为 WebSocket 后解析二进制帧提取好友 GID；
 * - CONNECT 到其他域名（含 bypassHosts）→ 原始 TCP 隧道（不解密）；
 * - 明文 HTTP（绝对 URL 形式）→ 直接转发。
 *
 * 中间人链路：clientTLS <-> upstreamTLS。握手完成后两侧透明转发，
 * 服务器→客户端数据额外复制一份给 WebSocket 帧解析器。
 *
 * 注意：iPhone 的 HTTP 代理要求客户端先收到 CONNECT 的 200 响应后才会发起
 * TLS 握手，因此不会出现 CONNECT 请求后紧跟 TLS 数据的分包问题；若确实出现
 * 管道化数据（极少见），中间人路径会安全拒绝该连接。
 */

const net = require('node:net');
const tls = require('node:tls');
const { extractLoginInfo, isCaptureHost, parseHttpHead } = require('./code-extractor');
const { WsFrameParser } = require('./ws-parser');

const MAX_CONNECT_HEAD_BYTES = 64 * 1024;

const CONNECT_RE = /^CONNECT$/i;
const BRACKETED_IP_RE = /^\[|\]$/g;
const ABSOLUTE_URL_RE = /^https?:\/\//i;
const WHITESPACE_RE = /\s+/;
const HTTP_101_RE = /^HTTP\/1\.[01]\s+101/i;
const HANDSHAKE_TIMEOUT_MS = 15_000;

function parseConnectLine(firstLine) {
  const parts = String(firstLine || '').split(WHITESPACE_RE);
  if (parts.length < 2 || !CONNECT_RE.test(parts[0])) return null;
  const target = parts[1];
  const lastColon = target.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === target.length - 1) return null;
  let host = target.slice(0, lastColon).replace(BRACKETED_IP_RE, '');
  const port = Number.parseInt(target.slice(lastColon + 1), 10);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  host = host.split('@').pop();
  return { host, port };
}

/** 解析绝对 URL（明文 HTTP 代理形式） */
function parseAbsoluteUrl(target) {
  if (!target || !ABSOLUTE_URL_RE.test(target)) return null;
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    isHttps: url.protocol === 'https:',
  };
}

/** 查找请求头结束位置（body 起始偏移），支持 \r\n\r\n 与 \n\n，未找到返回 -1 */
function findHeadEnd(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  if (crlf >= 0) return crlf + 4;
  const lf = buffer.indexOf('\n\n');
  if (lf >= 0) return lf + 2;
  return -1;
}

/**
 * 创建 MITM 代理管理器
 * @param {object} deps
 * @param {object} deps.config - 抓包服务配置（proxyBind/proxyPortFrom/autoStopSec/captureHosts）
 * @param {object} deps.ca - CA 模块（getSecureContextForHost）
 * @param {object} deps.friendExtractor - createFriendExtractor() 的结果
 * @param {object} deps.sessionStore - 会话存储
 * @param {Function} deps.log - (level, message, extra)
 */
function createMitmProxyManager(deps = {}) {
  const { config, ca, friendExtractor, sessionStore, log = () => {} } = deps;
  const activeServers = new Map(); // sessionId -> { port, servers, stop, autoStopTimer }

  async function listenOnConfiguredPort(bindTargets, handler) {
    const port = Number(config.proxyPortFrom) || 18000;
    const servers = [];

    for (const bindIp of bindTargets) {
      const server = net.createServer(handler);
      server.on('error', () => {});
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.removeListener('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, bindIp);
        });
        servers.push(server);
      } catch (error) {
        for (const s of servers) s.close();
        throw new Error(`代理端口 ${port} 不可用: ${error.message}`);
      }
    }

    return { port, servers };
  }

  /**
   * 为一个会话启动 MITM 代理
   * @returns {Promise<{ port: number, startedAt: string, bypassHosts: string[] }>} 代理端口与启动信息
   */
  async function startForSession(session, { bypassHosts = [] } = {}) {
    await stopForSession(session);

    const bypass = Array.isArray(bypassHosts)
      ? bypassHosts.map(h => String(h || '').toLowerCase().replace(BRACKETED_IP_RE, '')).filter(Boolean)
      : [];

    const bindTargets = Array.isArray(config.proxyBind) && config.proxyBind.length > 0
      ? config.proxyBind
      : ['0.0.0.0'];

    const handler = rawSocket => handleClient(rawSocket, session, bypass);

    const { port, servers } = await listenOnConfiguredPort(bindTargets, handler);
    const startedAt = new Date().toISOString();

    const entry = { port, servers, startedAt, autoStopTimer: null };
    const stop = () => {
      if (entry.autoStopTimer) clearTimeout(entry.autoStopTimer);
      for (const server of servers) server.close();
      if (activeServers.get(session.id) === entry) activeServers.delete(session.id);
    };
    entry.stop = stop;
    activeServers.set(session.id, entry);

    // 自动停止兜底
    const autoStopMs = (config.autoStopSec || 900) * 1000;
    entry.autoStopTimer = setTimeout(() => {
      log('info', `抓包代理自动停止: 会话 ${session.id}`, { sessionId: session.id });
      stop();
    }, autoStopMs);
    if (entry.autoStopTimer.unref) entry.autoStopTimer.unref();

    log('info', `抓包代理已启动: 端口 ${port}，会话 ${session.id}`, {
      sessionId: session.id,
      port,
      bindTargets,
    });

    return { port, startedAt, bypassHosts: bypass };
  }

  function stopForSession(session) {
    return new Promise((resolve) => {
      const entry = activeServers.get(session.id);
      if (!entry) {
        resolve();
        return;
      }
      if (entry.autoStopTimer) clearTimeout(entry.autoStopTimer);
      for (const server of entry.servers) server.close();
      activeServers.delete(session.id);
      log('info', `抓包代理已停止: 会话 ${session.id}`, { sessionId: session.id });
      resolve();
    });
  }

  function handleClient(rawSocket, session, bypassHosts) {
    rawSocket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let settled = false;

    const onData = (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.length > MAX_CONNECT_HEAD_BYTES) {
        rawSocket.destroy();
        return;
      }

      const headEnd = findHeadEnd(buffer);
      if (headEnd < 0) return;

      settled = true;
      rawSocket.removeListener('data', onData);

      const head = buffer.toString('latin1', 0, headEnd);
      const rest = buffer.subarray(headEnd);
      const firstLine = head.split('\r\n')[0] || '';

      const connect = parseConnectLine(firstLine);
      if (connect) {
        handleConnect(rawSocket, connect, rest, session, bypassHosts);
        return;
      }

      const target = (firstLine.split(WHITESPACE_RE)[1] || '').trim();
      const absolute = parseAbsoluteUrl(target);
      if (absolute) {
        handlePlainHttp(rawSocket, absolute, head, rest, session, bypassHosts);
        return;
      }

      rawSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      rawSocket.destroy();
    };

    rawSocket.on('data', onData);
    rawSocket.on('error', () => {});
  }

  function handleConnect(rawSocket, { host, port }, rest, session, bypassHosts) {
    const isBypass = bypassHosts.includes(host);
    const shouldMitm = !isBypass && isCaptureHost(host, config);

    if (!shouldMitm) {
      startTunnel(rawSocket, { host, port }, rest);
      return;
    }

    if (rest.length > 0) {
      sessionStore.setProxyError(session, `中间人无法处理管道化数据: ${host}`);
      rawSocket.destroy();
      return;
    }

    startMitm(rawSocket, { host, port }, session);
  }

  function startTunnel(rawSocket, { host, port }, rest) {
    const upstream = net.connect({ host, port });
    upstream.once('connect', () => {
      rawSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length > 0) upstream.write(rest);
      rawSocket.on('data', chunk => upstream.write(chunk));
      upstream.on('data', chunk => rawSocket.write(chunk));
      upstream.on('error', () => rawSocket.destroy());
      rawSocket.on('error', () => upstream.destroy());
      upstream.on('close', () => rawSocket.destroy());
      rawSocket.on('close', () => upstream.destroy());
    });
    upstream.on('error', () => rawSocket.destroy());
  }

  function startMitm(rawSocket, { host, port }, session) {
    let secureContext;
    try {
      secureContext = ca.getSecureContextForHost(host);
    } catch (error) {
      sessionStore.setProxyError(session, `证书签发失败: ${error.message}`);
      rawSocket.destroy();
      return;
    }

    rawSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    const clientTls = new tls.TLSSocket(rawSocket, {
      isServer: true,
      secureContext,
      ALPNProtocols: ['http/1.1'],
    });

    const upstream = tls.connect({
      host,
      port,
      servername: host,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });

    let clientReady = false;
    let upstreamReady = false;
    let headParsed = false;
    let clientBuffer = Buffer.alloc(0);
    let upstreamBuffer = Buffer.alloc(0);
    let wsParser = null;
    let wsUpstreamPending = false;
    let wsUpstreamBuffer = Buffer.alloc(0);
    let destroyed = false;

    const destroyAll = () => {
      if (destroyed) return;
      destroyed = true;
      clientTls.destroy();
      upstream.destroy();
      rawSocket.destroy();
    };

    /**
     * 处理上游→客户端数据：透明转发，并（对 WebSocket 连接）在
     * 101 响应头之后把后续字节喂给帧解析器。
     */
    const feedUpstream = (chunk) => {
      if (destroyed) return;
      if (clientReady) clientTls.write(chunk);

      if (!wsParser) return;
      if (!wsUpstreamPending) {
        wsParser.push(chunk);
        return;
      }
      // 尚未消费 101 响应头，先积累
      wsUpstreamBuffer = Buffer.concat([wsUpstreamBuffer, chunk]);
      const headEnd = findHeadEnd(wsUpstreamBuffer);
      if (headEnd < 0) return;
      wsUpstreamPending = false;
      const headLine = wsUpstreamBuffer.toString('latin1', 0, headEnd).split('\r\n')[0] || '';
      const rest = wsUpstreamBuffer.subarray(headEnd);
      wsUpstreamBuffer = Buffer.alloc(0);
      if (HTTP_101_RE.test(headLine)) {
        if (rest.length > 0) wsParser.push(rest);
      }
    };

    const onUpstreamData = (chunk) => {
      if (destroyed) return;
      if (!clientReady) {
        upstreamBuffer = Buffer.concat([upstreamBuffer, chunk]);
        return;
      }
      feedUpstream(chunk);
    };

    upstream.once('secureConnect', () => {
      upstreamReady = true;
      flushBuffers();
    });
    upstream.on('data', onUpstreamData);
    upstream.on('error', () => destroyAll());

    clientTls.once('secure', () => {
      clientReady = true;
      clientTls.setTimeout(0);
      flushBuffers();
    });
    clientTls.on('error', () => destroyAll());
    clientTls.setTimeout(HANDSHAKE_TIMEOUT_MS, () => destroyAll());

    clientTls.on('data', (chunk) => {
      if (destroyed) return;

      if (headParsed) {
        if (upstreamReady) upstream.write(chunk);
        else clientBuffer = Buffer.concat([clientBuffer, chunk]);
        return;
      }

      clientBuffer = Buffer.concat([clientBuffer, chunk]);
      const headEnd = findHeadEnd(clientBuffer);
      if (headEnd < 0) {
        if (clientBuffer.length > MAX_CONNECT_HEAD_BYTES) destroyAll();
        return;
      }

      const headBytes = clientBuffer.subarray(0, headEnd);
      const rest = clientBuffer.subarray(headEnd);
      headParsed = true;

      // 提取登录 code / openID
      const parsed = parseHttpHead(headBytes);
      const info = extractLoginInfo({ host, parsedHead: parsed, config });
      if (info.code || info.openId) {
        sessionStore.addCode(session, { code: info.code, openId: info.openId });
        log('info', `已抓到登录 Code: 会话 ${session.id}`, {
          sessionId: session.id,
          host,
          codeLength: info.code.length,
          hasOpenId: !!info.openId,
        });
      }

      // 升级为 WebSocket 后解析好友 GID
      if (parsed && parsed.isUpgrade && friendExtractor) {
        wsParser = new WsFrameParser({
          onMessage: (message) => {
            try {
              const result = friendExtractor.handleMessage(message);
              if (result && result.gids.length > 0) {
                sessionStore.addFriendGids(session, {
                  gids: result.gids,
                  source: result.source,
                  complete: result.complete,
                });
              } else if (result && result.complete) {
                sessionStore.addFriendGids(session, {
                  gids: [],
                  source: result.source,
                  complete: true,
                });
              }
            } catch {
              // 忽略单条消息解析错误
            }
          },
        });
        // 先消费上游 101 响应头，再开始解析 WS 帧
        wsUpstreamPending = true;
      }

      if (upstreamReady) {
        upstream.write(Buffer.concat([headBytes, rest]));
      } else {
        clientBuffer = Buffer.concat([headBytes, rest]);
      }
    });

    function flushBuffers() {
      if (!clientReady || !upstreamReady) return;
      if (clientBuffer.length > 0) {
        upstream.write(clientBuffer);
        clientBuffer = Buffer.alloc(0);
      }
      if (upstreamBuffer.length > 0) {
        feedUpstream(upstreamBuffer);
        upstreamBuffer = Buffer.alloc(0);
      }
    }

    rawSocket.on('error', () => destroyAll());
  }

  function handlePlainHttp(rawSocket, { host, port, path }, head, rest, session, bypassHosts) {
    const isBypass = bypassHosts.includes(host);
    const info = extractLoginInfo({ host, head, config });
    if (!isBypass && (info.code || info.openId)) {
      sessionStore.addCode(session, { code: info.code, openId: info.openId });
    }

    const upstream = net.connect({ host, port });
    upstream.once('connect', () => {
      // 重写请求行为 origin-form
      const lines = head.split('\r\n');
      const parts = (lines[0] || '').split(WHITESPACE_RE);
      const rewritten = [parts[0], path || '/', parts[2] || 'HTTP/1.1', ...lines.slice(1)].join('\r\n');
      upstream.write(`${rewritten}\r\n\r\n`);
      if (rest.length > 0) upstream.write(rest);
      rawSocket.on('data', chunk => upstream.write(chunk));
      upstream.on('data', chunk => rawSocket.write(chunk));
      upstream.on('error', () => rawSocket.destroy());
      rawSocket.on('error', () => upstream.destroy());
      upstream.on('close', () => rawSocket.destroy());
      rawSocket.on('close', () => upstream.destroy());
    });
    upstream.on('error', () => rawSocket.destroy());
  }

  return {
    startForSession,
    stopForSession,
  };
}

module.exports = {
  createMitmProxyManager,
  findHeadEnd,
  parseAbsoluteUrl,
  parseConnectLine,
};
