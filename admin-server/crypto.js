// AES-256-GCM 私钥加密：主密钥从环境变量 / 密钥文件加载，私钥全程密文落盘。
// 明文只在需要查看/使用私钥时短暂存在于内存。
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedKey = null;

// 主密钥来源优先级：MASTER_KEY 环境变量 > MASTER_KEY_FILE 文件 > 默认 master.key 文件。
// 缺失时 Fail Closed：任何加解密都抛错，绝不使用空/固定密钥。
// MASTER_KEY 必须是 32 字节随机密钥（64 位 hex），拒绝低熵口令：
// 若允许人类口令经单次 SHA-256 派生密钥，攻击者拿到 keys.json 后可离线爆破并解密全部托管私钥。
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
  return decodeMasterKey(raw);
}

// 仅接受 64 位 hex（32 字节）。不使用 base64（Node 的宽松解码器会静默忽略非法字符），
// 也不接受人类口令（避免低熵输入被快速 SHA-256 伪装成强密钥）。
//
// 这是 master-key 存储格式 cutover：旧版“任意口令 → SHA256”派生规则已彻底移除，
// 旧开发测试 keys.json 不兼容；升级前必须删除旧测试数据，生产首次启用必须用 CSPRNG 生成：
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
export function decodeMasterKey(raw) {
  const s = String(raw).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(
      "MASTER_KEY 必须是 32 字节随机密钥（64 位 hex），不接受 base64 或低熵口令"
    );
  }
  return Buffer.from(s, "hex");
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
