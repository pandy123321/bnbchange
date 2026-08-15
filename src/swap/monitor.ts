// 单 Leader 链上监听：区块轮询扫描 Leader 发往 PancakeSwap Router 的交易，
// 解码出买入/卖出信号，txHash 去重，回调上层执行跟单。
// 监听与执行解耦，监听本身只读链上数据，不广播任何交易。
//
// 资金安全约束（Fail Closed）：
// 1. 仅对 receipt.status === 1 的 Leader 交易生成信号（回滚交易绝不触发 Followers）。
// 2. receipt 暂不可用（null）视为 unresolved：不写去重、不 checkpoint，抛错重试。
// 3. lastBlock 仅在区块完整成功扫描后才推进（RPC 异常不丢块，链读取重试允许）。
// 4. 实际链 ID 与预期不一致时立即停止监听；RPC 连续失败达阈值时停止监听。
// 5. 落后超过安全窗口时不静默跳块，立即停止并提示人工核对。
//
// 注意：这里的 seenTx 去重是性能优化层，不是 exactly-once 的最终防线；
// 执行层（CopyTrade）持有全生命周期 txHash 去重作为最后资金防线。

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
  confirmationDepth?: number;
  onSignal: (signal: TradeSignal) => void;
  onError: (error: Error) => void;
  // Fail Closed 时通知上层（monitor 已自行停止），用于 UI 同步监听状态
  onStopped?: (reason: string) => void;
}

export interface TradeMonitor {
  stop: () => void;
  running: () => boolean;
}

// txHash 去重缓存上限（FIFO 淘汰最旧项，绝不整表 clear，避免 Block 重扫时重复触发）
const MAX_TX_CACHE = 10_000;
// 落后超过该块数时 Fail Closed，禁止静默跳块
const MAX_SCAN_BEHIND = 20;
// RPC 连续失败达该次数时 Fail Closed（短暂抖动可容忍，持续不可靠则停止自动执行）
const MAX_CONSECUTIVE_FAILURES = 3;
// 区块确认深度：仅扫描不高于 safeHead = current - CONFIRMATION_DEPTH 的区块，
// 抵御短链重组导致已触发信号被回滚。集中定义，供测试覆盖。
export const CONFIRMATION_DEPTH = 3;

export function startTradeMonitor(config: TradeMonitorConfig): TradeMonitor {
  const iface = new ethers.Interface(PANCAKE_ROUTER_V2_ABI);
  const confirmationDepth = config.confirmationDepth ?? CONFIRMATION_DEPTH;
  // 只缓存 Leader→Router 候选交易的 hash，FIFO 淘汰；避免缓存所有普通区块交易
  const seenTx = new Map<string, true>();
  const leader = config.leaderAddress.toLowerCase();
  const router = config.routerAddress.toLowerCase();
  const wbnb = config.wbnbAddress.toLowerCase();
  const pollMs = config.pollIntervalMs ?? 4000;

  let stopped = false;
  let scanning = false;
  let initialized = false;
  let lastBlock = 0;
  let consecutiveFailures = 0;
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

  // FIFO 淘汰最旧项，绝不整表 clear
  function rememberSeen(hash: string): void {
    seenTx.set(hash, true);
    while (seenTx.size > MAX_TX_CACHE) {
      const oldest = seenTx.keys().next().value;
      if (oldest === undefined) break;
      seenTx.delete(oldest);
    }
  }

  // 校验实际链 ID；不一致 → Fail Closed。RPC 临时失败则抛出，交由上层计数。
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
    if (!block || stopped) return;

    for (const tx of block.prefetchedTransactions ?? []) {
      if (stopped) return;
      if (seenTx.has(tx.hash)) continue;

      const signal = decode(tx);
      if (!signal) continue; // 非 Leader→Router 交易：不缓存，直接跳过

      // 仅对确认成功的 Leader 交易生成信号。
      const receipt = await config.provider.getTransactionReceipt(tx.hash);
      // Stop 后晚到的 receipt 不得继续处理，更不得 emit 资金 Signal
      if (stopped) return;

      if (!receipt) {
        // unresolved：不写 seenTx，不 checkpoint，抛错让本 Block 下一轮重试
        throw new Error(
          `Leader 交易 receipt 暂不可用（${tx.hash.slice(0, 10)}…），下一轮重试`
        );
      }

      rememberSeen(tx.hash);

      if (receipt.status !== 1) {
        // confirmed revert：永久忽略，绝不触发 Followers
        continue;
      }

      // onSignal 前最后一道防线：Stop 返回后绝不再产生新 Signal callback
      if (stopped) return;
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
      // 安全高度：仅扫描已达到确认深度的区块，抵御短链重组
      const safeHead = Math.max(0, current - confirmationDepth);
      if (!initialized) {
        initialized = true;
        lastBlock = safeHead;
        consecutiveFailures = 0;
        return;
      }
      if (safeHead <= lastBlock) {
        consecutiveFailures = 0;
        return;
      }

      const start = lastBlock + 1;
      if (safeHead - start > MAX_SCAN_BEHIND) {
        failClosed(
          `监听落后超过 ${MAX_SCAN_BEHIND} 个区块，已停止自动执行，请人工核对期间带单交易后重新启动`
        );
        return;
      }

      for (let b = start; b <= safeHead; b++) {
        if (stopped) break;
        await scanBlock(b);
        // checkpoint 仅在完整成功扫描 Block b 后推进；
        // 若 b 失败，lastBlock 保持 b-1，下一轮从 b 重试（链读取重试，非资金交易重试）
        lastBlock = b;
      }
      consecutiveFailures = 0;
    } catch (e) {
      // RPC 临时错误：游标保持不变，下一轮从失败块重试，绝不前移导致永久丢块。
      // 连续失败达阈值 → Fail Closed（监控链路已不可靠，停止自动资金执行）。
      if (!stopped) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          failClosed(
            `监听 RPC 连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，已停止自动执行，请检查网络后重新启动`
          );
        } else {
          config.onError(e instanceof Error ? e : new Error(String(e)));
        }
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
