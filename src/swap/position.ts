// 持仓账本：前端内存缓存（后台持久化见 TASK-20260815-003 持仓管理）
// 以「跟单钱包地址 + 代币地址」为键，记录买入数量与 BNB 成本，支撑手动卖出。

export interface Position {
  follower: string;
  tokenAddress: string;
  tokenSymbol: string;
  decimals: number;
  amountWei: bigint;
  costBnbWei: bigint;
  avgPriceWei: bigint;
  buyTxHash?: string;
}

const store = new Map<string, Position>();

function key(follower: string, tokenAddress: string): string {
  return `${follower.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

function buildPosition(
  follower: string,
  tokenAddress: string,
  tokenSymbol: string,
  decimals: number,
  amountWei: bigint,
  costBnbWei: bigint,
  buyTxHash?: string
): Position {
  return {
    follower,
    tokenAddress,
    tokenSymbol,
    decimals,
    amountWei,
    costBnbWei,
    avgPriceWei: amountWei > 0n ? costBnbWei / amountWei : 0n,
    buyTxHash,
  };
}

// 买入后累计仓位；同地址同代币重复买入会合并并按加权均价重算成本。
export function upsertPosition(
  follower: string,
  tokenAddress: string,
  tokenSymbol: string,
  decimals: number,
  buyAmountWei: bigint,
  costBnbWei: bigint,
  buyTxHash?: string
): Position {
  const k = key(follower, tokenAddress);
  const existing = store.get(k);
  if (!existing) {
    const pos = buildPosition(
      follower,
      tokenAddress,
      tokenSymbol,
      decimals,
      buyAmountWei,
      costBnbWei,
      buyTxHash
    );
    store.set(k, pos);
    return pos;
  }

  const amountWei = existing.amountWei + buyAmountWei;
  const totalCost = existing.costBnbWei + costBnbWei;
  const pos = buildPosition(
    follower,
    tokenAddress,
    tokenSymbol,
    decimals,
    amountWei,
    totalCost,
    buyTxHash ?? existing.buyTxHash
  );
  store.set(k, pos);
  return pos;
}

// 卖出后扣减仓位；全部卖出返回 null 并移除记录，部分卖出按均价等比扣减成本。
export function reducePosition(
  follower: string,
  tokenAddress: string,
  sellWei: bigint
): Position | null {
  const k = key(follower, tokenAddress);
  const existing = store.get(k);
  if (!existing || existing.amountWei < sellWei) return null;

  const remaining = existing.amountWei - sellWei;
  if (remaining <= 0n) {
    store.delete(k);
    return null;
  }

  const pos = buildPosition(
    existing.follower,
    existing.tokenAddress,
    existing.tokenSymbol,
    existing.decimals,
    remaining,
    (existing.costBnbWei * remaining) / existing.amountWei,
    existing.buyTxHash
  );
  store.set(k, pos);
  return pos;
}

export function getPosition(
  follower: string,
  tokenAddress: string
): Position | null {
  return store.get(key(follower, tokenAddress)) ?? null;
}

export function listPositions(): Position[] {
  return [...store.values()];
}
