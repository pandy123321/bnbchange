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
): Promise<void> {
  // 1. Leader
  onUpdate(0, {
    role: "leader",
    name: config.leader.name,
    address: config.leader.wallet.address,
    buyAmount: config.leader.amountText,
    status: "processing",
  });

  const leaderRes = await buyToken({
    wallet: config.leader.wallet,
    tokenAddress: config.tokenAddress,
    amountInWei: config.leader.amountWei,
    slippageBps: config.slippageBps,
    network: config.network,
    supportFeeOnTransfer: config.supportFeeOnTransfer,
  });

  onUpdate(0, {
    role: "leader",
    name: config.leader.name,
    address: config.leader.wallet.address,
    buyAmount: config.leader.amountText,
    status: leaderRes.status,
    txHash: leaderRes.hash,
    error: leaderRes.error,
  });

  // Leader 失败/未确认 → 停止，Followers 全部标记 skipped
  if (leaderRes.status !== "success") {
    const reason =
      leaderRes.status === "unknown"
        ? "带单交易已广播但状态未确认，跟单钱包未执行"
        : "带单买入失败，跟单钱包未执行";

    for (let i = 0; i < config.followers.length; i++) {
      const follower = config.followers[i];
      onUpdate(i + 1, {
        role: "follower",
        name: follower.name,
        address: follower.wallet.address,
        buyAmount: follower.amountText,
        status: "skipped",
        error: reason,
      });
    }
    return;
  }

  // 2. Followers 顺序跟买
  for (let i = 0; i < config.followers.length; i++) {
    const follower = config.followers[i];
    const index = i + 1;

    onUpdate(index, {
      role: "follower",
      name: follower.name,
      address: follower.wallet.address,
      buyAmount: follower.amountText,
      status: "processing",
    });

    const res = await buyToken({
      wallet: follower.wallet,
      tokenAddress: config.tokenAddress,
      amountInWei: follower.amountWei,
      slippageBps: config.slippageBps,
      network: config.network,
      supportFeeOnTransfer: config.supportFeeOnTransfer,
    });

    onUpdate(index, {
      role: "follower",
      name: follower.name,
      address: follower.wallet.address,
      buyAmount: follower.amountText,
      status: res.status,
      txHash: res.hash,
      error: res.error,
    });
    // 不 Retry，继续后续 Follower
  }
}
