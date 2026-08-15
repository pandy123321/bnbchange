// AES-256-GCM 私钥加密：主密钥从环境变量 / 密钥文件加载，私钥全程密文落盘。
// 明文只在需要查看/使用私钥时短暂存在于内存。
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedKey = null;

// 主密钥来源优先级：MASTER_KEY 环境变量 > MASTER_KEY_FILE 文件 > 默认 master.key 文件。
// 缺失时 Fail Closed：任何加解密都抛错，绝不使用空/固定密钥。
function loadMasterKey() {
  let raw = process.env.MASTER_KEY;
  if (!raw && process.env.MASTER_KEY_FILE) {
    raw = readFileSync(process.env.MASTER_KEY_FILE, "utf8").trim();
  }
  if (!raw) {
    const fallback = join(__dirname, "master.key");
    if (existsSync(fallback)) {
      raw = readFileSync(fallback, "utf8").trim();
    }
  }
  if (!raw) {
    throw new Error("缺少主密钥：请设置 MASTER_KEY 环境变量或 master.key 文件");
  }
  // 任意长度口令统一 sha256 派生为 32 字节 AES-256 密钥
  return createHash("sha256").update(raw, "utf8").digest();
}

function getKey() {
  if (!cachedKey) cachedKey = loadMasterKey();
  return cachedKey;
}

export function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    data: Buffer.concat([ct, tag]).toString("base64"),
  };
}

export function decrypt(payload) {
  const iv = Buffer.from(payload.iv, "base64");
  const buf = Buffer.from(payload.data, "base64");
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, "utf8") + decipher.final("utf8");
}
