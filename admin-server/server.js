// 统一后台服务（admin-server）：
//   1) 授权验证（原 license-server 功能整体迁入，行为保持一致）
//   2) 后台管理（登录/RBAC + 私钥托管 + 操作日志 + 持仓 + 授权码管理）
// 安全：私钥 AES-256-GCM 落库、超管二次鉴权查看明文并留审计、公网部署需 HTTPS + CORS 白名单 + 限流。
import http from "node:http";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  issueSession as issueLicenseSession,
  consumeSession,
  generateLicenses,
  listLicenses,
  setLicenseStatus,
  verify,
} from "./license.js";
import {
  createUser,
  deleteUser,
  destroySession,
  findUser,
  getSession,
  issueSession,
  listUsers,
  roleAllows,
  updateUser,
  verifyPassword,
} from "./auth.js";
import {
  createKey,
  deleteKey,
  getKey as getKeyById,
  listKeys,
  revealKey,
  updateKey,
} from "./keyStore.js";
import { addLog, listLogs } from "./auditLog.js";
import {
  deletePosition,
  listPositions,
  reducePosition,
  upsertPosition,
} from "./positionStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.ADMIN_PORT ?? process.env.LICENSE_PORT ?? 8788);
const HOST = process.env.ADMIN_HOST ?? process.env.LICENSE_HOST ?? "127.0.0.1";
const RATE_LIMIT = Number(
  process.env.ADMIN_RATE_LIMIT ?? process.env.LICENSE_RATE_LIMIT ?? 10
);
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024; // 后台接口可能上传私钥，放宽到 64KB（仍有限制）

const ALLOWED_ORIGINS = (
  process.env.ADMIN_ALLOWED_ORIGINS ??
  process.env.LICENSE_ALLOWED_ORIGINS ??
  "http://127.0.0.1:4173,http://127.0.0.1:5173"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TRUSTED_PROXIES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  ...(process.env.ADMIN_TRUSTED_PROXIES ?? process.env.LICENSE_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

function corsHeaders(origin, host) {
  if (!origin) return {};
  // 同源请求（管理 UI 自身页面发起的请求，如 http://HOST:PORT/admin 页内 fetch）
  // 直接放行，不受跨源白名单限制；跨源仍严格走 ALLOWED_ORIGINS 白名单。
  const sameOrigin =
    origin === `http://${host}` || origin === `https://${host}`;
  if (sameOrigin || ALLOWED_ORIGINS.includes(origin)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return null;
}

function getClientIp(req) {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (!TRUSTED_PROXIES.has(socketIp)) return socketIp;

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff !== "string" || !xff.trim()) return socketIp;

  const tokens = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (isIP(token) === 0) return socketIp; // 非法 token → Fail Closed
    if (TRUSTED_PROXIES.has(token)) continue;
    return token;
  }
  return socketIp;
}

// 简单内存限流：每 IP 每分钟 N 次
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

// 统一 JSON body 读取：超过上限立即 413，且保证每个请求只响应一次。
function readJsonBody(req, res, cors, onBody) {
  let raw = "";
  let size = 0;
  let settled = false;

  function respond(status, body, close = false) {
    if (settled) return;
    settled = true;
    const headers = { ...cors };
    if (close) headers.Connection = "close";
    sendJson(res, status, body, headers);
  }

  req.on("data", (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      respond(413, { ok: false, error: "请求体过大" }, true);
      return;
    }
    raw += chunk;
  });

  req.on("end", () => {
    if (settled) return;
    let parsed;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      respond(400, { ok: false, error: "请求格式错误" });
      return;
    }
    onBody(parsed);
  });

  req.on("error", () => {});
}

// 从请求提取管理会话 token：优先 Authorization: Bearer，其次 body.token
function extractToken(req, body) {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  return body && body.token ? String(body.token) : null;
}

function authUser(req, body) {
  const token = extractToken(req, body);
  if (!token) return null;
  return getSession(token);
}

