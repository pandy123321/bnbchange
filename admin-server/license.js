// 授权码验证 / 会话（自原 license-server 迁入，合并进 admin-server）。
// 授权码数据沿用 licenses.json 结构，与旧 store.js 兼容。
import { randomBytes } from "node:crypto";
import { dataFile, loadJson, saveJson } from "./store.js";

const LICENSES_FILE =
  process.env.LICENSE_DATA_FILE ?? dataFile("licenses.json");
const SESSION_TTL_MS = 10 * 60 * 1000;

export function normalizeCode(code) {
  return String(code ?? "").trim().toUpperCase();
}

export function generateCode() {
  return randomBytes(8).toString("hex").toUpperCase().match(/.{1,4}/g).join("-");
}

export function loadLicenses() {
  const parsed = loadJson(LICENSES_FILE, { licenses: [] });
  return Array.isArray(parsed.licenses) ? parsed.licenses : [];
}

export function listLicenses() {
  return loadLicenses();
}

export function saveLicenses(licenses) {
  saveJson(LICENSES_FILE, { licenses });
}

export function verify(code) {
  const normalized = normalizeCode(code);
  const now = Date.now();
  const lic = loadLicenses().find((l) => l.code === normalized);

  if (!lic || lic.status !== "active") {
    return { ok: false, error: "授权码无效或不可用" };
  }
  if (lic.expiresAt != null && Number(lic.expiresAt) <= now) {
    return { ok: false, error: "授权码无效或不可用" };
  }
  return { ok: true, expiresAt: lic.expiresAt ?? null };
}

const sessions = new Map(); // token -> { expiresAt, licenseExpiresAt }

export function issueSession(code) {
  const v = verify(code);
  if (!v.ok) return v;

  const token = randomBytes(24).toString("hex");
  sessions.set(token, {
    expiresAt: Date.now() + SESSION_TTL_MS,
    licenseExpiresAt: v.expiresAt,
  });
  return { ok: true, sessionToken: token, expiresAt: v.expiresAt };
}

export function consumeSession(token) {
  const t = String(token ?? "").trim();
  const rec = sessions.get(t);
  if (!rec) return { ok: false, error: "会话无效或已过期" };
  sessions.delete(t);
  if (Date.now() > rec.expiresAt) {
    return { ok: false, error: "会话无效或已过期" };
  }
  return { ok: true, expiresAt: rec.licenseExpiresAt };
}

// 授权码管理（供后台 API / CLI 使用）
// 有效期天数合理上限（10 年），0 表示永久
const MAX_LICENSE_DAYS = 3650;

export function generateLicenses(count, days, note) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    throw new Error("count 必须是 1~10000 的整数");
  }
  const d = Number(days);
  if (!Number.isFinite(d) || d < 0) {
    throw new Error("days 必须是非负数字（0 表示永久）");
  }
  if (d > MAX_LICENSE_DAYS) {
    throw new Error(`days 不能超过 ${MAX_LICENSE_DAYS} 天`);
  }

  const existing = loadLicenses();
  const created = [];
  const expiresAt =
    d && d > 0 ? Date.now() + d * 24 * 60 * 60 * 1000 : null;
  for (let i = 0; i < n; i++) {
    const record = {
      code: generateCode(),
      status: "active",
      createdAt: Date.now(),
      expiresAt,
      note: note || undefined,
    };
    existing.push(record);
    created.push(record);
  }
  saveLicenses(existing);
  return created;
}

export function setLicenseStatus(code, status) {
  if (!["active", "revoked"].includes(status)) {
    throw new Error("status 必须是 active 或 revoked");
  }
  const normalized = normalizeCode(code);
  const licenses = loadLicenses();
  const target = licenses.find((l) => l.code === normalized);
  if (!target) throw new Error(`未找到授权码: ${normalized}`);
  target.status = status;
  saveLicenses(licenses);
  return target;
}
