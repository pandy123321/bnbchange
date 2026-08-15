// 单 Leader 链上监听：区块轮询扫描 Leader 发往 PancakeSwap Router 的交易，
// 解码出买入/卖出信号，txHash 去重，回调上层执行跟单。
// 监听与执行解耦，监听本身只读链上数据，不广播任何交易。
//
// 资金安全约束（Fail Closed）：
// 1. 仅对 receipt.status === 1 的 Leader 交易生成信号（回滚交易绝不触发 Followers）。
// 2. lastBlock 仅在区块完整成功扫描后才推进（RPC 异常不丢块，链读取重试允许）。
// 3. 实际链 ID 与预期不一致时立即停止监听，不再产生信号。
// 4. 落后超过安全窗口时不静默跳块，立即停止并提示人工核对。

import { ethers } from "ethers";
import type { TradeSignal } from "../types";
import { PANCAKE_ROUTER_V2_ABI } from "./abi";

export interface TradeMonitorConfig {
  provider: ethers.Provider;
  leaderAddress: string;
  routerAddress: string;
  wbnbAddress: string;
  expectedChainId: number;
  pollIntervalMs?: number;
  onSignal: (signal: TradeSignal) => void;
  onError: (error: Error) => void;
  // Fail Closed 时通知上层（monitor 已自行停止），用于 UI 同步监听状态
  onStopped?: (reason: string) => void;
}

export interface TradeMonitor {
  stop: () => void;
  running: () => boolean;
}

// txHash 去重缓存上限；超出清空（极端情况下宁可丢历史去重也不无限增长）
const MAX_TX_CACHE = 10_000;
// 落后超过该块数时 Fail Closed，禁止静默跳块
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

  // Fail Closed：致命错误仅触发一次，停止轮询并通知上层
  function failClosed(reason: string): void {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    config.onStopped?.(reason);
    config.onError(new Error(reason));
  }

  // 校验实际链 ID；不一致 → Fail Closed。RPC 临时失败则抛出，交由上层保持游标。
  async function assertChain(): Promise<void> {
    const net = await config.provider.getNetwork();
    if (Number(net.chainId) !== config.expectedChainId) {
      failClosed(
        `监听 RPC 网络不一致（期望 ${config.expectedChainId}，实际 ${Number(
          net.chainId
        )}），已停止自动执行`
      );
    }
  }

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

      const signal = decode(tx);
      if (!signal) {
        // 非目标交易（非 Leader→Router Swap）：直接去重，避免反复 decode
        seenTx.add(tx.hash);
        if (seenTx.size > MAX_TX_CACHE) seenTx.clear();
        continue;
      }

      // 仅对确认成功的 Leader 交易生成信号。
      // receipt 读取失败会抛出 → tick catch 保持 lastBlock 不动，下一轮重扫本块；
      // 因此这里必须在 receipt 成功获取后才写入 seenTx，避免失败时永久跳过该 tx。
      const receipt = await config.provider.getTransactionReceipt(tx.hash);
      seenTx.add(tx.hash);
      if (seenTx.size > MAX_TX_CACHE) seenTx.clear();

      if (!receipt || receipt.status !== 1) {
        // 回滚（status=0）或已不可见（重组）：绝不触发 Followers，且已标记去重
        continue;
      }

      try {
        config.onSignal(signal);
      } catch {
        // 信号回调异常不影响监听循环继续
      }
    }
  }

  async function tick(): Promise<void> {
    if (stopped || scanning) return;
    scanning = true;
    try {
      await assertChain();
      if (stopped) return;

      const current = await config.provider.getBlockNumber();
      if (!initialized) {
        initialized = true;
        lastBlock = current;
        return;
      }
      if (current <= lastBlock) return;

      const start = lastBlock + 1;
      if (current - start > MAX_SCAN_BEHIND) {
        failClosed(
          `监听落后超过 ${MAX_SCAN_BEHIND} 个区块，已停止自动执行，请人工核对期间带单交易后重新启动`
        );
        return;
      }

      for (let b = start; b <= current; b++) {
        await scanBlock(b);
        // checkpoint 仅在完整成功扫描 Block b 后推进；
        // 若 b 失败，lastBlock 保持 b-1，下一轮从 b 重试（链读取重试，非资金交易重试）
        lastBlock = b;
      }
    } catch (e) {
      // RPC 临时错误：游标保持不变，下一轮从失败块重试，绝不前移导致永久丢块
      if (!stopped) {
        config.onError(e instanceof Error ? e : new Error(String(e)));
      }
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
