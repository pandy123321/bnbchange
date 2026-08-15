import { describe, it, expect, beforeEach } from "vitest";
import { ethers } from "ethers";
import {
  addUnresolved,
  applyReconciliation,
  clearUnresolved,
  hasUnresolved,
  loadUnresolved,
  reconcileTx,
  removeUnresolved,
  unresolvedGateReason,
  UNRESOLVED_STORAGE_KEY,
  type UnresolvedTx,
  type ReconcileResult,
} from "../src/swap/unresolved";
import { getPosition, upsertPosition } from "../src/swap/position";

const CHAIN = 56;
const TOKEN = "0x55d398326f99059fF775485246999027B3197955";

let walletSeq = 0;
function newWallet(): string {
  walletSeq += 1;
  return "0x" + walletSeq.toString(16).padStart(40, "0");
}

function makeTx(overrides: Partial<UnresolvedTx> = {}): UnresolvedTx {
  return {
    id: "t1",
    chainId: CHAIN,
    txHash: "0x" + "ab".repeat(32),
    walletAddress: newWallet(),
    tokenAddress: TOKEN.toLowerCase(),
    tokenSymbol: "USDT",
    tokenDecimals: 18,
    side: "buy",
    phase: "swap",
    accountingRole: "follower",
    plannedAmountWei: 1_000_000_000_000_000_000n,
    balanceBeforeWei: 0n,
    snapshotBefore: {
      amountWei: 0n,
      costBnbWei: 0n,
      tokenSymbol: "USDT",
      decimals: 18,
    },
    createdAt: Date.now(),
    ...overrides,
  };
}

function providerWith(
  receipt: { status: number | null } | null,
  chainId: number = CHAIN
) {
  return {
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getTransactionReceipt: async () => receipt,
  } as unknown as ethers.Provider;
}

// ---- 模拟 localStorage（node 环境下全局无 localStorage） ----

interface StorageMock {
  data: Record<string, string>;
  throwOnSet: boolean;
  throwOnGet: boolean;
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
}

