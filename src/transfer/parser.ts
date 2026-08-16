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

// 解析 `address,amount` 每行一笔（也兼容 `address amount` 空格分隔）
export function parseRecipients(
  raw: string,
  decimals: number
): TransferRecipient[] {
  const lines = raw.split(/\r?\n/);
  const output: TransferRecipient[] = [];

  lines.forEach((line, index) => {
    const value = line.trim();
    if (!value) return;

    // 跳过表头行（CSV 模板首行 address,amount）
    if (index === 0 && /^address[\s,]+amount$/i.test(value)) return;

    const parts = value.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`第 ${index + 1} 行缺少金额（格式：address,amount）`);
    }

    const addressPart = parts[0];
    const amountPart = parts[1];

    let address: string;
    try {
      address = ethers.getAddress(addressPart);
    } catch {
      throw new Error(`第 ${index + 1} 行地址格式错误`);
    }

    let amountWei: bigint;
    try {
      amountWei = ethers.parseUnits(amountPart, decimals);
    } catch {
      throw new Error(`第 ${index + 1} 行金额格式错误`);
    }
    if (amountWei <= 0n) {
      throw new Error(`第 ${index + 1} 行金额必须大于 0`);
    }

    output.push({
      lineNo: index + 1,
      address,
      amountText: amountPart,
      amountWei,
    });
  });

  if (output.length === 0) {
    throw new Error("请至少输入一个收款地址");
  }

  return output;
}

// 统一导入解析：纯文本/CSV（address,amount 每行）或 JSON。
// JSON 支持：
//   - 数组对象 [{ "address": "0x...", "amount": "1.5" }, ...]
//   - 二维数组 [["0x...", "1.5"], ...]
export function parseRecipientInput(
  raw: string,
  decimals: number
): TransferRecipient[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("内容为空");

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("JSON 格式错误");
    }

    const recipients: TransferRecipient[] = [];
    const arr = Array.isArray(parsed) ? parsed : null;
    if (!arr) throw new Error("JSON 必须是数组");

    arr.forEach((item, index) => {
      let addressPart: string;
      let amountPart: string;
      if (Array.isArray(item)) {
        addressPart = String(item[0] ?? "");
        amountPart = String(item[1] ?? "");
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        addressPart = String(obj.address ?? obj.to ?? "");
        amountPart = String(obj.amount ?? obj.value ?? "");
      } else {
        throw new Error(`第 ${index + 1} 项格式错误`);
      }

      let address: string;
      try {
        address = ethers.getAddress(addressPart);
      } catch {
        throw new Error(`第 ${index + 1} 项地址格式错误`);
      }
      let amountWei: bigint;
      try {
        amountWei = ethers.parseUnits(amountPart, decimals);
      } catch {
        throw new Error(`第 ${index + 1} 项金额格式错误`);
      }
      if (amountWei <= 0n) throw new Error(`第 ${index + 1} 项金额必须大于 0`);

      recipients.push({
        lineNo: index + 1,
        address,
        amountText: amountPart,
        amountWei,
      });
    });

    if (recipients.length === 0) throw new Error("未解析到任何收款记录");
    return recipients;
  }

  return parseRecipients(trimmed, decimals);
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
