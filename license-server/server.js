import http from "node:http";
import { randomBytes } from "node:crypto";
import { loadLicenses, normalizeCode } from "./store.js";

const PORT = Number(process.env.LICENSE_PORT ?? 8788);
const HOST = process.env.LICENSE_HOST ?? "127.0.0.1";
const RATE_LIMIT = Number(process.env.LICENSE_RATE_LIMIT ?? 10);
const RATE_WINDOW_MS = 60_000;
// 桌面端验证授权码后，向浏览器发放的一次性 session token 有效期
const SESSION_TTL_MS = 10 * 60 * 1000;

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

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  // CORS 预检（前端 dev 从 5173 访问 8788）
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
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
    const ip = req.socket.remoteAddress ?? "unknown";
    if (isRateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" });
      return;
    }

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, 400, { ok: false, error: "请求格式错误" });
        return;
      }

      try {
        const result = handler(parsed);
        sendJson(res, result.ok ? 200 : 403, result);
      } catch {
        sendJson(res, 500, { ok: false, error: "服务器内部错误" });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not Found" });
});

server.listen(PORT, HOST, () => {
  console.log(`License server 已启动: http://${HOST}:${PORT}`);
  console.log(`验证接口: POST /api/tool/verify-license`);
  console.log(`会话接口: POST /api/tool/issue-session / verify-session`);
});
