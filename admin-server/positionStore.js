// 持仓管理：非敏感数据，普通持久化。与跟单任务（TASK-20260815-001）的持仓账本对接：
// 买入 upsert、卖出 reduce。bigint 一律序列化为字符串。
import { randomBytes } from "node:crypto";
import { dataFile, loadJson, saveJson } from "./store.js";
import {
  normalizeAddress,
  parseNonNegativeWei,
  parseReduceWei,
  validateChainId,
  validateDecimals,
} from "./validation.js";

const POS_FILE = dataFile("positions.json");

export function loadPositions() {
  return loadJson(POS_FILE, { positions: [] }).positions;
}

export function savePositions(positions) {
  saveJson(POS_FILE, { positions });
}

export function listPositions() {
  return loadPositions();
}

function key(chainId, follower, tokenAddress) {
  return `${chainId}:${String(follower).toLowerCase()}:${String(tokenAddress).toLowerCase()}`;
}

export function upsertPosition({
  chainId,
  follower,
  tokenAddress,
  tokenSymbol,
  decimals,
  amountWei,
  costBnbWei,
  avgPriceWei,
  buyTxHash,
}) {
  const cid = validateChainId(chainId);
  const fol = normalizeAddress(follower, "follower");
  const tok = normalizeAddress(tokenAddress, "tokenAddress");
  const dec = validateDecimals(decimals ?? 18);
  const amountStr = String(parseNonNegativeWei(amountWei, "amountWei"));
  const costStr = String(parseNonNegativeWei(costBnbWei, "costBnbWei"));
  const avgStr = String(parseNonNegativeWei(avgPriceWei, "avgPriceWei"));

  const positions = loadPositions();
  const existing = positions.find((p) => p.key === key(cid, fol, tok));

  if (existing) {
    existing.amountWei = amountStr;
    existing.costBnbWei = costStr;
    existing.avgPriceWei = avgStr;
    existing.tokenSymbol = tokenSymbol ?? existing.tokenSymbol;
    existing.decimals = dec;
    existing.status = "open";
    existing.updatedAt = Date.now();
  } else {
    positions.push({
      id: randomBytes(8).toString("hex"),
      key: key(cid, fol, tok),
      chainId: cid,
      follower: fol,
      tokenAddress: tok,
      tokenSymbol: tokenSymbol ?? "",
      decimals: dec,
      amountWei: amountStr,
      costBnbWei: costStr,
      avgPriceWei: avgStr,
      status: "open",
      buyTxHash: buyTxHash || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  savePositions(positions);
  return positions.find((p) => p.key === key(cid, fol, tok));
}

export function reducePosition(chainId, follower, tokenAddress, reduceWei) {
  const cid = validateChainId(chainId);
  const fol = normalizeAddress(follower, "follower");
  const tok = normalizeAddress(tokenAddress, "tokenAddress");
  const positions = loadPositions();
  const idx = positions.findIndex((p) => p.key === key(cid, fol, tok));
  if (idx < 0) return null;

  const p = positions[idx];
  const cur = BigInt(p.amountWei ?? "0");
  // 0 < reduceWei <= 当前持仓；负数或超额均拒绝，且不写入
  const reduce = parseReduceWei(reduceWei, cur);
  const nextAmount = cur - reduce;
  if (nextAmount <= 0n) {
    p.amountWei = "0";
    p.status = "closed";
  } else {
    p.amountWei = String(nextAmount);
    // 等比扣减成本与均价
    const ratio = (nextAmount * 1_000_000n) / cur;
    p.costBnbWei = String((BigInt(p.costBnbWei ?? "0") * ratio) / 1_000_000n);
    // 均价保持不变（均价是单位成本，不随数量变化）
  }
  p.updatedAt = Date.now();
  savePositions(positions);
  return p;
}

export function deletePosition(id) {
  const positions = loadPositions();
  const next = positions.filter((p) => p.id !== id);
  if (next.length === positions.length) throw new Error("持仓记录不存在");
  savePositions(next);
}
