import type { NetworkConfig } from "../config/networks";
import type { CopyTradeResult, SignerWallet } from "../types";
import { buyToken } from "./pancake";

export interface CopyTradeWallet {
  role: "leader" | "follower";
  name: string;
  wallet: SignerWallet;
  amountWei: bigint;
  amountText: string;
}

export interface CopyTradeConfig {
  tokenAddress: string;
  slippageBps: bigint;
  network: NetworkConfig;
  supportFeeOnTransfer: boolean;
  leader: CopyTradeWallet;
  followers: CopyTradeWallet[];
}

export async function runCopyTrade(
  config: CopyTradeConfig,
  onUpdate: (index: number, result: CopyTradeResult) => void
): Promise<CopyTradeResult[]> {
  const results: CopyTradeResult[] = [];

  // 1. Leader
  const leaderInit: CopyTradeResult = {
    role: "leader",
    name: config.leader.name,
    address: config.leader.wallet.address,
    buyAmount: config.leader.amountText,
    status: "processing",
  };
  results.push(leaderInit);
  onUpdate(0, leaderInit);

  const leaderRes = await buyToken({
    wallet: config.leader.wallet,
    tokenAddress: config.tokenAddress,
    amountInWei: config.leader.amountWei,
    slippageBps: config.slippageBps,
    network: config.network,
    supportFeeOnTransfer: config.supportFeeOnTransfer,
  });

  const leaderResult: CopyTradeResult = {
    role: "leader",
    name: config.leader.name,
    address: config.leader.wallet.address,
    buyAmount: config.leader.amountText,
    status: leaderRes.status,
    txHash: leaderRes.hash,
    error: leaderRes.error,
    expectedOutWei: leaderRes.expectedOut,
  };
  results[0] = leaderResult;
  onUpdate(0, leaderResult);

  // Leader 失败/未确认 → 停止，Followers 全部标记 skipped
  if (leaderRes.status !== "success") {
    const reason =
      leaderRes.status === "unknown"
        ? "带单交易已广播但状态未确认，跟单钱包未执行"
        : "带单买入失败，跟单钱包未执行";

    for (let i = 0; i < config.followers.length; i++) {
      const follower = config.followers[i];
      const fr: CopyTradeResult = {
        role: "follower",
        name: follower.name,
        address: follower.wallet.address,
        buyAmount: follower.amountText,
        status: "skipped",
        error: reason,
      };
      results.push(fr);
      onUpdate(i + 1, fr);
    }
    return results;
  }

  // 2. Followers 顺序跟买
  for (let i = 0; i < config.followers.length; i++) {
    const follower = config.followers[i];
    const index = i + 1;

    const init: CopyTradeResult = {
      role: "follower",
      name: follower.name,
      address: follower.wallet.address,
      buyAmount: follower.amountText,
      status: "processing",
    };
    results.push(init);
    onUpdate(index, init);

    const res = await buyToken({
      wallet: follower.wallet,
      tokenAddress: config.tokenAddress,
      amountInWei: follower.amountWei,
      slippageBps: config.slippageBps,
      network: config.network,
      supportFeeOnTransfer: config.supportFeeOnTransfer,
    });

    const fr: CopyTradeResult = {
      role: "follower",
      name: follower.name,
      address: follower.wallet.address,
      buyAmount: follower.amountText,
      status: res.status,
      txHash: res.hash,
      error: res.error,
      expectedOutWei: res.expectedOut,
    };
    results[index] = fr;
    onUpdate(index, fr);
    // 不 Retry，继续后续 Follower
  }

  return results;
}
