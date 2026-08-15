// 输入校验辅助函数：后台接口统一复用，避免重复安全逻辑。
// 所有校验失败均抛出 Error（由 server.js 捕获后返回 400），保证零写入。
import { ethers } from "ethers";

// 钱包地址 / 代币地址：ethers 地址校验（EIP-55 校验和），返回规范地址
export function normalizeAddress(value, field = "地址") {
  try {
    return ethers.getAddress(String(value ?? ""));
  } catch {
    throw new Error(`${field}格式错误`);
  }
}

// chainId：允许的正整数链 ID
export function validateChainId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("chainId 必须是正整数");
  }
  return n;
}

// Wei 字段：非负十进制整数字符串，返回 bigint
export function parseNonNegativeWei(value, field = "数量") {
  const s = String(value ?? "");
  if (!/^\d+$/.test(s)) {
    throw new Error(`${field} 必须是非负十进制整数字符串`);
  }
  return BigInt(s);
}

// 减仓数量：必须 > 0，且不得超过当前持仓
export function parseReduceWei(value, current) {
  const reduce = parseNonNegativeWei(value, "reduceWei");
  if (reduce <= 0n) {
    throw new Error("reduceWei 必须大于 0");
  }
  if (reduce > current) {
    throw new Error("reduceWei 不能超过当前持仓");
  }
  return reduce;
}

// decimals：非负整数
export function validateDecimals(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("decimals 必须是非负整数");
  }
  return n;
}

// 私钥格式校验 + 派生钱包地址
export function deriveAddressFromPrivateKey(privateKey) {
  const pk = String(privateKey ?? "").trim();
  if (!pk) throw new Error("私钥不能为空");
  try {
    const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
    return wallet.address;
  } catch {
    throw new Error("私钥格式无效");
  }
}
