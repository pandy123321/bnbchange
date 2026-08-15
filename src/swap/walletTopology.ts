// 钱包拓扑校验：拒绝危险的钱包关系（Follower 与 Leader 相同、Follower 重复）。
// 纯函数、无副作用、无依赖，供手工跟单与自动监听在真正广播前重复校验。
//
// 关键约束：
// 1. 所有地址按规范化（checksum 后小写）比较，禁止大小写差异绕过。
// 2. 不能在“解析输入时”只检查一次——Leader 可能在解析 Follower 之后发生变化，
//    因此 start() / startMonitor() 必须用最新 Leader 与 Follower 重新校验。
import { ethers } from "ethers";

// 规范化地址：合法则返回小写十六进制，非法则返回 null（不抛错，便于组合出友好错误）。
function normalizeAddress(address: string): string | null {
  try {
    return ethers.getAddress(address).toLowerCase();
  } catch {
    return null;
  }
}

export interface WalletTopologyResult {
  ok: boolean;
  error?: string;
}

export function validateWalletTopology(
  leaderAddress: string,
  followerAddresses: string[]
): WalletTopologyResult {
  const leader = normalizeAddress(leaderAddress);
  if (!leader) {
    return { ok: false, error: "带单钱包地址无效" };
  }

  const seen = new Set<string>();
  for (const addr of followerAddresses) {
    const f = normalizeAddress(addr);
    if (!f) {
      return { ok: false, error: `跟单钱包地址无效：${addr}` };
    }
    if (f === leader) {
      return {
        ok: false,
        error: "跟单钱包地址不能与带单地址相同，已阻止执行",
      };
    }
    if (seen.has(f)) {
      return {
        ok: false,
        error: `跟单钱包地址重复（${addr}），已阻止执行`,
      };
    }
    seen.add(f);
  }

  return { ok: true };
}
