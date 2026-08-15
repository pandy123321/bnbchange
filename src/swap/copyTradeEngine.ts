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
    receivedAmountWei: leaderRes.receivedAmountWei,
    accountingWarning: leaderRes.accountingWarning,
  };
  results[0] = leaderResult;
  onUpdate(0, leaderResult);

  // 是否允许继续跟单：Leader 链上成功、实际到账 > 0、且无结算告警才可触发 Followers
  const leaderFollowable =
    leaderRes.status === "success" &&
    leaderRes.receivedAmountWei > 0n &&
    !leaderRes.accountingWarning;

  // Leader 失败/未确认/到账异常 → 停止，Followers 全部标记 skipped
  if (!leaderFollowable) {
    let reason: string;
    if (leaderRes.status === "unknown") {
      reason = "带单交易已广播但状态未确认，跟单钱包未执行";
    } else if (leaderRes.status !== "success") {
      reason = "带单买入失败，跟单钱包未执行";
    } else {
      reason = "带单买入已确认，但实际到账异常，已停止跟单";
    }

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
      receivedAmountWei: res.receivedAmountWei,
      accountingWarning: res.accountingWarning,
    };
    results[index] = fr;
    onUpdate(index, fr);
    // 不 Retry，继续后续 Follower
  }

  return results;
}
