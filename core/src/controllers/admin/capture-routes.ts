export {};
const crypto = require("node:crypto");
const fetch = require("node-fetch");

const CAPTURE_REQUEST_TIMEOUT_MS = 15_000;
const CAPTURE_FLOW_TTL_MS = 15 * 60 * 1000;
const QQ_FRIEND_COLLECTION_MAX_MS = 15_000;
const QQ_FRIEND_COLLECTION_POLL_MS = 1500;
const CAPTURE_ACCOUNT_START_DELAY_MS = 1500;
const COMPLETE_QQ_FRIEND_SOURCES = new Set([
  "gamepb.friendpb.FriendService.GetAll",
  "gamepb.friendpb.FriendService.SyncAll",
]);
const captureFlows = new Map();

function isAdminUser(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

function normalizeApiBase(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 500) throw new Error("抓包服务地址无效");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("抓包服务地址格式无效");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("抓包服务地址仅支持不含账号密码的 http(s) 地址");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function getCaptureBypassHosts(req) {
  const values = [
    req?.hostname,
    req?.headers?.["x-forwarded-host"],
    req?.headers?.host,
    req?.headers?.origin,
    req?.headers?.referer,
  ];
  const hosts = [];
  for (const value of values) {
    const raw = String(value || "").split(",")[0].trim();
    if (!raw) continue;
    try {
      const host = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname
        .replace(/^\[|\]$/g, "")
        .toLowerCase();
      if (host && !hosts.includes(host)) hosts.push(host);
    } catch {}
  }
  return hosts.slice(0, 8);
}

// 嵌入 Docker 时网卡自动探测只能看到容器 IP；此时使用浏览器访问面板的地址。
function getCaptureAdvertiseHost(req) {
  const values = [
    req?.headers?.["x-forwarded-host"],
    req?.headers?.host,
    req?.headers?.origin,
    req?.headers?.referer,
    req?.hostname,
  ];
  for (const value of values) {
    const raw = String(value || "").split(",")[0].trim();
    if (!raw) continue;
    try {
      const host = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname
        .replace(/^\[|\]$/g, "")
        .toLowerCase();
      if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return host;
    } catch {}
  }
  return "";
}

function resolveCaptureConfig(store, override: any = {}) {
  const saved = store.getCaptureConfig();
  return {
    ...saved,
    ...override,
    apiBase: normalizeApiBase(override.apiBase || saved.apiBase),
    apiToken: String(override.apiToken || saved.apiToken || "").trim(),
  };
}

// 进程内嵌入的抓包服务核心（admin.js 启动时注入）。
// 存在时 captureRequest 直接进程内调用，不再依赖独立 HTTP 服务/端口。
let embeddedCaptureCore = null;

/**
 * 注入进程内抓包服务核心（嵌入模式）。
 * 传入后，抓包登录流程直接调用进程内 handler，apiBase/apiToken 配置不再生效。
 * @param {object|null} core - createCaptureCore() 的返回值
 */
function setEmbeddedCapture(core) {
  embeddedCaptureCore = core || null;
}

function isEmbeddedMode() {
  return !!embeddedCaptureCore;
}

async function captureRequest(config, path, options: any = {}) {
  // 嵌入模式：进程内直接调用（不经过 HTTP，apiToken 无意义）
  if (embeddedCaptureCore) {
    const result = await embeddedCaptureCore.handleApiRequest(
      options.method || "GET",
      path,
      options.body,
      { sessionId: options.sessionId },
    );
    const data = result?.body || {};
    if (result?.status >= 400 || data?.ok === false) {
      const error: any = new Error(data?.error || `抓包服务请求失败（${result?.status || 500}）`);
      error.captureStatus = result?.status;
      throw error;
    }
    return data;
  }

  if (!config.apiToken) throw new Error("抓包服务 API Token 未配置");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || CAPTURE_REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      Authorization: `Bearer ${config.apiToken}`,
      Accept: "application/json",
      ...options.headers,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.sessionId) headers["x-capture-session-id"] = options.sessionId;
    const response = await fetch(`${config.apiBase}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`抓包服务返回了无效响应（HTTP ${response.status}）`);
    }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `抓包服务请求失败（HTTP ${response.status}）`);
    }
    return data;
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("抓包服务请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getFlowOwner(user) {
  return String(user?.username || "").trim();
}

function findOwnedFlow(flowId, user) {
  const flow = captureFlows.get(String(flowId || ""));
  if (!flow || flow.owner !== getFlowOwner(user)) return null;
  return flow;
}

function isCertificateTokenValid(flow, token) {
  const expected = Buffer.from(String(flow?.certificateToken || ""), "utf8");
  const supplied = Buffer.from(String(token || ""), "utf8");
  return expected.length > 0
    && expected.length === supplied.length
    && crypto.timingSafeEqual(expected, supplied);
}

function mergeKnownFriendGids(existingGids, capturedGids, accountGid) {
  const ownGid = Number(accountGid);
  return [...new Set([
    ...(Array.isArray(existingGids) ? existingGids : []).map(Number),
    ...capturedGids,
  ])].filter(
    (gid) => Number.isSafeInteger(gid) && gid > 0 && gid !== ownGid,
  );
}

function isCompleteQqFriendSource(source) {
  return COMPLETE_QQ_FRIEND_SOURCES.has(String(source || "").trim());
}

function isSameAccountInstance(store, accountId, accountCreatedAt) {
  const account = store.getAccounts().accounts.find(
    (item) => String(item.id) === String(accountId),
  );
  return !!account && String(account.createdAt || "") === String(accountCreatedAt || "");
}

function findDuplicateCapturedAccount(accounts, flow, excludedAccountId = "") {
  const code = String(flow?.code || "").trim();
  const gid = String(flow?.accountGid || "").trim();
  const platform = flow?.platform === "wx" ? "wx" : "qq";
  return (Array.isArray(accounts) ? accounts : []).find((account) => {
    if (String(account?.id || "") === String(excludedAccountId || "")) return false;
    if ((account?.platform === "wx" ? "wx" : "qq") !== platform) return false;
    return (code && String(account?.code || "").trim() === code)
      || (gid && String(account?.gid || "").trim() === gid);
  }) || null;
}

function addCapturedValues(flow, snapshot) {
  const data = snapshot?.data || snapshot?.state || snapshot;
  if (!data || typeof data !== "object") return;
  const channel = data.channels?.[flow.platform];
  const entries = Array.isArray(channel?.codes) ? channel.codes : [];
  const codeEntry = entries.find((item) => String(item?.code || "").trim());
  const gidEntry = entries.find((item) => String(item?.gid || "").trim());
  const openIdEntry = entries.find((item) => String(item?.openid || item?.open_id || "").trim());
  if (!flow.code && codeEntry) flow.code = String(codeEntry.code).trim();
  if (!flow.accountGid && gidEntry) flow.accountGid = String(gidEntry.gid).trim();
  if (!flow.openId && openIdEntry) {
    flow.openId = String(openIdEntry.openid || openIdEntry.open_id).trim();
  }

  const friends = Array.isArray(data.friends?.items) ? data.friends.items : [];
  for (const friend of friends) {
    const gid = Number(friend?.gid);
    if (Number.isSafeInteger(gid) && gid > 0) flow.friendGids.add(gid);
  }
  const friendSource = String(data.friends?.source || "").trim();
  if (friendSource) flow.friendSource = friendSource;
  if (isCompleteQqFriendSource(friendSource)) flow.friendListComplete = true;

  flow.publicInfo = data.publicInfo || flow.publicInfo;
  flow.proxy = data.proxy || flow.proxy;
  flow.captureStatus = channel?.status || flow.captureStatus;
  flow.updatedAt = Date.now();
}

async function refreshFlow(store, flow) {
  const config = resolveCaptureConfig(store);
  const snapshot = await captureRequest(
    config,
    `/api/sessions/${encodeURIComponent(flow.remoteSessionId)}/state`,
    { sessionId: flow.remoteSessionId },
  );
  addCapturedValues(flow, snapshot);
  return flow;
}

function serializeFlow(flow) {
  const autoStopSec = Number(flow.publicInfo?.mitmProxyAutoStopSec) || 0;
  const startedAt = Date.parse(flow.proxy?.startedAt || "");
  const elapsedSec = Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  return {
    id: flow.id,
    platform: flow.platform,
    codeCaptured: !!flow.code,
    accountGid: flow.accountGid,
    friendCount: flow.friendGids.size,
    captureStatus: flow.captureStatus,
    proxy: {
      running: flow.proxy?.running === true,
      status: String(flow.proxy?.status || ""),
      error: String(flow.proxy?.error || ""),
    },
    publicInfo: {
      host: String(flow.publicInfo?.host || ""),
      addresses: Array.isArray(flow.publicInfo?.addresses) ? flow.publicInfo.addresses : [],
      mitmPort: Number(flow.publicInfo?.mitmPort) || 0,
      mitmProxyAutoStopSec: autoStopSec,
      remainingSec: autoStopSec ? Math.max(0, autoStopSec - elapsedSec) : 0,
      certificateUrl: `/api/public/capture-certificate/${encodeURIComponent(flow.id)}/${encodeURIComponent(flow.certificateToken)}`,
    },
    completed: flow.completed === true,
    result: flow.result || null,
  };
}

async function stopRemoteFlow(store, flow) {
  const config = resolveCaptureConfig(store);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await captureRequest(
        config,
        `/api/sessions/${encodeURIComponent(flow.remoteSessionId)}`,
        { method: "DELETE", sessionId: flow.remoteSessionId },
      );
      return true;
    } catch (error) {
      lastError = error;
    }

    try {
      await captureRequest(config, "/api/capture/stop", {
        method: "POST",
        sessionId: flow.remoteSessionId,
        body: {},
      });
      return true;
    } catch (error) {
      lastError = error;
    }

    if (attempt < 3) await waitForNextCollectionPoll(attempt * 500);
  }
  throw lastError || new Error("抓包服务代理释放失败");
}

function scheduleRemoteStop(store, flow, delayMs = 5000, logger = null) {
  const timer = setTimeout(() => {
    void stopRemoteFlow(store, flow).catch((error) => {
      if (logger) {
        logger.warn("抓包服务代理释放失败", {
          owner: flow.owner,
          remoteSessionId: flow.remoteSessionId,
          error: error.message,
        });
      }
    });
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
}

function waitForNextCollectionPoll(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}

async function collectQqFriendGids({
  store,
  provider,
  logger,
  flow,
  accountId,
  accountCreatedAt,
  refresh = refreshFlow,
  stop = stopRemoteFlow,
  wait = waitForNextCollectionPoll,
  now = Date.now,
  maxWaitMs = QQ_FRIEND_COLLECTION_MAX_MS,
  pollMs = QQ_FRIEND_COLLECTION_POLL_MS,
  afterStop,
}) {
  const deadline = now() + maxWaitMs;
  let lastRefreshError = null;

  try {
    while (!flow.cancelled && now() < deadline) {
      if (!isSameAccountInstance(store, accountId, accountCreatedAt)) {
        flow.cancelled = true;
        logger.info("账号已删除或替换，停止旧的好友 GID 后台同步", {
          owner: flow.owner,
          accountId,
        });
        return 0;
      }
      if (flow.friendListComplete) break;

      try {
        await refresh(store, flow);
        lastRefreshError = null;
      } catch (error) {
        lastRefreshError = error;
      }
      if (flow.friendListComplete) break;

      const remainingMs = deadline - now();
      if (remainingMs > 0) await wait(Math.min(pollMs, remainingMs));
    }

    if (flow.cancelled || !isSameAccountInstance(store, accountId, accountCreatedAt)) return 0;
    const knownGids = store.getKnownFriendGids(accountId);
    const gids = mergeKnownFriendGids(knownGids, flow.friendGids, flow.accountGid);
    const previousGids = new Set(knownGids.map(Number));
    const importedFriendCount = gids.filter((gid) => !previousGids.has(gid)).length;
    if (importedFriendCount > 0) {
      store.setKnownFriendGids(accountId, gids);
      if (provider && typeof provider.broadcastConfig === "function") {
        provider.broadcastConfig(accountId);
      }
    }
    if (flow.result) flow.result.importedFriendCount = importedFriendCount;
    logger.info("抓包登录好友 GID 后台同步完成", {
      owner: flow.owner,
      accountId,
      capturedFriendCount: flow.friendGids.size,
      importedFriendCount,
      friendSource: flow.friendSource || "",
      completeFriendList: flow.friendListComplete === true,
      refreshError: lastRefreshError?.message || "",
    });
    return importedFriendCount;
  } finally {
    await stop(store, flow);
    if (captureFlows.get(flow.id) === flow) captureFlows.delete(flow.id);
    if (
      typeof afterStop === "function"
      && !flow.cancelled
      && isSameAccountInstance(store, accountId, accountCreatedAt)
    ) {
      await afterStop();
    }
  }
}

function scheduleQqFriendCollection(options) {
  const { flow, logger } = options;
  if (flow.friendCollectionScheduled) return;
  flow.friendCollectionScheduled = true;
  void collectQqFriendGids(options).catch((error) => {
    logger.warn("抓包登录账号已添加，但好友 GID 后台同步失败", {
      owner: flow.owner,
      accountId: options.accountId,
      error: error.message,
    });
  });
}

function scheduleCapturedAccountStart({
  provider,
  logger,
  flow,
  account,
  isUpdate,
  wasRunning,
  delayMs = CAPTURE_ACCOUNT_START_DELAY_MS,
  schedule = setTimeout,
}) {
  const timer = schedule(() => {
    try {
      if (isUpdate) {
        if (wasRunning) provider.restartAccount(account.id);
      } else {
        provider.startAccount(account.id);
      }
    } catch (error) {
      const startError = error.message || "账号启动失败";
      if (flow.result) flow.result.startError = startError;
      logger.warn("抓包登录账号已添加，但延迟启动失败", {
        owner: flow.owner,
        accountId: account.id,
        error: startError,
      });
    }
  }, delayMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

async function stopCaptureBeforeAccountStart(store, flow, start) {
  await stopRemoteFlow(store, flow);
  if (captureFlows.get(flow.id) === flow) captureFlows.delete(flow.id);
  start();
}

async function removeExistingOwnerFlows(store, owner) {
  const existing = [...captureFlows.values()].filter(
    (flow) => flow.owner === owner && !flow.completed,
  );
  for (const flow of existing) {
    await stopRemoteFlow(store, flow);
    captureFlows.delete(flow.id);
  }
}

async function cleanupExpiredFlows(store) {
  const cutoff = Date.now() - CAPTURE_FLOW_TTL_MS;
  const expired = [...captureFlows.values()].filter((flow) => flow.updatedAt < cutoff);
  for (const flow of expired) {
    if (!flow.completed) await stopRemoteFlow(store, flow);
    captureFlows.delete(flow.id);
  }
}

function registerAdminCaptureRoutes({
  app,
  store,
  provider,
  userStore,
  logger,
  requireAdminRole,
  requireDangerConfirmation,
  canAccessAccount,
  resolveAccountReference,
  ensureEmbeddedCaptureService,
  stopEmbeddedCaptureService,
}) {
  const cleanupTimer = setInterval(() => {
    void cleanupExpiredFlows(store).catch((error) => {
      logger.warn("过期抓包任务清理失败", { error: error.message });
    });
  }, 60_000);
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

  app.get("/api/admin/capture-config", requireAdminRole, (req, res) => {
    try {
      const config = store.getCaptureConfig();
      const embedded = config.embedded !== false;
      const running = isEmbeddedMode();
      res.json({
        ok: true,
        data: {
          enabled: config.enabled === true
            && ((embedded && running) || (!embedded && !!config.apiBase && !!config.apiToken)),
          embedded,
          running,
          apiBase: config.apiBase,
          apiToken: "",
          tokenConfigured: !!config.apiToken,
          autoImportQqGids: config.autoImportQqGids !== false,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/admin/capture-config/test", requireAdminRole, async (req, res) => {
    try {
      const config = resolveCaptureConfig(store, req.body || {});
      const health = await captureRequest(config, "/api/health");
      res.json({
        ok: true,
        data: {
          uptime: Number(health.uptime) || 0,
          sessions: Number(health.sessions) || 0,
          portPoolSize: Array.isArray(health.portPool) ? health.portPool.length : 0,
          proxyPort: Array.isArray(health.portPool) ? Number(health.portPool[0]) || 18000 : 18000,
        },
      });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/admin/capture-config", requireAdminRole, async (req, res) => {
    try {
      if (!requireDangerConfirmation(req, res, "UPDATE_CAPTURE_CONFIG")) return;
      const input = req.body || {};
      const apiBase = normalizeApiBase(input.apiBase || store.DEFAULT_CAPTURE_CONFIG.apiBase);
      const current = store.getCaptureConfig();
      const apiToken = String(input.apiToken || current.apiToken || "").trim();
      const wantsEmbedded = input.embedded !== false;
      // 嵌入模式无需 API Token；独立模式启用前必须填写
      if (input.enabled === true && !wantsEmbedded && !apiToken) {
        return res.status(400).json({ ok: false, error: "启用前请填写 API Token" });
      }
      const data = store.setCaptureConfig({ ...input, apiBase, apiToken });
      if (data.enabled === true && data.embedded !== false && typeof ensureEmbeddedCaptureService === "function") {
        ensureEmbeddedCaptureService();
      } else if (typeof stopEmbeddedCaptureService === "function") {
        await stopEmbeddedCaptureService();
        captureFlows.clear();
      }
      logger.warn("更新 Code/GID 抓取服务配置", {
        admin: req.currentUser?.username || "",
        enabled: data.enabled === true,
        apiBase: data.apiBase,
        autoImportQqGids: data.autoImportQqGids !== false,
        confirmation: "UPDATE_CAPTURE_CONFIG",
      });
      res.json({
        ok: true,
        data: {
          enabled: data.enabled,
          embedded: data.embedded !== false,
          running: isEmbeddedMode(),
          apiBase: data.apiBase,
          apiToken: "",
          tokenConfigured: !!data.apiToken,
          autoImportQqGids: data.autoImportQqGids,
        },
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/capture/config", (req, res) => {
    const config = store.getCaptureConfig();
    res.json({
      ok: true,
      data: {
        enabled: config.enabled === true
          && ((config.embedded !== false && isEmbeddedMode()) || (!!config.apiBase && !!config.apiToken)),
      },
    });
  });

  app.post("/api/capture/sessions", async (req, res) => {
    const owner = getFlowOwner(req.currentUser);
    const platform = req.body?.platform === "wx" ? "wx" : "qq";
    try {
      if (!owner) return res.status(401).json({ ok: false, error: "未登录" });
      const accountRef = String(req.body?.accountId || "").trim();
      const accountId = accountRef
        ? resolveAccountReference(accountRef) || accountRef
        : "";
      if (accountId && !canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }
      if (accountId) {
        const existing = store.getAccounts().accounts.find(
          (account) => String(account.id) === accountId,
        );
        if (!existing) {
          return res.status(404).json({ ok: false, error: "目标账号不存在" });
        }
      }
      const config = resolveCaptureConfig(store);
      if (!config.enabled) {
        return res.status(403).json({ ok: false, error: "抓包登录添加账号未启用" });
      }
      await removeExistingOwnerFlows(store, owner);

      const flowId = crypto.randomBytes(18).toString("base64url");
      const remoteSessionId = crypto.randomBytes(18).toString("base64url");
      const session = await captureRequest(config, "/api/sessions", {
        method: "POST",
        sessionId: remoteSessionId,
        body: { sessionId: remoteSessionId },
      });
      const flow = {
        id: flowId,
        remoteSessionId,
        certificateToken: crypto.randomBytes(24).toString("base64url"),
        owner,
        accountId,
        platform,
        code: "",
        accountGid: "",
        openId: "",
        friendGids: new Set(),
        friendSource: "",
        friendListComplete: false,
        publicInfo: {},
        proxy: {},
        captureStatus: "idle",
        completed: false,
        result: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      addCapturedValues(flow, session);
      captureFlows.set(flowId, flow);
      try {
        const started = await captureRequest(config, "/api/capture/start", {
          method: "POST",
          sessionId: remoteSessionId,
          body: {
            mode: platform,
            bypassHosts: getCaptureBypassHosts(req),
            advertiseHost: isEmbeddedMode() ? getCaptureAdvertiseHost(req) : "",
          },
          timeout: 30_000,
        });
        addCapturedValues(flow, started);
      } catch (error) {
        captureFlows.delete(flowId);
        await stopRemoteFlow(store, flow);
        throw error;
      }
      res.json({ ok: true, data: serializeFlow(flow) });
    } catch (error) {
      logger.warn("启动抓包登录失败", { owner, platform, error: error.message });
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/capture/sessions/:flowId", async (req, res) => {
    const flow = findOwnedFlow(req.params.flowId, req.currentUser);
    if (!flow) return res.status(404).json({ ok: false, error: "抓取任务不存在或已过期" });
    try {
      if (!flow.completed) await refreshFlow(store, flow);
      res.json({ ok: true, data: serializeFlow(flow) });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message, data: serializeFlow(flow) });
    }
  });

  app.get("/api/public/capture-certificate/:flowId/:token", async (req, res) => {
    const flow = captureFlows.get(String(req.params.flowId || ""));
    if (!flow || !isCertificateTokenValid(flow, req.params.token)) {
      return res.status(404).json({ ok: false, error: "证书链接不存在或已过期" });
    }
    try {
      const config = resolveCaptureConfig(store);
      const certPath = String(flow.publicInfo?.certUrl || "/cert/mitmproxy-ca-cert.cer");
      if (!certPath.startsWith("/") || certPath.startsWith("//")) {
        throw new Error("抓包服务证书地址无效");
      }
      // 嵌入模式：直接取进程内 CA 证书
      if (embeddedCaptureCore && typeof embeddedCaptureCore.getCaCertDer === "function") {
        const der = embeddedCaptureCore.getCaCertDer();
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/x-x509-ca-cert");
        res.setHeader("Content-Disposition", 'inline; filename="mitmproxy-ca-cert.cer"');
        res.send(der);
        return;
      }
      const response = await fetch(`${config.apiBase}${certPath}`, { timeout: CAPTURE_REQUEST_TIMEOUT_MS });
      if (!response.ok) throw new Error(`证书下载失败（HTTP ${response.status}）`);
      const buffer = await response.buffer();
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/x-x509-ca-cert");
      res.setHeader("Content-Disposition", 'inline; filename="mitmproxy-ca-cert.cer"');
      res.send(buffer);
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/capture/sessions/:flowId/complete", async (req, res) => {
    const flow = findOwnedFlow(req.params.flowId, req.currentUser);
    if (!flow) return res.status(404).json({ ok: false, error: "抓取任务不存在或已过期" });
    if (flow.completed) return res.json({ ok: true, data: flow.result });
    if (flow.completing) return res.status(409).json({ ok: false, error: "账号正在添加中" });
    flow.completing = true;
    try {
      if (!flow.code) await refreshFlow(store, flow);
      if (!flow.code) return res.status(400).json({ ok: false, error: "尚未获取到 Code" });

      const currentUser = req.currentUser;
      const isUpdate = !!flow.accountId;
      const allAccounts = store.getAccounts().accounts;
      const duplicate = findDuplicateCapturedAccount(allAccounts, flow, flow.accountId);
      if (duplicate) {
        flow.cancelled = true;
        captureFlows.delete(flow.id);
        logger.warn("抓包登录检测到重复账号，已停止本次添加", {
          owner: flow.owner,
          platform: flow.platform,
          duplicateAccountId: duplicate.id,
        });
        res.status(409).json({
          ok: false,
          code: "DUPLICATE_CAPTURE_ACCOUNT",
          error: "检测到当前仍是已添加的账号，请先切换到目标 QQ，再重新开始抓取",
        });
        scheduleRemoteStop(store, flow, 0, logger);
        return;
      }
      if (!isUpdate && !isAdminUser(currentUser)) {
        const accountCount = store.getAccountsByUser(currentUser.username).accounts.length;
        const accountLimit = currentUser.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2;
        if (accountCount >= accountLimit) {
          return res.status(403).json({
            ok: false,
            error: `账号数量已达上限（${accountLimit}个），请购买额度卡密增加额度`,
          });
        }
      }

      const name = String(req.body?.name || "").trim();
      const existing = isUpdate
        ? allAccounts.find(
            (account) => String(account.id) === flow.accountId,
          )
        : null;
      if (isUpdate && !existing) throw new Error("目标账号不存在");
      if (isUpdate && !canAccessAccount(req, flow.accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }
      const wasRunning = isUpdate && provider.isAccountRunning
        ? provider.isAccountRunning(flow.accountId)
        : false;
      const accountPayload = {
        ...(isUpdate ? { id: flow.accountId } : { username: currentUser.username }),
        name: name || existing?.name || "",
        code: flow.code,
        platform: flow.platform,
        loginType: "capture",
        ...(flow.accountGid ? { gid: flow.accountGid } : {}),
        ...(flow.openId ? { openId: flow.openId } : {}),
      };
      const accounts = store.addOrUpdateAccount(accountPayload);
      const created = isUpdate
        ? accounts.accounts.find((account) => String(account.id) === flow.accountId)
        : accounts.accounts.at(-1);
      if (!created) throw new Error("账号保存失败");

      flow.completed = true;
      flow.result = {
        accountId: created.id,
        name: created.name,
        platform: flow.platform,
        importedFriendCount: 0,
        startError: "",
      };

      const importedFriendCount = 0;

      try {
        if (provider.addAccountLog) {
          provider.addAccountLog(
            isUpdate ? "update" : "add",
            `抓包登录${isUpdate ? "更新" : "添加"}账号: ${created.name || created.id}`,
            created.id,
            created.name || "",
            { platform: flow.platform, importedFriendCount },
          );
        }
      } catch {}

      flow.result = {
        accountId: created.id,
        name: created.name,
        platform: flow.platform,
        importedFriendCount,
        startError: "",
        updated: isUpdate,
      };
      flow.updatedAt = Date.now();
      res.json({ ok: true, data: flow.result });
      const startAccount = () => scheduleCapturedAccountStart({
        provider,
        logger,
        flow,
        account: created,
        isUpdate,
        wasRunning,
      });
      const config = store.getCaptureConfig();
      if (flow.platform === "qq" && config.autoImportQqGids !== false) {
        scheduleQqFriendCollection({
          store,
          provider,
          logger,
          flow,
          accountId: created.id,
          accountCreatedAt: created.createdAt,
          afterStop: startAccount,
        });
      } else {
        void stopCaptureBeforeAccountStart(store, flow, startAccount).catch((error) => {
          logger.warn("抓包服务代理释放失败，账号未启动", {
            owner: flow.owner,
            accountId: created.id,
            remoteSessionId: flow.remoteSessionId,
            error: error.message,
          });
        });
      }
    } catch (error) {
      logger.warn("抓包登录添加账号失败", {
        owner: flow.owner,
        platform: flow.platform,
        error: error.message,
      });
      res.status(500).json({ ok: false, error: error.message });
    } finally {
      flow.completing = false;
    }
  });

  app.delete("/api/capture/sessions/:flowId", async (req, res) => {
    const flow = findOwnedFlow(req.params.flowId, req.currentUser);
    if (!flow) return res.json({ ok: true });
    flow.cancelled = true;
    captureFlows.delete(flow.id);
    res.json({ ok: true });
    scheduleRemoteStop(store, flow, 0, logger);
  });
}

function mountCaptureRoutes(app, ctx) {
  const store = require("../../models/store");
  const userStore = require("../../models/user-store");
  const { createModuleLogger } = require("../../services/logger");
  const {
    createRequireAdminRole,
    requireDangerConfirmation,
    canAccessAccount,
    resolveAccId,
  } = require("./middleware");
  const { createCaptureCore } = require("../../capture/index");

  const requireAdminRole = createRequireAdminRole();
  const logger = createModuleLogger("capture");

  function captureLog(level, message, extra) {
    const meta = extra && typeof extra === "object" ? extra : {};
    if (level === "error") logger.error(message, meta);
    else if (level === "warn") logger.warn(message, meta);
    else logger.info(message, meta);
  }

  function ensureEmbeddedCaptureService() {
    const config = store.getCaptureConfig();
    if (config.enabled !== true || config.embedded === false) return null;
    if (embeddedCaptureCore) return embeddedCaptureCore;
    const core = createCaptureCore({ log: captureLog });
    embeddedCaptureCore = core;
    void core.ready.catch((error) => {
      logger.error("内嵌抓包服务初始化失败", { error: error && error.message ? error.message : String(error) });
    });
    return core;
  }

  async function stopEmbeddedCaptureService() {
    const core = embeddedCaptureCore;
    embeddedCaptureCore = null;
    if (!core) return;
    try {
      await core.stop();
    } catch (error) {
      logger.warn("内嵌抓包服务停止失败", { error: error && error.message ? error.message : String(error) });
    }
  }

  registerAdminCaptureRoutes({
    app,
    store,
    provider: ctx.provider,
    userStore,
    logger,
    requireAdminRole,
    requireDangerConfirmation,
    canAccessAccount: (req, accountId) => canAccessAccount(ctx, req, accountId),
    resolveAccountReference: (ref) => resolveAccId(ctx, ref),
    ensureEmbeddedCaptureService,
    stopEmbeddedCaptureService,
  });
}

module.exports = {
  addCapturedValues,
  collectQqFriendGids,
  findDuplicateCapturedAccount,
  getCaptureBypassHosts,
  getCaptureAdvertiseHost,
  isCertificateTokenValid,
  isCompleteQqFriendSource,
  isEmbeddedMode,
  mergeKnownFriendGids,
  normalizeApiBase,
  registerAdminCaptureRoutes,
  scheduleCapturedAccountStart,
  setEmbeddedCapture,
  mountCaptureRoutes,
};
