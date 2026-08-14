import type { Wallet } from "ethers";
import type { NetworkConfig } from "../config/networks";
import type { CopyTradeResult } from "../types";
import { safeErrorMessage } from "../utils/error";
import { buyToken } from "./pancake";

export interface CopyTradeWallet {
  role: "leader" | "follower";
  name: string;
  wallet: Wallet;
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

  try {
    const res = await buyToken({
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
      status: res.success ? "success" : "failed",
      txHash: res.hash,
      error: res.success ? undefined : "Transaction reverted",
    });

    // Leader 失败 → 立即停止，Followers 全部不执行
    if (!res.success) return;
  } catch (error) {
    onUpdate(0, {
      role: "leader",
      name: config.leader.name,
      address: config.leader.wallet.address,
      buyAmount: config.leader.amountText,
      status: "failed",
      error: safeErrorMessage(error),
    });
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

    try {
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
        status: res.success ? "success" : "failed",
        txHash: res.hash,
        error: res.success ? undefined : "Transaction reverted",
      });
    } catch (error) {
      onUpdate(index, {
        role: "follower",
        name: follower.name,
        address: follower.wallet.address,
        buyAmount: follower.amountText,
        status: "failed",
        error: safeErrorMessage(error),
      });
      // 不 Retry，继续后续 Follower
    }
  }
}
