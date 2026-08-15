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
}
