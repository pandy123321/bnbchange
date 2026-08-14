const PATTERNS: Array<[RegExp, string]> = [
  [/insufficient funds/i, "BNB 余额不足"],
  [/invalid private key/i, "Private Key 无效"],
  [/invalid address|bad address checksum|invalid checksum/i, "地址格式错误"],
  [/execution reverted|\breverted\b/i, "交易执行失败"],
  [/INSUFFICIENT_OUTPUT_AMOUNT|getAmountsOut|no liquidity|quote/i, "无法获取报价，可能无直接流动性"],
  [/timeout|timed out|network error/i, "RPC 请求失败，请人工检查链上状态"],
  [/nonce too low|nonce has already been used/i, "Nonce 冲突，请稍后重试"],
  [/replacement transaction underpriced/i, "Gas 价格过低，请稍后重试"],
  [/forbidden|403/i, "授权码无效或不可用"],
];

function filterSecrets(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{64}/g, "[REDACTED]")
    .replace(/(api[_-]?key=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*)(bearer\s+)?\S+/gi, "$1[REDACTED]");
}

export function safeErrorMessage(error: unknown): string {
  if (error == null) return "未知错误";

  const raw =
    typeof error === "string"
      ? error
      : (error as Error).message ??
        (error as { reason?: string }).reason ??
        String(error);

  const text = filterSecrets(String(raw));

  for (const [pattern, label] of PATTERNS) {
    if (pattern.test(text)) return label;
  }

  return text || "未知错误";
}
