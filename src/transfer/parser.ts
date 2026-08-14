import { ethers } from "ethers";
import type { TransferRecipient } from "../types";

export function parseRecipients(raw: string): TransferRecipient[] {
  const lines = raw.split(/\r?\n/);
  const output: TransferRecipient[] = [];

  lines.forEach((line, index) => {
    const value = line.trim();
    if (!value) return;

    const parts = value.split(",");
    if (parts.length !== 2) {
      throw new Error(`第 ${index + 1} 行格式错误（应为 address,amount）`);
    }

    let address: string;
    try {
      address = ethers.getAddress(parts[0].trim());
    } catch {
      throw new Error(`第 ${index + 1} 行地址格式错误`);
    }

    const amountText = parts[1].trim();
    let amountWei: bigint;
    try {
      amountWei = ethers.parseEther(amountText);
    } catch {
      throw new Error(`第 ${index + 1} 行金额格式错误`);
    }

    if (amountWei <= 0n) {
      throw new Error(`第 ${index + 1} 行金额必须大于 0`);
    }

    output.push({ lineNo: index + 1, address, amountText, amountWei });
  });

  if (output.length === 0) {
    throw new Error("请至少输入一行收款地址");
  }

  return output;
}

export function findDuplicates(recipients: TransferRecipient[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();

  for (const r of recipients) {
    if (seen.has(r.address)) dupes.add(r.address);
    seen.add(r.address);
  }

  return Array.from(dupes);
}

export function totalAmountWei(recipients: TransferRecipient[]): bigint {
  return recipients.reduce((sum, r) => sum + r.amountWei, 0n);
}
