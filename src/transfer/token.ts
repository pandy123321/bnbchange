import { ethers } from "ethers";
import type { TokenConfig } from "../config/networks";
import type { SignerWallet } from "../types";
import { ERC20_ABI } from "./abi";

export function isNative(token: TokenConfig): boolean {
  return token.address == null;
}

export async function getTokenBalance(
  token: TokenConfig,
  address: string,
  provider: ethers.Provider
): Promise<bigint> {
  if (isNative(token)) {
    return provider.getBalance(address);
  }
  const contract = new ethers.Contract(token.address!, ERC20_ABI, provider);
  return contract.balanceOf(address);
}

export function formatAmount(wei: bigint, decimals: number): string {
  return ethers.formatUnits(wei, decimals);
}

export function parseAmount(text: string, decimals: number): bigint {
  return ethers.parseUnits(text, decimals);
}

export async function estimateTransferGas(
  wallet: SignerWallet,
  token: TokenConfig,
  to: string,
  amountWei: bigint
): Promise<bigint> {
  if (isNative(token)) {
    return BigInt(
      await wallet.estimateGas({ to, value: amountWei })
    );
  }
  const contract = new ethers.Contract(token.address!, ERC20_ABI, wallet);
  return BigInt(await contract.transfer.estimateGas(to, amountWei));
}

export async function sendTransfer(
  wallet: SignerWallet,
  token: TokenConfig,
  to: string,
  amountWei: bigint
): Promise<ethers.TransactionResponse> {
  if (isNative(token)) {
    return wallet.sendTransaction({ to, value: amountWei });
  }
  const contract = new ethers.Contract(token.address!, ERC20_ABI, wallet);
  return contract.transfer(to, amountWei);
}

// 自定义代币：从链上读取 decimals / symbol / name 用于金额解析与余额显示
export async function fetchTokenConfig(
  address: string,
  provider: ethers.Provider
): Promise<TokenConfig> {
  const checksummed = ethers.getAddress(address);
  const contract = new ethers.Contract(checksummed, ERC20_ABI, provider);

  const [symbol, name, decimals] = await Promise.all([
    contract.symbol(),
    contract.name(),
    contract.decimals(),
  ]);

  return {
    symbol: String(symbol),
    name: String(name),
    address: checksummed,
    decimals: Number(decimals),
  };
}
