import type { JsonRpcSigner, Wallet } from "ethers";

export type SignerWallet = Wallet | JsonRpcSigner;

export type NetworkKey =
  | "bsc-mainnet"
  | "bsc-testnet"
  | "eth-mainnet"
  | "polygon-mainnet"
  | "arbitrum-mainnet"
  | "optimism-mainnet"
  | "base-mainnet";

export interface WalletRuntime {
  id: string;
  name: string;
  address: string;
  privateKey: string;
  balanceWei: bigint;
}

export interface TransferRecipient {
  lineNo: number;
  address: string;
  amountText: string;
  amountWei: bigint;
}

export type SimpleTxStatus =
  | "processing"
  | "success"
  | "failed"
  | "unknown"
  | "skipped";

export interface TransferResult {
  address: string;
  amount: string;
  status: SimpleTxStatus;
  txHash?: string;
  error?: string;
}

export interface FollowerConfig {
  id: string;
  name: string;
  address: string;
  privateKey: string;
  balanceWei: bigint;
  buyAmountText: string;
  buyAmountWei: bigint;
}

export interface CopyTradeResult {
  role: "leader" | "follower";
  name: string;
  address: string;
  buyAmount: string;
  status: SimpleTxStatus;
  txHash?: string;
  error?: string;
  // 买入确认后实际到账的代币数量（balance delta），持仓记账 SoT
  receivedAmountWei?: bigint;
  // 广播前代币余额，unknown 时用于对账计算实际到账量
  balanceBeforeWei?: bigint;
  // 链上成功但到账量无法解析时的结算告警
  accountingWarning?: string;
}

// 链上 Leader 交易信号（由 monitor 解码 Router Swap 得到）
export interface TradeSignal {
  leaderAddress: string;
  txHash: string;
  direction: "buy" | "sell";
  tokenAddress: string;
  // 买入: 消耗的原生币数量（BNB wei）；卖出: 卖出的代币数量（wei）
  amountInWei: bigint;
  blockNumber: number;
}
