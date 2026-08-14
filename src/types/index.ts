export type NetworkKey = "bsc-mainnet" | "bsc-testnet";

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

export type SimpleTxStatus = "processing" | "success" | "failed";

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
