// 私钥加密托管仓储：私钥密文落盘，列表仅返回掩码后的公开信息。
// 明文私钥仅经 revealKey 解密返回（调用方必须已通过 RBAC + 二次鉴权）。
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "./crypto.js";
import { dataFile, loadJson, saveJson } from "./store.js";
import { deriveAddressFromPrivateKey, normalizeAddress } from "./validation.js";

const KEYS_FILE = dataFile("keys.json");

export function loadKeys() {
  return loadJson(KEYS_FILE, { keys: [] }).keys;
}

export function saveKeys(keys) {
  saveJson(KEYS_FILE, { keys });
}

// 对外掩码：不返回 enc（密文）也不返回明文私钥
function publicKey(record) {
  return {
    id: record.id,
    walletType: record.walletType,
    name: record.name ?? "",
    address: record.address,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function listKeys() {
  return loadKeys().map(publicKey);
}

export function getKey(id) {
  const rec = loadKeys().find((k) => k.id === id);
  return rec ? publicKey(rec) : null;
}

export function createKey({ walletType, name, address, privateKey }) {
  if (!["leader", "follower", "master"].includes(walletType)) {
    throw new Error("walletType 必须是 leader / follower / master");
  }
  // 私钥格式校验并自动派生钱包地址；若提交地址则必须与派生地址一致
  const pk = String(privateKey ?? "").trim();
  const derived = deriveAddressFromPrivateKey(pk);
  const provided =
    address == null || String(address).trim() === ""
      ? null
      : normalizeAddress(address, "address");
  if (provided && provided.toLowerCase() !== derived.toLowerCase()) {
    throw new Error("address 与私钥不匹配");
  }
  const keys = loadKeys();
  const record = {
    id: randomBytes(8).toString("hex"),
    walletType,
    name: name ?? "",
    address: derived,
    enc: encrypt(pk),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  keys.push(record);
  saveKeys(keys);
  return publicKey(record);
}

export function updateKey(id, patch) {
  const keys = loadKeys();
  const rec = keys.find((k) => k.id === id);
  if (!rec) throw new Error("私钥记录不存在");

  if (patch.walletType != null) {
    if (!["leader", "follower", "master"].includes(patch.walletType)) {
      throw new Error("walletType 必须是 leader / follower / master");
    }
    rec.walletType = patch.walletType;
  }
  if (patch.name != null) rec.name = patch.name;

  // address 永远是 privateKey 的派生属性，禁止独立修改，
  // 否则 UI 显示的地址会与实际加密私钥永久不一致，破坏资金安全。
  if (patch.address != null && patch.privateKey == null) {
    throw new Error("address 不能独立修改，请通过更新 privateKey 自动派生地址");
  }
  if (patch.privateKey != null) {
    const pk = String(patch.privateKey).trim();
    const derived = deriveAddressFromPrivateKey(pk);
    // 同时提交 address 时仅用于一致性校验，最终仍以 derived 为 SoT
    if (
      patch.address != null &&
      normalizeAddress(patch.address, "address").toLowerCase() !== derived.toLowerCase()
    ) {
      throw new Error("address 与私钥不匹配");
    }
    rec.address = derived;
    rec.enc = encrypt(pk);
  }
  rec.updatedAt = Date.now();
  saveKeys(keys);
  return publicKey(rec);
}

export function deleteKey(id) {
  const keys = loadKeys();
  const next = keys.filter((k) => k.id !== id);
  if (next.length === keys.length) throw new Error("私钥记录不存在");
  saveKeys(next);
}

// 解密明文私钥（危险操作，调用方必须已审计）
export function revealKey(id) {
  const rec = loadKeys().find((k) => k.id === id);
  if (!rec) throw new Error("私钥记录不存在");
  return decrypt(rec.enc);
}