// 静态文件：仅服务 public/ 下的管理 UI，防止路径穿越
function serveStatic(res, pathname) {
  const publicDir = join(__dirname, "public");
  let file = normalize(join(publicDir, pathname === "/admin" ? "index.html" : pathname.replace(/^\/admin\/?/, "")));
  if (!file.startsWith(publicDir)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }
  if (file.endsWith("/") || file === publicDir) file = join(publicDir, "index.html");
  if (!existsSync(file)) {
    sendJson(res, 404, { ok: false, error: "Not Found" });
    return;
  }
  const ext = file.slice(file.lastIndexOf("."));
  const mime =
    ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(file));
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // CORS 预检
  if (req.method === "OPTIONS") {
    const cors = corsHeaders(origin, req.headers.host);
    if (cors === null) {
      sendJson(res, 403, { ok: false, error: "Origin 不被允许" });
      return;
    }
    res.writeHead(204, {
      ...cors,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // 管理 UI 静态页面（GET /admin 或 /admin/...）
  if (req.method === "GET" && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))) {
    serveStatic(res, url.pathname);
    return;
  }

  const cors = corsHeaders(origin, req.headers.host);
  if (cors === null) {
    sendJson(res, 403, { ok: false, error: "Origin 不被允许" });
    return;
  }

  const pathname = url.pathname;

  // ---- 授权验证（公开，与原 license-server 一致）----
  const licenseRoutes = {
    "/api/tool/verify-license": (body) => verify(body.code),
    "/api/tool/issue-session": (body) => issueLicenseSession(body.code),
    "/api/tool/verify-session": (body) => consumeSession(body.token),
  };

  if (req.method === "POST" && licenseRoutes[pathname]) {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" }, cors);
      return;
    }
    readJsonBody(req, res, cors, (parsed) => {
      try {
        const result = licenseRoutes[pathname](parsed);
        sendJson(res, result.ok ? 200 : 403, result, cors);
      } catch {
        sendJson(res, 500, { ok: false, error: "服务器内部错误" }, cors);
      }
    });
    return;
  }

  // ---- 后台管理接口（需登录鉴权 + RBAC）----
  // 每条路由：{ role: 最低角色, handler(body, user, ip) }
  const adminRoutes = {
    // 登录/登出（登录有限流，但无需已登录）
    "/api/admin/login": {
      role: null,
      handler(body, _user, ip) {
        const user = findUser(body.username);
        if (!user || !verifyPassword(body.password, user.passwordHash)) {
          return { status: 403, body: { ok: false, error: "用户名或密码错误" } };
        }
        const token = issueSession(user);
        addLog({ operator: user.username, action: "login", detail: "登录成功", ip });
        return { status: 200, body: { ok: true, token, username: user.username, role: user.role } };
      },
    },
    "/api/admin/logout": {
      role: "operator",
      handler(_body, _user, _ip, token) {
        destroySession(token);
        return { status: 200, body: { ok: true } };
      },
    },
    "/api/admin/me": {
      role: "operator",
      handler(_body, user) {
        return { status: 200, body: { ok: true, username: user.username, role: user.role } };
      },
    },
    // 私钥托管
    "/api/admin/keys/list": {
      role: "admin",
      handler() {
        return { status: 200, body: { ok: true, keys: listKeys() } };
      },
    },
    "/api/admin/keys/create": {
      role: "admin",
      handler(body, user, ip) {
        const rec = createKey(body);
        addLog({ operator: user.username, action: "create_key", targetAddress: rec.address, detail: `新增私钥(${rec.walletType})`, ip });
        return { status: 200, body: { ok: true, key: rec } };
      },
    },
    "/api/admin/keys/update": {
      role: "admin",
      handler(body, user, ip) {
        const rec = updateKey(body.id, body.patch ?? {});
        addLog({ operator: user.username, action: "update_key", targetAddress: rec.address, detail: "更新私钥配置", ip });
        return { status: 200, body: { ok: true, key: rec } };
      },
    },
    "/api/admin/keys/delete": {
      role: "admin",
      handler(body, user, ip) {
        const rec = getKeyById(body.id);
        deleteKey(body.id);
        addLog({ operator: user.username, action: "delete_key", targetAddress: rec?.address ?? "", detail: "删除私钥", ip });
        return { status: 200, body: { ok: true } };
      },
    },
    "/api/admin/keys/reveal": {
      role: "super",
      handler(body, user, ip) {
        // 二次鉴权：重新输入密码
        const u = findUser(user.username);
        if (!u || !verifyPassword(body.password, u.passwordHash)) {
          // 失败/拒绝也留审计，且不得包含私钥明文或密文
          addLog({ operator: user.username, action: "view_private_key_denied", detail: "查看私钥明文二次鉴权失败", ip });
          return { status: 403, body: { ok: false, error: "二次鉴权失败" } };
        }
        const rec = getKeyById(body.id);
        const privateKey = revealKey(body.id);
        addLog({ operator: user.username, action: "view_private_key", targetAddress: rec?.address ?? "", detail: "查看私钥明文", ip });
        return { status: 200, body: { ok: true, privateKey } };
      },
    },
    // 操作日志
    "/api/admin/logs/list": {
      role: "admin",
      handler() {
        return { status: 200, body: { ok: true, logs: listLogs() } };
      },
    },
    // 持仓
    "/api/admin/positions/list": {
      role: "operator",
      handler() {
        return { status: 200, body: { ok: true, positions: listPositions() } };
      },
    },
    "/api/admin/positions/upsert": {
      role: "admin",
      handler(body, user, ip) {
        const pos = upsertPosition(body);
        addLog({ operator: user.username, action: "upsert_position", targetAddress: body.follower ?? "", detail: `持仓 ${body.tokenSymbol ?? ""}`, ip });
        return { status: 200, body: { ok: true, position: pos } };
      },
    },
    "/api/admin/positions/reduce": {
      role: "admin",
      handler(body, user, ip) {
        const pos = reducePosition(body.chainId, body.follower, body.tokenAddress, body.reduceWei);
        addLog({ operator: user.username, action: "reduce_position", targetAddress: body.follower ?? "", detail: "减仓", ip });
        return { status: 200, body: { ok: true, position: pos } };
      },
    },
    "/api/admin/positions/delete": {
      role: "admin",
      handler(body, user, ip) {
        deletePosition(body.id);
        addLog({ operator: user.username, action: "delete_position", detail: "删除持仓", ip });
        return { status: 200, body: { ok: true } };
      },
    },
    // 授权码管理
    "/api/admin/licenses/list": {
      role: "admin",
      handler() {
        return { status: 200, body: { ok: true, licenses: listLicenses() } };
      },
    },
    "/api/admin/licenses/generate": {
      role: "admin",
      handler(body, user, ip) {
        const created = generateLicenses(Number(body.count ?? 1), Number(body.days ?? 0), body.note);
        addLog({ operator: user.username, action: "generate_license", detail: `生成 ${created.length} 个授权码`, ip });
        return { status: 200, body: { ok: true, licenses: created } };
      },
    },
    "/api/admin/licenses/set-status": {
      role: "admin",
      handler(body, user, ip) {
        const lic = setLicenseStatus(body.code, body.status);
        addLog({ operator: user.username, action: "set_license_status", detail: `授权码 ${lic.code} → ${body.status}`, ip });
        return { status: 200, body: { ok: true, license: lic } };
      },
    },
    // 用户管理（仅超管）
    "/api/admin/users/list": {
      role: "super",
      handler() {
        return { status: 200, body: { ok: true, users: listUsers() } };
      },
    },
    "/api/admin/users/create": {
      role: "super",
      handler(body, user, ip) {
        const u = createUser(body.username, body.password, body.role);
        addLog({ operator: user.username, action: "create_user", detail: `新增用户 ${u.username}(${u.role})`, ip });
        return { status: 200, body: { ok: true, user: u } };
      },
    },
    "/api/admin/users/update": {
      role: "super",
      handler(body, user, ip) {
        const u = updateUser(body.username, body.patch ?? {});
        addLog({ operator: user.username, action: "update_user", detail: `更新用户 ${u.username}`, ip });
        return { status: 200, body: { ok: true, user: u } };
      },
    },
    "/api/admin/users/delete": {
      role: "super",
      handler(body, user, ip) {
        deleteUser(body.username);
        addLog({ operator: user.username, action: "delete_user", detail: `删除用户 ${body.username}`, ip });
        return { status: 200, body: { ok: true } };
      },
    },
  };

  const route = adminRoutes[pathname];
  if (req.method === "POST" && route) {
    const ip = getClientIp(req);

    // 登录接口限流；其它接口也统一限流（防爆破）
    if (isRateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" }, cors);
      return;
    }

    readJsonBody(req, res, cors, (parsed) => {
      try {
        const ip2 = ip;
        if (pathname === "/api/admin/login") {
          const result = route.handler(parsed, null, ip2, null);
          sendJson(res, result.status, result.body, cors);
          return;
        }
        const token = extractToken(req, parsed);
        const user = authUser(req, parsed);
        if (!user) {
          sendJson(res, 401, { ok: false, error: "未登录或会话已过期" }, cors);
          return;
        }
        if (!roleAllows(user.role, route.role)) {
          sendJson(res, 403, { ok: false, error: "权限不足" }, cors);
          return;
        }
        const result = route.handler(parsed, user, ip2, token);
        sendJson(res, result.status, result.body, cors);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : "请求处理失败" }, cors);
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not Found" }, cors);
});

server.listen(PORT, HOST, () => {
  console.log(`admin-server 已启动: http://${HOST}:${PORT}`);
  console.log(`管理界面: http://${HOST}:${PORT}/admin`);
  console.log(`授权验证接口: POST /api/tool/verify-license / issue-session / verify-session`);
  console.log(`管理接口前缀: /api/admin/*`);
});
