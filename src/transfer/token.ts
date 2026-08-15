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

// 原生币/ERC20 转账余额预检（供批量转账与测试复用，Fail Closed）：
// - 原生币转账：余额 >= 总转账本金 + 总 Gas（合并判断）
// - ERC20 转账：代币余额 >= 本金，且原生币余额 >= 总 Gas（分别判断）
export function checkTransferFunds(
  token: TokenConfig,
  tokenBalance: bigint,
  nativeBalance: bigint,
  totalValue: bigint,
  totalGasCost: bigint
): { ok: boolean; reason?: string } {
  if (isNative(token)) {
    if (nativeBalance < totalValue + totalGasCost) {
      return { ok: false, reason: "原生币余额不足（需 ≥ 本金 + Gas）" };
    }
    return { ok: true };
  }
  if (tokenBalance < totalValue) {
    return { ok: false, reason: "代币余额不足（需 ≥ 本金）" };
  }
  if (nativeBalance < totalGasCost) {
    return { ok: false, reason: "原生币余额不足（需 ≥ Gas）" };
  }
  return { ok: true };
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

// 校验收据中确实存在「发送方 → 收款方」的 ERC20 Transfer 事件（value > 0）。
// 用于识别「transfer 返回 false 但未回滚」的代币：收据 status 仍为 1，但没有真实转账事件。
// 兼容正常 ERC20 与常见手续费代币（FOT 实际到账量小于 amountWei 仍会发出 Transfer 事件）。
export function verifyErc20Transfer(
  receipt: ethers.TransactionReceipt,
  tokenAddress: string,
  from: string,
  to: string,
  amountWei: bigint
): boolean {
  const iface = new ethers.Interface(ERC20_ABI);
  const token = tokenAddress.toLowerCase();
  const fromL = from.toLowerCase();
  const toL = to.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token) continue;
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== "Transfer") continue;
      const args = parsed.args;
      if (
        String(args.from).toLowerCase() === fromL &&
        String(args.to).toLowerCase() === toL &&
        BigInt(args.value) > 0n
      ) {
        return true;
      }
    } catch {
      // 非本代币 Transfer 主题的日志，跳过
    }
  }
  return false;
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
