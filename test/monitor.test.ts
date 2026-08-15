import { describe, it, expect, vi, afterEach } from "vitest";
import { ethers } from "ethers";
import { startTradeMonitor, CONFIRMATION_DEPTH } from "../src/swap/monitor";
import { PANCAKE_ROUTER_V2_ABI } from "../src/swap/abi";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const TOKEN = "0x55d398326f99059fF775485246999027B3197955";
const LEADER = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

function buyTx(hash: string, value: bigint): ethers.TransactionResponse {
  const iface = new ethers.Interface(PANCAKE_ROUTER_V2_ABI);
  const data = iface.encodeFunctionData("swapExactETHForTokens", [
    0n,
    [WBNB, TOKEN],
    LEADER,
    Math.floor(Date.now() / 1000) + 600,
  ]);
  return {
    hash,
    from: LEADER,
    to: ROUTER,
    data,
    value,
  } as unknown as ethers.TransactionResponse;
}

function makeMonitor(
  blocks: Record<number, ethers.TransactionResponse[]>,
  receipts: Record<string, { status: number | null }>,
  currentRef: { value: number },
  depth = CONFIRMATION_DEPTH
) {
  const signals: string[] = [];
  const provider = {
    getNetwork: async () => ({ chainId: 56n }),
    getBlockNumber: async () => currentRef.value,
    getBlock: async (n: number) => ({ prefetchedTransactions: blocks[n] ?? [] }),
    getTransactionReceipt: async (hash: string) => receipts[hash] ?? null,
  };
  const monitor = startTradeMonitor({
    provider: provider as unknown as ethers.Provider,
    leaderAddress: LEADER,
    routerAddress: ROUTER,
    wbnbAddress: WBNB,
    expectedChainId: 56,
    pollIntervalMs: 100,
    confirmationDepth: depth,
    onSignal: (s) => signals.push(s.txHash),
    onError: () => {},
    onStopped: () => {},
  });
  return { monitor, signals };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("monitor 区块确认深度", () => {
  it("最新未达到确认深度的区块不触发信号", async () => {
    vi.useFakeTimers();
    const tx = buyTx("0xabc", 1000000000000000000n);
    const current = { value: 10 };
    const { monitor, signals } = makeMonitor(
      { 10: [tx] },
      { "0xabc": { status: 1 } },
      current,
      3
    );
    // 初始 tick：safeHead = 10 - 3 = 7，lastBlock = 7
    await vi.advanceTimersByTimeAsync(0);
    // current=11 → safeHead=8，仅扫描 block 8；block 10 尚未达到确认深度
    current.value = 11;
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    expect(signals).toEqual([]);
  });

  it("达到确认深度后只触发一次", async () => {
    vi.useFakeTimers();
    const tx = buyTx("0xabc", 1000000000000000000n);
    const current = { value: 10 };
    const { monitor, signals } = makeMonitor(
      { 8: [tx] },
      { "0xabc": { status: 1 } },
      current,
      3
    );
    await vi.advanceTimersByTimeAsync(0); // lastBlock = 7
    current.value = 11; // safeHead = 8
    await vi.advanceTimersByTimeAsync(100); // 扫描 block 8 → 触发
    current.value = 12; // safeHead = 9，block 8 已去重
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    expect(signals).toEqual(["0xabc"]);
  });

  it("同一 Leader txHash 在重扫时只触发一次", async () => {
    vi.useFakeTimers();
    const txA = buyTx("0xaaa", 1000000000000000000n);
    const txB = buyTx("0xbbb", 2000000000000000000n);
    const current = { value: 10 };
    const receipts: Record<string, { status: number | null } | null> = {
      "0xaaa": { status: 1 },
      "0xbbb": null, // 首次扫描 receipt 不可用 → 抛错，游标不前移
    };
    const { monitor, signals } = makeMonitor(
      { 8: [txA, txB] },
      receipts,
      current,
      3
    );
    await vi.advanceTimersByTimeAsync(0); // lastBlock = 7
    current.value = 11; // safeHead = 8，扫描 block 8：txA 触发，txB receipt 不可用
    await vi.advanceTimersByTimeAsync(100);
    expect(signals).toEqual(["0xaaa"]);

    receipts["0xbbb"] = { status: 1 };
    current.value = 12; // safeHead = 9，lastBlock 仍为 7，重扫 block 8
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    // txA 已去重，仅 txB 新触发
    expect(signals).toEqual(["0xaaa", "0xbbb"]);
  });

  it("回滚的 Leader 交易不触发", async () => {
    vi.useFakeTimers();
    const tx = buyTx("0xabc", 1000000000000000000n);
    const current = { value: 10 };
    const { monitor, signals } = makeMonitor(
      { 8: [tx] },
      { "0xabc": { status: 0 } },
      current,
      3
    );
    await vi.advanceTimersByTimeAsync(0);
    current.value = 11;
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    expect(signals).toEqual([]);
  });
});
