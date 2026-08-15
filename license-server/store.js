import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DATA_FILE =
  process.env.LICENSE_DATA_FILE ?? join(__dirname, "licenses.json");

// 每条卡密结构: { code, status: "active"|"revoked", createdAt, expiresAt|null, note? }

export function normalizeCode(code) {
  return String(code ?? "").trim().toUpperCase();
}

export function generateCode() {
  return randomBytes(8).toString("hex").toUpperCase().match(/.{1,4}/g).join("-");
}

export function loadLicenses() {
  if (!existsSync(DATA_FILE)) return [];
  const raw = readFileSync(DATA_FILE, "utf8");
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.licenses) ? parsed.licenses : [];
}

export function saveLicenses(licenses) {
  writeFileSync(DATA_FILE, JSON.stringify({ licenses }, null, 2) + "\n", "utf8");
}
