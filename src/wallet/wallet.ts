import { ethers } from "ethers";

export function normalizePrivateKey(input: string): string {
  const key = input.trim();

  if (!key) {
    throw new Error("Private Key 不能为空");
  }

  return key.startsWith("0x") ? key : `0x${key}`;
}

export function createWallet(
  privateKey: string,
  provider?: ethers.Provider
): ethers.Wallet {
  const normalized = normalizePrivateKey(privateKey);

  try {
    return new ethers.Wallet(normalized, provider);
  } catch {
    throw new Error("Private Key 无效");
  }
}

export async function getWalletBalance(
  address: string,
  provider: ethers.Provider
): Promise<bigint> {
  return provider.getBalance(address);
}
