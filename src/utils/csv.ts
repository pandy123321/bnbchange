import type { CopyTradeResult, TransferResult } from "../types";

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(escapeCsv).join(",")).join("\r\n");
}

function download(filename: string, content: string): void {
  const blob = new Blob(["\uFEFF" + content], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportTransferCsv(results: TransferResult[]): void {
  const rows: string[][] = [
    ["address", "amount", "status", "tx_hash", "error"],
  ];
  for (const r of results) {
    rows.push([r.address, r.amount, r.status, r.txHash ?? "", r.error ?? ""]);
  }
  download("batch_transfer_results.csv", toCsv(rows));
}

export function exportCopyTradeCsv(results: CopyTradeResult[]): void {
  const rows: string[][] = [
    ["role", "name", "address", "buy_amount", "status", "tx_hash", "error"],
  ];
  for (const r of results) {
    rows.push([
      r.role,
      r.name,
      r.address,
      r.buyAmount,
      r.status,
      r.txHash ?? "",
      r.error ?? "",
    ]);
  }
  download("copy_trade_results.csv", toCsv(rows));
}
