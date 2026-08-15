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
  receipts: Record<string, { status: number | null } | null>,
  currentRef: { value: number },
  depth = CONFIRMATION_DEPTH
) {
  const signals: string[] = [];
  const errors: string[] = [];
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
    onError: (e) => errors.push(e.message),
    onStopped: () => {},
  });
  return { monitor, signals, errors };
}

afterEach(() => {
  vi.useRealTimers();
});

// 说明：观察边界 = 启动时的 current block。startup=10 时，第一个会被扫描的区块是 11
// （且需等 current >= 14 才达到确认深度 3）。启动前（<=10）的区块永远不扫。
describe("monitor 只处理启动之后产生的交易（P0）", () => {
  it("启动前区块中的交易即使达到确认深度也永远不触发", async () => {
    vi.useFakeTimers();
    const tx = buyTx("0xold", 1000000000000000000n);
    const current = { value: 10 };
    // tx 位于启动前的 block 8
    const { monitor, signals } = makeMonitor(
      { 8: [tx] },
      { "0xold": { status: 1 } },
      current,
      3
    );
    await vi.advanceTimersByTimeAsync(0); // 启动：观察边界 lastBlock = 10
    current.value = 14; // safeHead = 11，只扫 11；block 8 不扫
    await vi.advanceTimersByTimeAsync(100);
    current.value = 20;
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    expect(signals).toEqual([]);
  });

  it("启动后第一个新区块交易，在确认深度不足时不触发", async () => {
    vi.useFakeTimers();
    const tx = buyTx("0xnew", 1000000000000000000n);
    const current = { value: 10 };
    const { monitor, signals } = makeMonitor(
      { 11: [tx] },
      { "0xnew": { status: 1 } },
      current,
      3
    );
    await vi.advanceTimersByTimeAsync(0); // lastBlock = 10
    current.value = 13; // safeHead = 10，11 尚未达到确认深度
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    expect(signals).toEqual([]);
  });

  it("达到确认深度后只触发一次", async () => {
    vi.useFakeTimers();
    const tx = buyTx("0xnew", 1000000000000000000n);
    const current = { value: 10 };
    const { monitor, signals } = makeMonitor(
      { 11: [tx] },
      { "0xnew": { status: 1 } },
      current,
      3
    );
    await vi.advanceTimersByTimeAsync(0); // lastBlock = 10
    current.value = 14; // safeHead = 11，扫描 block 11 → 触发
    await vi.advanceTimersByTimeAsync(100);
    current.value = 15; // safeHead = 12，block 11 已去重
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    expect(signals).toEqual(["0xnew"]);
  });

  it("receipt 暂时不可用后重扫，已处理交易不重复触发", async () => {
    vi.useFakeTimers();
    const txA = buyTx("0xaaa", 1000000000000000000n);
    const txB = buyTx("0xbbb", 2000000000000000000n);
    const current = { value: 10 };
    const receipts: Record<string, { status: number | null } | null> = {
      "0xaaa": { status: 1 },
      "0xbbb": null, // 首次扫描 receipt 不可用 → 抛错，游标不前移
    };
    const { monitor, signals } = makeMonitor({ 11: [txA, txB] }, receipts, current, 3);
    await vi.advanceTimersByTimeAsync(0); // lastBlock = 10
    current.value = 14; // 扫描 block 11：txA 触发，txB receipt 不可用
    await vi.advanceTimersByTimeAsync(100);
    expect(signals).toEqual(["0xaaa"]);

    receipts["0xbbb"] = { status: 1 };
    current.value = 15; // safeHead = 12，lastBlock 仍为 10，重扫 block 11
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    // txA 已去重，仅 txB 新触发，各一次
    expect(signals).toEqual(["0xaaa", "0xbbb"]);
  });

  it("回滚的 Leader 交易不触发 Followers", async () => {
    vi.useFakeTimers();
    const tx = buyTx("0xrev", 1000000000000000000n);
    const current = { value: 10 };
    const { monitor, signals } = makeMonitor(
      { 11: [tx] },
      { "0xrev": { status: 0 } },
      current,
      3
    );
    await vi.advanceTimersByTimeAsync(0); // lastBlock = 10
    current.value = 14;
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    expect(signals).toEqual([]);
  });
});
