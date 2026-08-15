import http from "node:http";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { loadLicenses, normalizeCode } from "./store.js";

const PORT = Number(process.env.LICENSE_PORT ?? 8788);
const HOST = process.env.LICENSE_HOST ?? "127.0.0.1";
const RATE_LIMIT = Number(process.env.LICENSE_RATE_LIMIT ?? 10);
const RATE_WINDOW_MS = 60_000;
// 桌面端验证授权码后，向浏览器发放的一次性 session token 有效期
const SESSION_TTL_MS = 10 * 60 * 1000;
// POST JSON 请求体上限（字节），超出返回 413
const MAX_BODY_BYTES = 8 * 1024;
// CORS 白名单（逗号分隔）。默认仅允许本地 dev / Electron 静态服务器；
// 公网部署时必须显式配置 LICENSE_ALLOWED_ORIGINS，禁止回退为 "*"。
const ALLOWED_ORIGINS = (
  process.env.LICENSE_ALLOWED_ORIGINS ??
  "http://127.0.0.1:4173,http://127.0.0.1:5173"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 可信反向代理来源：仅当 socket 对端来自这些地址时才信任 X-Forwarded-For。
// 默认仅本机 loopback（同机 Nginx / Caddy / 负载均衡反向代理场景）；
// 其它可信代理可通过 LICENSE_TRUSTED_PROXIES 追加（逗号分隔）。
const TRUSTED_PROXIES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  ...(process.env.LICENSE_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

// 计算 CORS 响应头：
// - 无 Origin（Electron 主进程 / 服务端请求）→ 空对象，不返回 CORS 头
// - Origin 在白名单 → 返回该具体 Origin + Vary: Origin
// - Origin 非空且不在白名单 → null（调用方应返回 403）
function corsHeaders(origin) {
  if (!origin) return {};
  if (ALLOWED_ORIGINS.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    };
  }
  return null;
}

// 安全获取客户端 IP：
// 1. 连接不来自可信代理 → 完全忽略 XFF，直接用 socket 地址（防伪造绕过限流）。
// 2. 连接来自可信代理 → 从右向左解析代理链：
//    - 跳过可信代理节点；
//    - 遇到第一个「不可信的合法 IP」即真实客户端；
//    - 出现非法 token 或没有合法客户端 IP → Fail Closed 回退 socketIp。
function getClientIp(req) {
  const socketIp = req.socket.remoteAddress ?? "unknown";

  if (!TRUSTED_PROXIES.has(socketIp)) {
    return socketIp;
  }

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff !== "string" || !xff.trim()) {
    return socketIp;
  }

  const tokens = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    // 非法 token → 代理链不可信，Fail Closed 回退
    if (isIP(token) === 0) {
      return socketIp;
    }
    if (TRUSTED_PROXIES.has(token)) {
      continue; // 可信代理 → 继续向左
    }
    return token; // 第一个不可信的合法 IP = 真实客户端
  }

  return socketIp;
}

function verify(code) {
  const normalized = normalizeCode(String(code ?? ""));
  const now = Date.now();

  const lic = loadLicenses().find((l) => l.code === normalized);

  // 不存在 / 已吊销 / 已过期 → 统一返回不可用，不向客户端区分具体原因
  if (!lic || lic.status !== "active") {
    return { ok: false, error: "授权码无效或不可用" };
  }
  if (lic.expiresAt != null && Number(lic.expiresAt) <= now) {
    return { ok: false, error: "授权码无效或不可用" };
  }

  return { ok: true, expiresAt: lic.expiresAt ?? null };
}

// 一次性 session：桌面端验证授权码成功后，换取一个短期 token 传给浏览器，
// 浏览器用该 token 换取“已验证”状态，避免在浏览器里再次输入授权码。
// token 一次性、短期有效，进程重启即失效（内存态）。
const sessions = new Map(); // token -> { expiresAt, licenseExpiresAt }

function issueSession(code) {
  const v = verify(code);
  if (!v.ok) return v;

  const token = randomBytes(24).toString("hex");
  sessions.set(token, {
    expiresAt: Date.now() + SESSION_TTL_MS,
    licenseExpiresAt: v.expiresAt,
  });
  return { ok: true, sessionToken: token, expiresAt: v.expiresAt };
}

function consumeSession(token) {
  const t = String(token ?? "").trim();
  const rec = sessions.get(t);
  if (!rec) return { ok: false, error: "会话无效或已过期" };
  sessions.delete(t); // 一次性使用
  if (Date.now() > rec.expiresAt) {
    return { ok: false, error: "会话无效或已过期" };
  }
  return { ok: true, expiresAt: rec.licenseExpiresAt };
}

// 简单内存限流：每 IP 每分钟 N 次（进程重启即清零）
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
      // 立即返回 413，不再等待完整请求体；Connection: close 让服务端尽快释放连接
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

  req.on("error", () => {
    // 连接异常，无需额外处理
  });
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;

  // CORS 预检（前端 dev 从 5173 访问 8788）
  if (req.method === "OPTIONS") {
    const cors = corsHeaders(origin);
    if (cors === null) {
      sendJson(res, 403, { ok: false, error: "Origin 不被允许" });
      return;
    }
    res.writeHead(204, {
      ...cors,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // 浏览器跨域请求且 Origin 不在白名单 → 直接拒绝，不处理请求体
  const cors = corsHeaders(origin);
  if (cors === null) {
    sendJson(res, 403, { ok: false, error: "Origin 不被允许" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  const routes = {
    "/api/tool/verify-license": (body) => verify(body.code),
    "/api/tool/issue-session": (body) => issueSession(body.code),
    "/api/tool/verify-session": (body) => consumeSession(body.token),
  };

  const handler = routes[url.pathname];
  if (req.method === "POST" && handler) {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" }, cors);
      return;
    }

    readJsonBody(req, res, cors, (parsed) => {
      try {
        const result = handler(parsed);
        sendJson(res, result.ok ? 200 : 403, result, cors);
      } catch {
        sendJson(res, 500, { ok: false, error: "服务器内部错误" }, cors);
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not Found" }, cors);
});

server.listen(PORT, HOST, () => {
  console.log(`License server 已启动: http://${HOST}:${PORT}`);
  console.log(`验证接口: POST /api/tool/verify-license`);
  console.log(`会话接口: POST /api/tool/issue-session / verify-session`);
});
