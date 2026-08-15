import { ethers } from "ethers";
import type { TransferRecipient } from "../types";

export interface ParsedAddress {
  lineNo: number;
  address: string;
}

export function parseAddresses(raw: string): ParsedAddress[] {
  const lines = raw.split(/\r?\n/);
  const output: ParsedAddress[] = [];

  lines.forEach((line, index) => {
    const value = line.trim();
    if (!value) return;

    let address: string;
    try {
      address = ethers.getAddress(value);
    } catch {
      throw new Error(`第 ${index + 1} 行地址格式错误`);
    }

    output.push({ lineNo: index + 1, address });
  });

  if (output.length === 0) {
    throw new Error("请至少输入一个收款地址");
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
