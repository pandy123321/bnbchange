// 简单跟单策略：比例 / 倍数 + 只跟一次 + 最小跟单金额 + 跟卖
// 纯函数，无副作用，便于单测与复用。

export interface CopyStrategy {
  // 买入策略
  buyMode: "ratio" | "multiplier"; // 比例（0~1）或 倍数（可 >1）
  buyValue: number;
  buyOnlyOnce: boolean; // 本次监听会话内，同一 Leader 对同一代币只跟首次买入
  buyMinEnabled: boolean; // 是否开启最小跟单金额过滤
  buyMinAmountWei?: bigint; // 最小跟单金额阈值（仅 buyMinEnabled=true 时生效，必须 > 0）
  // 卖出策略
  copySell: boolean; // 是否跟卖
  sellMode: "ratio" | "multiplier";
  sellValue: number; // 卖出比例 0~1 或 倍数（截断到 ≤ 持仓）
}

// 倍数上限：防止 Math.round(value * 1e6) 超出 Number 安全整数（2^53 ≈ 9e15）导致精度丢失或 BigInt 转换崩溃。
// 1e9 倍已远超任何合理跟单需求，仅作为硬性防御边界。
const MAX_MULTIPLIER = 1_000_000_000;

export function validateStrategy(s: CopyStrategy): string | null {
  if (!Number.isFinite(s.buyValue)) {
    return "买入参数必须是有限数字";
  }
  if (s.buyMode === "ratio" && (s.buyValue <= 0 || s.buyValue > 1)) {
    return "买入比例必须在 0~1 之间";
  }
  if (s.buyMode === "multiplier" && s.buyValue <= 0) {
    return "买入倍数必须大于 0";
  }
  if (s.buyMode === "multiplier" && s.buyValue > MAX_MULTIPLIER) {
    return "买入倍数超出安全上限";
  }
  // 最小跟单金额：开启时必须有有效正值，空/0/非法一律 Fail Closed（禁止交易）。
  if (s.buyMinEnabled) {
    if (s.buyMinAmountWei == null || s.buyMinAmountWei <= 0n) {
      return "最小跟单金额必须填写大于 0 的数值";
    }
  }
  if (s.copySell) {
    if (!Number.isFinite(s.sellValue)) {
      return "卖出参数必须是有限数字";
    }
    if (s.sellMode === "ratio" && (s.sellValue <= 0 || s.sellValue > 1)) {
      return "卖出比例必须在 0~1 之间";
    }
    if (s.sellMode === "multiplier" && s.sellValue <= 0) {
      return "卖出倍数必须大于 0";
    }
    if (s.sellMode === "multiplier" && s.sellValue > MAX_MULTIPLIER) {
      return "卖出倍数超出安全上限";
    }
  }
  return null;
}

// 买入金额 = Leader 买入额 × 比例 / 倍数
export function calcBuyAmount(
  leaderWei: bigint,
  strategy: CopyStrategy
): bigint {
  if (leaderWei <= 0n) return 0n;
  if (strategy.buyMode === "ratio") {
    // 比例 0~1：round(leaderWei * value) 四舍五入
    return (leaderWei * BigInt(Math.round(strategy.buyValue * 1e6))) / 1_000_000n;
  }
  // 倍数：round(leaderWei * value)
  return (
    (leaderWei * BigInt(Math.round(strategy.buyValue * 1e6))) / 1_000_000n
  );
}

// 卖出数量 = 当前持仓 × 比例 / 倍数，截断到 ≤ 当前持仓
export function calcSellQuantity(
  positionWei: bigint,
  strategy: CopyStrategy
): bigint {
  if (positionWei <= 0n) return 0n;
  if (strategy.sellMode === "ratio") {
    const qty =
      (positionWei * BigInt(Math.round(strategy.sellValue * 1e6))) / 1_000_000n;
    return qty > positionWei ? positionWei : qty;
  }
  const qty =
    (positionWei * BigInt(Math.round(strategy.sellValue * 1e6))) / 1_000_000n;
  return qty > positionWei ? positionWei : qty;
}

// 最小跟单金额过滤：开启时，阈值必须有效，否则 Fail Closed（返回 false，不跟随）。
// 调用方在真实资金路径上必经 validateStrategy，此处作为纯函数自身的最后防线。
export function shouldFollow(
  leaderWei: bigint,
  strategy: CopyStrategy
): boolean {
  if (!strategy.buyMinEnabled) return true;
  if (strategy.buyMinAmountWei == null || strategy.buyMinAmountWei <= 0n) {
    return false;
  }
  return leaderWei >= strategy.buyMinAmountWei;
}

// 只跟一次的键：同一 Leader + 同一代币
export function buyOnceKey(leaderAddress: string, tokenAddress: string): string {
  return `${leaderAddress.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

export function defaultStrategy(): CopyStrategy {
  return {
    buyMode: "ratio",
    buyValue: 1,
    buyOnlyOnce: false,
    buyMinEnabled: false,
    buyMinAmountWei: undefined,
    copySell: true,
    sellMode: "ratio",
    sellValue: 1,
  };
}
