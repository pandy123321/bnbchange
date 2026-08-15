// 单 Leader 链上监听：区块轮询扫描 Leader 发往 PancakeSwap Router 的交易，
// 解码出买入/卖出信号，txHash 去重，回调上层执行跟单。
// 监听与执行解耦，监听本身只读链上数据，不广播任何交易。

import { ethers } from "ethers";
import type { TradeSignal } from "../types";
import { PANCAKE_ROUTER_V2_ABI } from "./abi";

export interface TradeMonitorConfig {
  provider: ethers.Provider;
  leaderAddress: string;
  routerAddress: string;
  wbnbAddress: string;
  pollIntervalMs?: number;
  onSignal: (signal: TradeSignal) => void;
  onError: (error: Error) => void;
}

export interface TradeMonitor {
  stop: () => void;
  running: () => boolean;
}

// txHash 去重缓存上限；超出清空（极端情况下宁可丢历史去重也不无限增长）
const MAX_TX_CACHE = 10_000;
// 落后超过该块数时直接跳到最新块，避免追块风暴
const MAX_SCAN_BEHIND = 20;

export function startTradeMonitor(config: TradeMonitorConfig): TradeMonitor {
  const iface = new ethers.Interface(PANCAKE_ROUTER_V2_ABI);
  const seenTx = new Set<string>();
  const leader = config.leaderAddress.toLowerCase();
  const router = config.routerAddress.toLowerCase();
  const wbnb = config.wbnbAddress.toLowerCase();
  const pollMs = config.pollIntervalMs ?? 4000;

  let stopped = false;
  let scanning = false;
  let initialized = false;
  let lastBlock = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  // 只解码 Leader 发起到 Router 的 Swap；方向按 path 判定：
  // path[0] == WBNB → 买入（原生币换币）；path[末尾] == WBNB → 卖出（币换原生币）
  function decode(tx: ethers.TransactionResponse): TradeSignal | null {
    if (tx.from?.toLowerCase() !== leader) return null;
    if (tx.to?.toLowerCase() !== router) return null;
    if (!tx.data || tx.data === "0x") return null;

    let parsed: ethers.TransactionDescription | null = null;
    try {
      parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
    } catch {
      return null;
    }
    if (!parsed) return null;

    const name = parsed.name;
    const args = parsed.args;

    if (name.startsWith("swapExactETHForTokens")) {
      const path = args.path as string[];
      if (!Array.isArray(path) || path.length < 2) return null;
      if (path[0].toLowerCase() !== wbnb) return null;
      const amountInWei = BigInt(tx.value);
      if (amountInWei <= 0n) return null;
      return {
        leaderAddress: tx.from!,
        txHash: tx.hash,
        direction: "buy",
        tokenAddress: path[path.length - 1],
        amountInWei,
        blockNumber: tx.blockNumber ?? 0,
      };
    }

    if (name.startsWith("swapExactTokensForETH")) {
      const path = args.path as string[];
      if (!Array.isArray(path) || path.length < 2) return null;
      if (path[path.length - 1].toLowerCase() !== wbnb) return null;
      const amountInWei = BigInt(args.amountIn as bigint);
      if (amountInWei <= 0n) return null;
      return {
        leaderAddress: tx.from!,
        txHash: tx.hash,
        direction: "sell",
        tokenAddress: path[0],
        amountInWei,
        blockNumber: tx.blockNumber ?? 0,
      };
    }

    return null;
  }

  async function scanBlock(blockNumber: number): Promise<void> {
    const block = await config.provider.getBlock(blockNumber, true);
    if (!block) return;

    for (const tx of block.prefetchedTransactions ?? []) {
      if (seenTx.has(tx.hash)) continue;
      seenTx.add(tx.hash);
      if (seenTx.size > MAX_TX_CACHE) seenTx.clear();

      const signal = decode(tx);
      if (signal) {
        try {
          config.onSignal(signal);
        } catch {
          // 信号回调异常不影响监听循环继续
        }
      }
    }
  }

  async function tick(): Promise<void> {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const current = await config.provider.getBlockNumber();
      if (!initialized) {
        initialized = true;
        lastBlock = current;
        return;
      }
      if (current <= lastBlock) return;

      let start = lastBlock + 1;
      if (current - start > MAX_SCAN_BEHIND) {
        start = current; // 追块过深直接跳到最新块
      }
      lastBlock = current;

      for (let b = start; b <= current; b++) {
        await scanBlock(b);
      }
    } catch (e) {
      config.onError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      scanning = false;
    }
  }

  timer = setInterval(tick, pollMs);
  // 启动即触发一次，立即记录当前块号，避免首个轮询周期盲区
  tick();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    running() {
      return !stopped;
    },
  };
}
