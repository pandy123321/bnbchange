// 持仓账本：前端内存缓存（后台持久化见 TASK-20260815-003 持仓管理）
// 以「chainId + 跟单钱包地址 + 代币地址」为键，跨链完全隔离，防止串链卖出。

export interface Position {
  chainId: number;
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

function key(
  chainId: number,
  follower: string,
  tokenAddress: string
): string {
  return `${chainId}:${follower.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

function buildPosition(
  chainId: number,
  follower: string,
  tokenAddress: string,
  tokenSymbol: string,
  decimals: number,
  amountWei: bigint,
  costBnbWei: bigint,
  buyTxHash?: string
): Position {
  return {
    chainId,
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

// 买入后累计仓位；同链同地址同代币重复买入会合并并按加权均价重算成本。
export function upsertPosition(
  chainId: number,
  follower: string,
  tokenAddress: string,
  tokenSymbol: string,
  decimals: number,
  buyAmountWei: bigint,
  costBnbWei: bigint,
  buyTxHash?: string
): Position {
  const k = key(chainId, follower, tokenAddress);
  const existing = store.get(k);
  if (!existing) {
    const pos = buildPosition(
      chainId,
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
    chainId,
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
  chainId: number,
  follower: string,
  tokenAddress: string,
  sellWei: bigint
): Position | null {
  const k = key(chainId, follower, tokenAddress);
  const existing = store.get(k);
  if (!existing || existing.amountWei < sellWei) return null;

  const remaining = existing.amountWei - sellWei;
  if (remaining <= 0n) {
    store.delete(k);
    return null;
  }

  const pos = buildPosition(
    existing.chainId,
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

// 幂等设置「确定目标持仓」：直接覆盖为精确的 amountWei / costBnbWei。
// 供对账后恢复账本使用；重复调用同一目标得到完全相同结果，不会重复加减仓。
// amountWei <= 0 时移除记录（返回 null）。
export function setPosition(
  chainId: number,
  follower: string,
  tokenAddress: string,
  tokenSymbol: string,
  decimals: number,
  amountWei: bigint,
  costBnbWei: bigint,
  buyTxHash?: string
): Position | null {
  const k = key(chainId, follower, tokenAddress);
  if (amountWei <= 0n) {
    store.delete(k);
    return null;
  }
  const pos = buildPosition(
    chainId,
    follower,
    tokenAddress,
    tokenSymbol,
    decimals,
    amountWei,
    costBnbWei,
    buyTxHash
  );
  store.set(k, pos);
  return pos;
}

export function getPosition(
  chainId: number,
  follower: string,
  tokenAddress: string
): Position | null {
  return store.get(key(chainId, follower, tokenAddress)) ?? null;
}

export function listPositions(chainId: number): Position[] {
  return [...store.values()].filter((p) => p.chainId === chainId);
}