function installStorage(): StorageMock {
  const mock: StorageMock = {
    data: {},
    throwOnSet: false,
    throwOnGet: false,
    getItem(k: string) {
      if (mock.throwOnGet) throw new Error("getItem fail");
      return k in mock.data ? mock.data[k] : null;
    },
    setItem(k: string, v: string) {
      if (mock.throwOnSet) throw new Error("setItem fail");
      mock.data[k] = v;
    },
    removeItem(k: string) {
      delete mock.data[k];
    },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = mock;
  return mock;
}

function uninstallStorage() {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
}

beforeEach(() => {
  uninstallStorage();
  clearUnresolved();
});

describe("一、区分 Leader 与 Follower 的对账行为", () => {
  it("Leader unknown 买入最终成功，不创建任何 Position", async () => {
    const tx = makeTx({
      accountingRole: "leader",
      snapshotBefore: undefined,
      balanceBeforeWei: 0n,
    });
    const res = await reconcileTx(tx, providerWith({ status: 1 }), async () => 100n);
    expect(res.outcome).toBe("buy-success");
    const apply = applyReconciliation(tx, res);
    expect(apply.status).toBe("applied");
    expect(getPosition(CHAIN, tx.walletAddress, TOKEN.toLowerCase())).toBeNull();
  });

  it("Follower unknown 买入最终成功，按实际到账量创建 Position", async () => {
    const tx = makeTx({
      accountingRole: "follower",
      snapshotBefore: { amountWei: 0n, costBnbWei: 0n, tokenSymbol: "USDT", decimals: 18 },
      balanceBeforeWei: 100n,
      plannedAmountWei: 500n,
    });
    const res = await reconcileTx(tx, providerWith({ status: 1 }), async () => 1000n);
    expect(res.outcome).toBe("buy-success");
    expect(res.receivedAmountWei).toBe(900n);
    const apply = applyReconciliation(tx, res);
    expect(apply.status).toBe("applied");
    const pos = getPosition(CHAIN, tx.walletAddress, TOKEN.toLowerCase());
    expect(pos?.amountWei).toBe(900n);
    expect(pos?.costBnbWei).toBe(500n);
  });

  it("Leader 与 Follower 相同交易类型，对账行为仍按显式角色区分", () => {
    const leaderRes: ReconcileResult = {
      outcome: "buy-success",
      receivedAmountWei: 100n,
      message: "买入已确认",
    };
    const followerRes: ReconcileResult = {
      outcome: "buy-success",
      receivedAmountWei: 100n,
      message: "买入已确认",
    };
    const leaderTx = makeTx({ accountingRole: "leader", snapshotBefore: undefined });
    const followerTx = makeTx({ accountingRole: "follower" });

    expect(applyReconciliation(leaderTx, leaderRes).status).toBe("applied");
    expect(getPosition(CHAIN, leaderTx.walletAddress, TOKEN.toLowerCase())).toBeNull();

    expect(applyReconciliation(followerTx, followerRes).status).toBe("applied");
    expect(getPosition(CHAIN, followerTx.walletAddress, TOKEN.toLowerCase())?.amountWei).toBe(100n);
  });
});

describe("二、unresolved 持久化必须 Fail Closed", () => {
  it("localStorage.setItem 抛错后，门禁仍保持", () => {
    const storage = installStorage();
    storage.throwOnSet = true;
    addUnresolved({
      chainId: CHAIN,
      txHash: "0x" + "cd".repeat(32),
      walletAddress: newWallet(),
      tokenAddress: TOKEN.toLowerCase(),
      tokenSymbol: "USDT",
      tokenDecimals: 18,
      side: "buy",
      phase: "swap",
      accountingRole: "follower",
      plannedAmountWei: 1n,
      balanceBeforeWei: 0n,
    });
    expect(hasUnresolved()).toBe(true);
    expect(unresolvedGateReason()).not.toBeNull();
  });

  it("写入非法 JSON，门禁必须 Fail Closed", () => {
    const storage = installStorage();
    storage.data[UNRESOLVED_STORAGE_KEY] = "{ not valid json";
    expect(unresolvedGateReason()).not.toBeNull();
    expect(unresolvedGateReason()).toMatch(/损坏或格式非法/);
    // 不得自动清空损坏数据
    expect(storage.data[UNRESOLVED_STORAGE_KEY]).toBe("{ not valid json");
  });

  it("写入非法字段（负数数量/非法地址/非法枚举/非法 BigInt），门禁必须 Fail Closed", () => {
    const storage = installStorage();
    const base = {
      chainId: CHAIN,
      txHash: "0x" + "ab".repeat(32),
      walletAddress: newWallet(),
      tokenAddress: TOKEN.toLowerCase(),
      tokenSymbol: "USDT",
      tokenDecimals: 18,
      side: "buy",
      phase: "swap",
      accountingRole: "follower",
      plannedAmountWei: "1",
      createdAt: 123,
    };
    const cases: Record<string, unknown>[] = [
      { ...base, plannedAmountWei: "-5" }, // 负数数量
      { ...base, walletAddress: "0x123" }, // 非法地址
      { ...base, side: "mint" }, // 非法枚举
      { ...base, plannedAmountWei: "abc" }, // 非法 BigInt
      { ...base, chainId: 0 }, // 非正整数
    ];
    for (const c of cases) {
      clearUnresolved();
      storage.data[UNRESOLVED_STORAGE_KEY] = JSON.stringify([c]);
      expect(unresolvedGateReason()).not.toBeNull();
      expect(unresolvedGateReason()).toMatch(/损坏或格式非法/);
    }
  });

  it("存储失败后的 remount 仍能从内存回退看到 unresolved", () => {
    const storage = installStorage();
    storage.throwOnSet = true;
    addUnresolved({
      chainId: CHAIN,
      txHash: "0x" + "ef".repeat(32),
      walletAddress: newWallet(),
      tokenAddress: TOKEN.toLowerCase(),
      tokenSymbol: "USDT",
      tokenDecimals: 18,
      side: "buy",
      phase: "swap",
      accountingRole: "follower",
      plannedAmountWei: 2n,
      balanceBeforeWei: 0n,
    });
    // 模拟 remount：再次 loadUnresolved 仍能看到内存回退记录
    const list = loadUnresolved();
    expect(list.length).toBe(1);
    expect(unresolvedGateReason()).not.toBeNull();
  });

  it("修复存储后，合法记录可以正常加载和对账", async () => {
    const storage = installStorage();
    addUnresolved({
      chainId: CHAIN,
      txHash: "0x" + "11".repeat(32),
      walletAddress: newWallet(),
      tokenAddress: TOKEN.toLowerCase(),
      tokenSymbol: "USDT",
      tokenDecimals: 18,
      side: "buy",
      phase: "swap",
      accountingRole: "follower",
      plannedAmountWei: 3n,
      balanceBeforeWei: 0n,
      snapshotBefore: { amountWei: 0n, costBnbWei: 0n, tokenSymbol: "USDT", decimals: 18 },
    });
    expect(storage.data[UNRESOLVED_STORAGE_KEY]).toBeTruthy();
    // 合法记录应可被反序列化校验通过
    const list = loadUnresolved();
    expect(list.length).toBe(1);
    const res = await reconcileTx(
      list[0],
      providerWith({ status: 1 }),
      async () => 10n
    );
    expect(res.outcome).toBe("buy-success");
  });
});

describe("三、对账后的持仓更新必须可恢复、可验证、幂等", () => {
  it("原持仓 100、unknown 部分卖出 40，重载后对账成功，最终持仓为 60", async () => {
    // 重载后 Position Map 为空，仅靠快照恢复
    const tx = makeTx({
      side: "sell",
      phase: "swap",
      plannedAmountWei: 40n,
      snapshotBefore: { amountWei: 100n, costBnbWei: 1000n, tokenSymbol: "USDT", decimals: 18, buyTxHash: "0x" + "22".repeat(32) },
    });
    const res = await reconcileTx(tx, providerWith({ status: 1 }), async () => 0n);
    expect(res.outcome).toBe("sell-success");
    expect(applyReconciliation(tx, res).status).toBe("applied");
    const pos = getPosition(CHAIN, tx.walletAddress, TOKEN.toLowerCase());
    expect(pos?.amountWei).toBe(60n);
    // 成本按均价等比扣减：1000 * 60 / 100
    expect(pos?.costBnbWei).toBe(600n);
  });

  it("原持仓 100、unknown 买入实际到账 25，重载后最终持仓 125，成本正确累计", async () => {
    const tx = makeTx({
      side: "buy",
      phase: "swap",
      plannedAmountWei: 250n,
      balanceBeforeWei: 50n,
      snapshotBefore: { amountWei: 100n, costBnbWei: 1000n, tokenSymbol: "USDT", decimals: 18, buyTxHash: "0x" + "33".repeat(32) },
    });
    // 广播前 50，对账时 75 → 实际到账 25
    const res = await reconcileTx(tx, providerWith({ status: 1 }), async () => 75n);
    expect(res.outcome).toBe("buy-success");
    expect(res.receivedAmountWei).toBe(25n);
    expect(applyReconciliation(tx, res).status).toBe("applied");
    const pos = getPosition(CHAIN, tx.walletAddress, TOKEN.toLowerCase());
    expect(pos?.amountWei).toBe(125n);
    expect(pos?.costBnbWei).toBe(1250n);
  });

  it("Leader unknown 买入成功，模拟重载后仍不创建 Follower 持仓", () => {
    const tx = makeTx({ accountingRole: "leader", snapshotBefore: undefined });
    const res: ReconcileResult = {
      outcome: "buy-success",
      receivedAmountWei: 25n,
      message: "买入已确认",
    };
    expect(applyReconciliation(tx, res).status).toBe("applied");
    expect(getPosition(CHAIN, tx.walletAddress, TOKEN.toLowerCase())).toBeNull();
  });

  it("同一个 buy-success 对账重复应用两次，持仓不得重复增加", () => {
    const tx = makeTx({
      snapshotBefore: { amountWei: 0n, costBnbWei: 0n, tokenSymbol: "USDT", decimals: 18 },
      plannedAmountWei: 500n,
    });
    const res: ReconcileResult = {
      outcome: "buy-success",
      receivedAmountWei: 25n,
      message: "买入已确认",
    };
    expect(applyReconciliation(tx, res).status).toBe("applied");
    expect(applyReconciliation(tx, res).status).toBe("applied");
    const pos = getPosition(CHAIN, tx.walletAddress, TOKEN.toLowerCase());
    expect(pos?.amountWei).toBe(25n);
    expect(pos?.costBnbWei).toBe(500n);
  });

  it("同一个 sell-success 对账重复应用两次，持仓不得重复减少", () => {
    const tx = makeTx({
      side: "sell",
      phase: "swap",
      plannedAmountWei: 40n,
      snapshotBefore: { amountWei: 100n, costBnbWei: 1000n, tokenSymbol: "USDT", decimals: 18 },
    });
    const res: ReconcileResult = { outcome: "sell-success", message: "卖出已确认" };
    expect(applyReconciliation(tx, res).status).toBe("applied");
    expect(applyReconciliation(tx, res).status).toBe("applied");
    const pos = getPosition(CHAIN, tx.walletAddress, TOKEN.toLowerCase());
    expect(pos?.amountWei).toBe(60n);
  });

  it("账本更新失败（快照缺失）时，不修改持仓且 unresolved 不得删除", async () => {
    const wallet = newWallet();
    upsertPosition(CHAIN, wallet, TOKEN.toLowerCase(), "USDT", 18, 100n, 1000n);
    addUnresolved({
      chainId: CHAIN,
      txHash: "0x" + "44".repeat(32),
      walletAddress: wallet,
      tokenAddress: TOKEN.toLowerCase(),
      tokenSymbol: "USDT",
      tokenDecimals: 18,
      side: "sell",
      phase: "swap",
      accountingRole: "follower",
      plannedAmountWei: 40n,
      // 快照缺失
    });
    const tx = loadUnresolved()[0];
    const res = await reconcileTx(tx, providerWith({ status: 1 }), async () => 0n);
    const apply = applyReconciliation(tx, res);
    expect(apply.status).toBe("inconsistent");
    expect(getPosition(CHAIN, wallet, TOKEN.toLowerCase())?.amountWei).toBe(100n);
    // 未调用 removeUnresolved，记录仍在
    expect(loadUnresolved().length).toBe(1);
  });

  it("unresolved 删除持久化失败后再次对账，持仓结果保持不变", async () => {
    const storage = installStorage();
    const tx = makeTx({
      snapshotBefore: { amountWei: 0n, costBnbWei: 0n, tokenSymbol: "USDT", decimals: 18 },
      plannedAmountWei: 500n,
    });
    addUnresolved({
      chainId: tx.chainId,
      txHash: tx.txHash,
      walletAddress: tx.walletAddress,
      tokenAddress: tx.tokenAddress,
      tokenSymbol: tx.tokenSymbol,
      tokenDecimals: tx.tokenDecimals,
      side: tx.side,
      phase: tx.phase,
      accountingRole: "follower",
      plannedAmountWei: tx.plannedAmountWei,
      balanceBeforeWei: 0n,
      snapshotBefore: tx.snapshotBefore,
    });
    const stored = loadUnresolved()[0];
    const res = await reconcileTx(stored, providerWith({ status: 1 }), async () => 25n);
    expect(applyReconciliation(stored, res).status).toBe("applied");
    // 使删除持久化失败
    storage.throwOnSet = true;
    removeUnresolved(stored.id);
    // 再次对账（幂等），持仓不得重复增加
    expect(applyReconciliation(stored, res).status).toBe("applied");
    expect(getPosition(CHAIN, stored.walletAddress, TOKEN.toLowerCase())?.amountWei).toBe(25n);
  });

  it("provider 链与 unresolved.chainId 不一致时不查询余额、不修改持仓、不删除记录", async () => {
    let balanceQueried = false;
    const wallet = newWallet();
    upsertPosition(CHAIN, wallet, TOKEN.toLowerCase(), "USDT", 18, 100n, 1000n);
    const tx = makeTx({
      walletAddress: wallet,
      snapshotBefore: { amountWei: 100n, costBnbWei: 1000n, tokenSymbol: "USDT", decimals: 18 },
    });
    addUnresolved({
      chainId: tx.chainId,
      txHash: tx.txHash,
      walletAddress: tx.walletAddress,
      tokenAddress: tx.tokenAddress,
      tokenSymbol: tx.tokenSymbol,
      tokenDecimals: tx.tokenDecimals,
      side: tx.side,
      phase: tx.phase,
      accountingRole: "follower",
      plannedAmountWei: tx.plannedAmountWei,
      balanceBeforeWei: 0n,
      snapshotBefore: tx.snapshotBefore,
    });
    // 用链 1（不一致）的 provider
    const res = await reconcileTx(
      tx,
      providerWith({ status: 1 }, 1),
      async () => {
        balanceQueried = true;
        return 0n;
      }
    );
    expect(res.outcome).toBe("pending");
    expect(res.message).toMatch(/切换网络/);
    expect(balanceQueried).toBe(false);
    expect(applyReconciliation(tx, res).status).toBe("pending");
    expect(getPosition(CHAIN, wallet, TOKEN.toLowerCase())?.amountWei).toBe(100n);
    // 记录未被删除
    expect(loadUnresolved().length).toBe(1);
  });
});
