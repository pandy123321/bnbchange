import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import type { NetworkConfig } from "../config/networks";
import type {
  CopyTradeResult,
  FollowerConfig,
  SignerWallet,
  SimpleTxStatus,
  TradeSignal,
} from "../types";
import { createWallet, getWalletBalance } from "../wallet/wallet";
import { connectMetaMask, onMetaMaskChange } from "../wallet/metamask";
import {
  estimateBuyGasCost,
  getTokenMetadata,
  sellToken,
  type TokenMetadata,
} from "./pancake";
import {
  runCopyTrade,
  runFollowersBuy,
  sellFollowersForToken,
  type CopyTradeWallet,
} from "./copyTradeEngine";
import { startTradeMonitor, type TradeMonitor } from "./monitor";
import { PANCAKE_ROUTER_V2_ABI } from "./abi";
import {
  getPosition,
  listPositions,
  reducePosition,
  upsertPosition,
  type Position,
} from "./position";
import { exportCopyTradeCsv } from "../utils/csv";
import { txExplorerUrl } from "../utils/explorer";
import { safeErrorMessage } from "../utils/error";

// 单个 Follower 在自动跟单中的执行结果，用于 Signal Log 展示 unknown txHash 供人工核查
interface SignalFollowerResult {
  name: string;
  address: string;
  status: SimpleTxStatus;
  txHash?: string;
  error?: string;
}

interface SignalLogEntry {
  txHash: string;
  direction: "buy" | "sell";
  tokenSymbol: string;
  amountText: string;
  status: "detected" | "following" | "done" | "attention" | "error";
  summary: string;
  followers?: SignalFollowerResult[];
}

function SignalStatusBadge({ status }: { status: SignalLogEntry["status"] }) {
  const map = {
    detected: ["bg-blue-500/15 text-blue-300", "已检测"],
    following: ["bg-yellow-500/15 text-yellow-300", "跟单中"],
    done: ["bg-green-500/15 text-green-300", "完成"],
    attention: ["bg-orange-500/15 text-orange-300", "待确认"],
    error: ["bg-red-500/15 text-red-300", "失败"],
  } as const;
  const [cls, label] = map[status];
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: CopyTradeResult["status"] }) {
  const map = {
    processing: ["bg-yellow-500/15 text-yellow-300", "处理中"],
    success: ["bg-green-500/15 text-green-300", "成功"],
    failed: ["bg-red-500/15 text-red-300", "失败"],
    unknown: ["bg-orange-500/15 text-orange-300", "已广播待确认"],
    skipped: ["bg-gray-500/15 text-gray-400", "未执行"],
  } as const;
  const [cls, label] = map[status];
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

function slippagePercentToBps(text: string): bigint {
  const pct = Number(text);
  if (!Number.isFinite(pct) || pct < 0.1 || pct > 50) {
    throw new Error("滑点必须在 0.1% ~ 50% 之间");
  }
  return BigInt(Math.round(pct * 100));
}

async function buildFollowers(
  keysText: string,
  defaultAmountText: string,
  provider: ethers.Provider
): Promise<FollowerConfig[]> {
  const lines = keysText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("请至少导入一个跟单钱包私钥");
  }

  const defaultWei = ethers.parseEther(defaultAmountText || "0");

  const followers: FollowerConfig[] = [];
  for (let i = 0; i < lines.length; i++) {
    const w = createWallet(lines[i], provider);
    const balanceWei = await getWalletBalance(w.address, provider);
    followers.push({
      id: `follower-${i}`,
      name: `跟单 ${i + 1}`,
      address: w.address,
      privateKey: lines[i],
      balanceWei,
      buyAmountText: defaultAmountText,
      buyAmountWei: defaultWei,
    });
  }

  return followers;
}

// 自动跟单信号 FIFO 队列安全上限；超过则 Fail Closed（停止监听 + 人工处理）
const MAX_SIGNAL_QUEUE = 50;

export function CopyTrade({
  network,
  provider,
  rpcReady,
  onExecutingChange,
}: {
  network: NetworkConfig;
  provider: ethers.Provider;
  rpcReady: boolean;
  onExecutingChange: (executing: boolean) => void;
}) {
  const [leaderMode, setLeaderMode] = useState<"privateKey" | "metamask">(
    "privateKey"
  );
  const [leaderPrivateKey, setLeaderPrivateKey] = useState("");
  const [leaderWallet, setLeaderWallet] = useState<SignerWallet | null>(null);
  const [leaderBalanceWei, setLeaderBalanceWei] = useState<bigint | null>(null);
  const [leaderAmountText, setLeaderAmountText] = useState("");

  const [followersText, setFollowersText] = useState("");
  const [defaultAmountText, setDefaultAmountText] = useState("");
  const [followers, setFollowers] = useState<FollowerConfig[]>([]);

  const [tokenAddress, setTokenAddress] = useState("");
  const [tokenMeta, setTokenMeta] = useState<TokenMetadata | null>(null);
  const [slippageText, setSlippageText] = useState("5");
  const [supportFeeOnTransfer, setSupportFeeOnTransfer] = useState(false);

  const [results, setResults] = useState<CopyTradeResult[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [sellPct, setSellPct] = useState<Record<string, string>>({});
  const [isExecuting, setIsExecuting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const executionRef = useRef(false);
  const metaSubRef = useRef<(() => void) | null>(null);

  // 自动监听状态
  const [monitoring, setMonitoring] = useState(false);
  const [signalLog, setSignalLog] = useState<SignalLogEntry[]>([]);
  const monitorRef = useRef<TradeMonitor | null>(null);
  // 单线程 FIFO 信号队列：busy → enqueue，不并发、不丢信号；
  // 资金操作统一经过 executionRef / isExecuting / onExecutingChange 全局锁
  const queueRef = useRef<TradeSignal[]>([]);
  const queueProcessingRef = useRef(false);
  const queueLimitReachedRef = useRef(false);
  // latest-value refs：监听回调跨异步读取时始终拿到最新配置，避免闭包陈旧
  const followersRef = useRef(followers);
  followersRef.current = followers;
  const slippageRef = useRef(slippageText);
  slippageRef.current = slippageText;
  const supportFotRef = useRef(supportFeeOnTransfer);
  supportFotRef.current = supportFeeOnTransfer;

  useEffect(() => {
    return () => {
      metaSubRef.current?.();
      // 组件卸载（含网络切换导致的 remount）时停止监听
      monitorRef.current?.stop();
      monitorRef.current = null;
      queueRef.current = [];
      queueProcessingRef.current = false;
    };
  }, []);

  // 网络切换时重新加载当前 Chain 的持仓，避免展示上一条链的仓位
  useEffect(() => {
    setPositions(listPositions(network.chainId));
  }, [network.chainId]);

  function handleLeaderPrivateKeyChange(value: string) {
    setLeaderPrivateKey(value);
    // 源输入变化 → 旧 leader wallet / 余额立即失效
    setLeaderWallet(null);
    setLeaderBalanceWei(null);
  }

  function switchLeaderMode(mode: "privateKey" | "metamask") {
    if (isExecuting) return;
    setLeaderMode(mode);
    // 模式切换 → 旧 leader wallet / 余额立即失效
    setLeaderWallet(null);
    setLeaderBalanceWei(null);
    metaSubRef.current?.();
    metaSubRef.current = null;
    setError("");
  }

  async function connectMeta() {
    setError("");
    setLeaderWallet(null);
    setLeaderBalanceWei(null);
    try {
      const session = await connectMetaMask(network);
      setLeaderWallet(session.signer);
      setLeaderBalanceWei(await getWalletBalance(session.address, provider));
      metaSubRef.current?.();
      metaSubRef.current = onMetaMaskChange(() => {
        setLeaderWallet(null);
        setLeaderBalanceWei(null);
      });
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  function disconnectMeta() {
    metaSubRef.current?.();
    metaSubRef.current = null;
    setLeaderWallet(null);
    setLeaderBalanceWei(null);
  }

  function handleFollowersTextChange(value: string) {
    setFollowersText(value);
    // 源输入变化 → 旧 followers 立即失效
    setFollowers([]);
  }

  function handleTokenAddressChange(value: string) {
    setTokenAddress(value);
    // 源输入变化 → 旧 token metadata 立即失效
    setTokenMeta(null);
  }

  function handleDefaultAmountChange(value: string) {
    setDefaultAmountText(value);
    // Default Buy 变化 → 旧 followers（已写入旧金额）立即失效，要求重新 Parse
    setFollowers([]);
  }

  async function loadLeader() {
    setError("");
    setLeaderWallet(null);
    setLeaderBalanceWei(null);

    try {
      const w = createWallet(leaderPrivateKey, provider);
      setLeaderWallet(w);
      const bal = await getWalletBalance(w.address, provider);
      setLeaderBalanceWei(bal);
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  async function parseFollowers() {
    setError("");
    setMessage("");
    setFollowers([]);

    try {
      const list = await buildFollowers(
        followersText,
        defaultAmountText,
        provider
      );
      setFollowers(list);
      setMessage(`已导入 ${list.length} 个跟单钱包`);
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  async function loadToken() {
    setError("");
    setTokenMeta(null);

    try {
      const meta = await getTokenMetadata(tokenAddress, provider);
      setTokenMeta(meta);
      setMessage(`代币: ${meta.symbol} (${meta.name})`);
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  function updateFollowerAmount(id: string, text: string) {
    setFollowers((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        try {
          return { ...f, buyAmountText: text, buyAmountWei: ethers.parseEther(text || "0") };
        } catch {
          return { ...f, buyAmountText: text, buyAmountWei: 0n };
        }
      })
    );
  }

  async function precheck(): Promise<{ ok: boolean; messages: string[] }> {
    const messages: string[] = [];
    const problems: string[] = [];

    if (!rpcReady) {
      problems.push("RPC 网络未就绪，禁止发起交易");
    }

    let leaderWei = 0n;
    try {
      if (!leaderWallet) throw new Error("请先连接带单钱包（输入私钥或连接小狐狸）");
      if (leaderAmountText.trim() === "") throw new Error("请填写带单买入金额");
      leaderWei = ethers.parseEther(leaderAmountText);
      if (leaderWei <= 0n) throw new Error("带单买入金额必须大于 0");
      messages.push(`带单买入 ${leaderAmountText} ${network.nativeSymbol}`);
    } catch (e) {
      problems.push(safeErrorMessage(e));
    }

    if (followers.length === 0) {
      problems.push("请先解析跟单钱包");
    } else {
      for (const f of followers) {
        if (f.buyAmountWei <= 0n) {
          problems.push(`${f.name} 买入金额必须大于 0`);
        }
      }
      messages.push(`${followers.length} 个跟单钱包`);
    }

    let tokenOk = false;
    try {
      if (!tokenMeta) throw new Error("请先读取代币信息");
      messages.push(`代币 ${tokenMeta.symbol}`);
      tokenOk = true;
    } catch (e) {
      problems.push(safeErrorMessage(e));
    }

    let slippageBps: bigint;
    try {
      slippageBps = slippagePercentToBps(slippageText);
      messages.push(`滑点 ${slippageText}%`);
    } catch (e) {
      problems.push(safeErrorMessage(e));
      slippageBps = 0n;
    }

    // Leader Gas 预检（Fail Closed）+ 余额刷新
    let leaderGasCost = 0n;
    if (rpcReady && leaderWallet && leaderWei > 0n && tokenOk && slippageBps > 0n) {
      try {
        leaderGasCost = await estimateBuyGasCost(
          leaderWallet,
          network,
          tokenMeta!.address,
          leaderWei,
          supportFeeOnTransfer
        );
      } catch {
        problems.push("无法估算带单交易 Gas（报价/流动性异常），已阻止执行");
        leaderGasCost = 0n;
      }
    }

    // Leader 余额 + Gas
    if (leaderWallet && leaderWei > 0n) {
      try {
        const bal = await getWalletBalance(leaderWallet.address, provider);
        if (bal < leaderWei + leaderGasCost) {
          problems.push(
            `带单钱包余额不足（需 ${ethers.formatEther(leaderWei + leaderGasCost)} ${network.nativeSymbol}，当前 ${ethers.formatEther(bal)} ${network.nativeSymbol}）`
          );
        } else {
          messages.push(`带单钱包余额充足`);
        }
      } catch (e) {
        problems.push(`带单钱包余额检查失败：${safeErrorMessage(e)}`);
      }
    }

    // 每个 Follower 独立 Gas 估算 + 余额检查
    if (followers.length > 0 && tokenOk && slippageBps > 0n) {
      for (const f of followers) {
        if (f.buyAmountWei <= 0n) continue;
        try {
          const fw = createWallet(f.privateKey, provider);
          const followerGasCost = await estimateBuyGasCost(
            fw,
            network,
            tokenMeta!.address,
            f.buyAmountWei,
            supportFeeOnTransfer
          );
          const bal = await getWalletBalance(f.address, provider);
          if (bal < f.buyAmountWei + followerGasCost) {
            problems.push(
              `${f.name} ${network.nativeSymbol} 余额不足（需 ${ethers.formatEther(f.buyAmountWei + followerGasCost)}，当前 ${ethers.formatEther(bal)}）`
            );
          }
        } catch (e) {
          problems.push(`${f.name} Gas 预检失败：${safeErrorMessage(e)}`);
        }
      }
    }

    if (problems.length > 0) {
      return { ok: false, messages: [...messages, ...problems] };
    }
    return { ok: true, messages };
  }

  async function validate() {
    setError("");
    setMessage("");
    const check = await precheck();
    if (check.ok) {
      setMessage("预检通过：" + check.messages.join("，"));
    } else {
      setError(check.messages.join("；"));
    }
  }

  async function start() {
    if (executionRef.current) return;
    executionRef.current = true;
    setIsExecuting(true);
    onExecutingChange(true);

    try {
      setError("");
      setMessage("");
      const check = await precheck();
      if (!check.ok) {
        setError(check.messages.join("；"));
        return;
      }

      const slippageBps = slippagePercentToBps(slippageText);
      const leaderWei = ethers.parseEther(leaderAmountText);

      const leader: CopyTradeWallet = {
        role: "leader",
        name: "带单",
        wallet: leaderWallet!,
        amountWei: leaderWei,
        amountText: leaderAmountText,
      };

      const followerWallets: CopyTradeWallet[] = followers.map((f) => ({
        role: "follower",
        name: f.name,
        wallet: createWallet(f.privateKey, provider),
        amountWei: f.buyAmountWei,
        amountText: f.buyAmountText,
      }));

      const initial: CopyTradeResult[] = [
        { role: "leader", name: "带单", address: leaderWallet!.address, buyAmount: leaderAmountText, status: "processing" },
        ...followerWallets.map((f) => ({
          role: "follower" as const,
          name: f.name,
          address: f.wallet.address,
          buyAmount: f.amountText,
          status: "processing" as const,
        })),
      ];
      setResults(initial);

      const finalResults = await runCopyTrade(
        {
          tokenAddress: tokenMeta!.address,
          slippageBps,
          network,
          supportFeeOnTransfer,
          leader,
          followers: followerWallets,
        },
        (index, result) => {
          setResults((prev) => {
            const next = [...prev];
            next[index] = result;
            return next;
          });
        }
      );

      // 买入成功后记录跟单持仓（仅 Follower，Leader 持仓由带单方自行管理）
      for (const r of finalResults) {
        if (r.role !== "follower" || r.status !== "success") continue;
        const received = r.receivedAmountWei ?? 0n;
        if (received <= 0n) {
          // 到账量异常，不创建正常持仓（由结果表展示 accountingWarning）
          continue;
        }
        const fw = followerWallets.find(
          (f) => f.wallet.address.toLowerCase() === r.address.toLowerCase()
        );
        upsertPosition(
          network.chainId,
          r.address,
          tokenMeta!.address,
          tokenMeta!.symbol,
          tokenMeta!.decimals,
          received,
          fw?.amountWei ?? 0n,
          r.txHash
        );
      }
      setPositions(listPositions(network.chainId));
    } catch (e) {
      setError(safeErrorMessage(e));
    } finally {
      executionRef.current = false;
      setIsExecuting(false);
      onExecutingChange(false);
    }
  }

  function posKey(p: Position): string {
    return `${p.chainId}:${p.follower.toLowerCase()}:${p.tokenAddress.toLowerCase()}`;
  }

  async function sellPosition(pos: Position, percentText: string) {
    if (executionRef.current) return;

    // 跨链 Fail Closed：持仓链与当前网络不一致时禁止任何广播
    if (pos.chainId !== network.chainId) {
      setError("该持仓不属于当前网络，已阻止卖出");
      setPositions(listPositions(network.chainId));
      return;
    }

    const follower = followers.find(
      (f) => f.address.toLowerCase() === pos.follower.toLowerCase()
    );
    if (!follower) {
      setError("未找到该持仓对应的跟单钱包私钥，请先重新解析跟单钱包");
      return;
    }

    const pct = Number(percentText);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      setError("卖出比例必须在 0 ~ 100 之间");
      return;
    }

    const sellWei = (pos.amountWei * BigInt(Math.round(pct * 100))) / 10_000n;
    if (sellWei <= 0n) {
      setError("卖出数量为 0，请调整卖出比例");
      return;
    }

    // 无持仓 / 超卖拦截
    const current = getPosition(network.chainId, pos.follower, pos.tokenAddress);
    if (!current || current.amountWei < sellWei) {
      setError("持仓不足，已取消卖出");
      setPositions(listPositions(network.chainId));
      return;
    }

    executionRef.current = true;
    setIsExecuting(true);
    onExecutingChange(true);
    setError("");
    setMessage("");

    try {
      const slippageBps = slippagePercentToBps(slippageText);
      const wallet = createWallet(follower.privateKey, provider);
      const res = await sellToken({
        wallet,
        tokenAddress: pos.tokenAddress,
        amountInWei: sellWei,
        slippageBps,
        network,
        supportFeeOnTransfer,
      });

      if (res.status === "success") {
        reducePosition(network.chainId, pos.follower, pos.tokenAddress, sellWei);
        setPositions(listPositions(network.chainId));
        setMessage(
          `已卖出 ${pos.tokenSymbol}${res.swapHash ? " · " + res.swapHash.slice(0, 10) + "..." : ""}`
        );
      } else if (res.status === "unknown") {
        // 已广播但未确认：保留 txHash，不扣减持仓，提醒人工核对，避免重复卖出
        const hash = res.swapHash ?? res.approvalHash ?? "";
        const phase = res.phase === "approval" ? "授权" : "卖出";
        setError(
          `${phase}已广播但状态未确认（${hash}），请先通过链上检查结果，勿重复操作`
        );
      } else {
        setError(res.error ?? "卖出失败");
      }
    } catch (e) {
      setError(safeErrorMessage(e));
    } finally {
      executionRef.current = false;
      setIsExecuting(false);
      onExecutingChange(false);
    }
  }

  function upsertSignalLog(entry: SignalLogEntry) {
    setSignalLog((prev) => {
      const idx = prev.findIndex((e) => e.txHash === entry.txHash);
      if (idx === -1) {
        return [entry, ...prev].slice(0, 50);
      }
      const next = [...prev];
      next[idx] = entry;
      return next;
    });
  }

  function handleSignal(signal: TradeSignal) {
    upsertSignalLog({
      txHash: signal.txHash,
      direction: signal.direction,
      tokenSymbol: "",
      amountText: "",
      status: "detected",
      summary: "已入队，等待执行",
    });

    // 同 txHash 只入队一次（monitor 已去重，此处兜底）
    if (queueRef.current.some((s) => s.txHash === signal.txHash)) return;

    if (queueRef.current.length >= MAX_SIGNAL_QUEUE) {
      // Fail Closed：队列溢出 → 停止监听，明确要求人工处理，不静默丢信号
      if (!queueLimitReachedRef.current) {
        queueLimitReachedRef.current = true;
        stopMonitor();
        upsertSignalLog({
          txHash: signal.txHash,
          direction: signal.direction,
          tokenSymbol: "",
          amountText: "",
          status: "error",
          summary: `信号队列已满（${MAX_SIGNAL_QUEUE}），已停止监听，请人工核对积压信号后重新启动`,
        });
      }
      return;
    }

    queueRef.current.push(signal);
    void drainQueue();
  }

  // 单线程 FIFO 队列消费：严格顺序处理，不并发、不丢信号；
  // 每个信号执行期间占用统一资金锁，Manual 与 Auto 互斥。
  async function drainQueue() {
    if (queueProcessingRef.current) return;
    queueProcessingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        // Manual 资金操作占用锁时等待，不丢弃信号
        if (executionRef.current) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }

        const signal = queueRef.current.shift()!;

        // 统一资金执行锁（Manual Buy/Sell 与 Auto Buy/Sell 共用同一 gate）
        executionRef.current = true;
        setIsExecuting(true);
        onExecutingChange(true);
        try {
          if (signal.direction === "buy") {
            await followBuy(signal);
          } else {
            await followSell(signal);
          }
        } finally {
          executionRef.current = false;
          setIsExecuting(false);
          onExecutingChange(false);
        }
      }
    } finally {
      queueProcessingRef.current = false;
    }
  }

  async function followBuy(signal: TradeSignal) {
    try {
      let meta: TokenMetadata;
      try {
        meta = await getTokenMetadata(signal.tokenAddress, provider);
      } catch (e) {
        upsertSignalLog({
          txHash: signal.txHash,
          direction: "buy",
          tokenSymbol: "",
          amountText: ethers.formatEther(signal.amountInWei),
          status: "error",
          summary: `代币信息读取失败，已跳过跟单：${safeErrorMessage(e)}`,
        });
        return;
      }

      upsertSignalLog({
        txHash: signal.txHash,
        direction: "buy",
        tokenSymbol: meta.symbol,
        amountText: ethers.formatEther(signal.amountInWei),
        status: "following",
        summary: `Leader 买入 ${ethers.formatEther(signal.amountInWei)} ${network.nativeSymbol}，开始跟单`,
      });

      const slippageBps = slippagePercentToBps(slippageRef.current);
      const followerWallets: CopyTradeWallet[] = followersRef.current.map(
        (f) => ({
          role: "follower",
          name: f.name,
          wallet: createWallet(f.privateKey, provider),
          amountWei: f.buyAmountWei,
          amountText: f.buyAmountText,
        })
      );

      const buyResults = await runFollowersBuy(
        {
          tokenAddress: signal.tokenAddress,
          slippageBps,
          network,
          supportFeeOnTransfer: supportFotRef.current,
          followers: followerWallets,
        },
        () => {}
      );

      // 买入成功后写持仓（仅 success 且实际到账 > 0）
      for (const r of buyResults) {
        if (r.role !== "follower" || r.status !== "success") continue;
        const received = r.receivedAmountWei ?? 0n;
        if (received <= 0n) continue;
        const fw = followerWallets.find(
          (f) => f.wallet.address.toLowerCase() === r.address.toLowerCase()
        );
        upsertPosition(
          network.chainId,
          r.address,
          signal.tokenAddress,
          meta.symbol,
          meta.decimals,
          received,
          fw?.amountWei ?? 0n,
          r.txHash
        );
      }
      setPositions(listPositions(network.chainId));

      const followerDetails: SignalFollowerResult[] = buyResults.map((r) => ({
        name: r.name,
        address: r.address,
        status: r.status,
        txHash: r.txHash,
        error: r.error,
      }));
      const ok = buyResults.filter((r) => r.status === "success").length;
      const failed = buyResults.filter((r) => r.status === "failed").length;
      const unknown = buyResults.filter((r) => r.status === "unknown").length;
      const hasUnknown = unknown > 0;
      const parts = [`成功 ${ok}`];
      if (failed > 0) parts.push(`失败 ${failed}`);
      if (unknown > 0) parts.push(`待确认 ${unknown}`);

      upsertSignalLog({
        txHash: signal.txHash,
        direction: "buy",
        tokenSymbol: meta.symbol,
        amountText: ethers.formatEther(signal.amountInWei),
        status: hasUnknown ? "attention" : "done",
        summary: `跟单买入完成：${parts.join("，")}`,
        followers: followerDetails,
      });
    } catch (e) {
      upsertSignalLog({
        txHash: signal.txHash,
        direction: "buy",
        tokenSymbol: "",
        amountText: "",
        status: "error",
        summary: safeErrorMessage(e),
      });
    }
  }

  async function followSell(signal: TradeSignal) {
    try {
      const positions = listPositions(network.chainId);
      const related = positions.filter(
        (p) => p.tokenAddress.toLowerCase() === signal.tokenAddress.toLowerCase()
      );
      const symbol = related[0]?.tokenSymbol ?? "";

      upsertSignalLog({
        txHash: signal.txHash,
        direction: "sell",
        tokenSymbol: symbol,
        amountText: "",
        status: "following",
        summary: "Leader 卖出，开始跟卖（全额卖出）",
      });

      const slippageBps = slippagePercentToBps(slippageRef.current);
      const followerWallets: CopyTradeWallet[] = followersRef.current.map(
        (f) => ({
          role: "follower",
          name: f.name,
          wallet: createWallet(f.privateKey, provider),
          amountWei: f.buyAmountWei,
          amountText: f.buyAmountText,
        })
      );

      const sellResults = await sellFollowersForToken(
        {
          chainId: network.chainId,
          tokenAddress: signal.tokenAddress,
          slippageBps,
          network,
          supportFeeOnTransfer: supportFotRef.current,
          followers: followerWallets,
        },
        () => {}
      );
      setPositions(listPositions(network.chainId));

      const followerDetails: SignalFollowerResult[] = sellResults.map((r) => ({
        name: r.name,
        address: r.address,
        status: r.status,
        txHash: r.txHash,
        error: r.error,
      }));
      const ok = sellResults.filter((r) => r.status === "success").length;
      const failed = sellResults.filter((r) => r.status === "failed").length;
      const skipped = sellResults.filter((r) => r.status === "skipped").length;
      const unknown = sellResults.filter((r) => r.status === "unknown").length;
      const hasUnknown = unknown > 0;

      const parts = [`成功 ${ok}`];
      if (failed > 0) parts.push(`失败 ${failed}`);
      if (skipped > 0) parts.push(`跳过 ${skipped}`);
      if (unknown > 0) parts.push(`待确认 ${unknown}`);

      upsertSignalLog({
        txHash: signal.txHash,
        direction: "sell",
        tokenSymbol: symbol,
        amountText: "",
        status: hasUnknown ? "attention" : "done",
        summary: `跟卖完成：${parts.join("，")}`,
        followers: followerDetails,
      });
    } catch (e) {
      upsertSignalLog({
        txHash: signal.txHash,
        direction: "sell",
        tokenSymbol: "",
        amountText: "",
        status: "error",
        summary: safeErrorMessage(e),
      });
    }
  }

  async function startMonitor() {
    setError("");
    setMessage("");

    if (!rpcReady) {
      setError("RPC 网络未就绪，无法开始监听");
      return;
    }
    if (!leaderWallet) {
      setError("请先连接带单钱包（输入私钥或连接小狐狸）");
      return;
    }
    if (followersRef.current.length === 0) {
      setError("请先解析跟单钱包");
      return;
    }
    if (!network.routerAddress) {
      setError("当前网络不支持跟单监听");
      return;
    }

    try {
      // 提前校验滑点，避免监听过程中才发现配置非法
      slippagePercentToBps(slippageRef.current);

      const router = new ethers.Contract(
        network.routerAddress,
        PANCAKE_ROUTER_V2_ABI,
        provider
      );
      const wbnb = (await router.WETH()) as string;

      const monitor = startTradeMonitor({
        provider,
        leaderAddress: leaderWallet.address,
        routerAddress: network.routerAddress,
        wbnbAddress: wbnb,
        expectedChainId: network.chainId,
        onSignal: handleSignal,
        onError: (err) => setError(`监听异常：${safeErrorMessage(err)}`),
        onStopped: (reason) => {
          // Fail Closed：monitor 已自行停止，同步 UI 状态并展示原因
          setMonitoring(false);
          monitorRef.current = null;
          setError(reason);
        },
      });

      monitorRef.current = monitor;
      queueLimitReachedRef.current = false;
      setMonitoring(true);
      setMessage(
        `已开始监听带单地址 ${leaderWallet.address.slice(0, 10)}...（区块轮询，4 秒/次）`
      );
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  function stopMonitor() {
    monitorRef.current?.stop();
    monitorRef.current = null;
    // 用户主动停止：清空未处理信号队列；已广播的交易不会被强制取消（drainQueue 中正在 await 的
    // 信号会自然执行完成，shift 已将其移出队列，清空不影响正在执行的交易）
    queueRef.current = [];
    setMonitoring(false);
    setMessage("已停止监听");
  }

  const successCount = results.filter((r) => r.status === "success").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const unknownCount = results.filter((r) => r.status === "unknown").length;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="font-semibold mb-3">带单钱包</h2>

        <div className="inline-flex rounded-lg bg-gray-800 border border-gray-700 p-1 mb-4">
          <button
            onClick={() => switchLeaderMode("privateKey")}
            disabled={isExecuting}
            className={`px-3 py-1.5 rounded-md text-sm ${
              leaderMode === "privateKey"
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-gray-200"
            } disabled:opacity-50`}
          >
            输入私钥
          </button>
          <button
            onClick={() => switchLeaderMode("metamask")}
            disabled={isExecuting}
            className={`px-3 py-1.5 rounded-md text-sm ${
              leaderMode === "metamask"
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-gray-200"
            } disabled:opacity-50`}
          >
            连接小狐狸
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            {leaderMode === "privateKey" ? (
              <>
                <label className="block text-xs text-gray-400 mb-1">私钥</label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={leaderPrivateKey}
                    onChange={(e) => handleLeaderPrivateKeyChange(e.target.value)}
                    disabled={isExecuting}
                    placeholder="0x..."
                    className="flex-1 px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50"
                  />
                  <button
                    onClick={loadLeader}
                    disabled={isExecuting || !rpcReady}
                    className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                  >
                    读取
                  </button>
                </div>
              </>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={connectMeta}
                  disabled={isExecuting || !rpcReady}
                  className="px-4 py-2 rounded-md bg-orange-600 hover:bg-orange-500 disabled:opacity-50 font-medium"
                >
                  连接小狐狸
                </button>
                {leaderWallet && (
                  <button
                    onClick={disconnectMeta}
                    disabled={isExecuting}
                    className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                  >
                    断开
                  </button>
                )}
              </div>
            )}
            {leaderWallet && (
              <div className="mt-2 text-xs space-y-1">
                <div className="font-mono break-all text-gray-300">{leaderWallet.address}</div>
                {leaderBalanceWei != null && (
                  <div className="text-gray-400">
                    余额:{" "}
                    <span className="text-gray-100">
                      {ethers.formatEther(leaderBalanceWei)} {network.nativeSymbol}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">带单买入金额 ({network.nativeSymbol})</label>
            <input
              type="text"
              value={leaderAmountText}
              onChange={(e) => setLeaderAmountText(e.target.value)}
              disabled={isExecuting}
              placeholder="0.5"
              className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="font-semibold mb-3">跟单钱包</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">私钥（每行一个）</label>
            <textarea
              value={followersText}
              onChange={(e) => handleFollowersTextChange(e.target.value)}
              disabled={isExecuting}
              rows={5}
              placeholder={"0xPRIVATEKEY1\n0xPRIVATEKEY2\n0xPRIVATEKEY3"}
              className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">默认买入金额 ({network.nativeSymbol})</label>
            <input
              type="text"
              value={defaultAmountText}
              onChange={(e) => handleDefaultAmountChange(e.target.value)}
              disabled={isExecuting}
              placeholder="0.1"
              className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <button
              onClick={parseFollowers}
              disabled={isExecuting || !rpcReady}
              className="mt-3 px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
            >
              解析跟单钱包
            </button>
          </div>
        </div>

        {followers.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-800">
                  <th className="py-2 pr-4">#</th>
                  <th className="py-2 pr-4">地址</th>
                  <th className="py-2 pr-4">余额</th>
                  <th className="py-2">买入</th>
                </tr>
              </thead>
              <tbody>
                {followers.map((f, i) => (
                  <tr key={f.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4 text-gray-400">{i + 1}</td>
                    <td className="py-2 pr-4 font-mono text-xs break-all">{f.address}</td>
                    <td className="py-2 pr-4">
                      {ethers.formatEther(f.balanceWei)} {network.nativeSymbol}
                    </td>
                    <td className="py-2">
                      <input
                        type="text"
                        value={f.buyAmountText}
                        onChange={(e) => updateFollowerAmount(f.id, e.target.value)}
                        disabled={isExecuting}
                        className="w-20 px-2 py-1 rounded-md bg-gray-800 border border-gray-700 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="font-semibold mb-3">交易参数</h2>
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">代币地址</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={tokenAddress}
                onChange={(e) => handleTokenAddressChange(e.target.value)}
                disabled={isExecuting}
                placeholder="0xTOKEN..."
                className="flex-1 px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50"
              />
              <button
                onClick={loadToken}
                disabled={isExecuting || !rpcReady}
                className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
              >
                读取
              </button>
            </div>
            {tokenMeta && (
              <p className="mt-2 text-xs text-gray-300">
                {tokenMeta.symbol} · {tokenMeta.name}
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">滑点 (%)</label>
            <input
              type="text"
              value={slippageText}
              onChange={(e) => setSlippageText(e.target.value)}
              disabled={isExecuting}
              className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={supportFeeOnTransfer}
                onChange={(e) => setSupportFeeOnTransfer(e.target.checked)}
                disabled={isExecuting}
                className="accent-blue-600"
              />
              含税代币兼容模式
            </label>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={validate}
            disabled={isExecuting}
            className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
          >
            校验
          </button>
          <button
            onClick={start}
            disabled={isExecuting || !rpcReady}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-medium"
          >
            {isExecuting ? "执行中..." : "开始跟单"}
          </button>
        </div>

        {message && <p className="mt-3 text-sm text-green-400">{message}</p>}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </section>

      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">自动监听</h2>
          <div className="flex items-center gap-3">
            {monitoring && (
              <span className="flex items-center gap-1.5 text-xs text-green-400">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                监听中
              </span>
            )}
            <button
              onClick={monitoring ? stopMonitor : startMonitor}
              disabled={!rpcReady || isExecuting}
              className={`px-4 py-2 rounded-md font-medium disabled:opacity-50 ${
                monitoring
                  ? "bg-red-600 hover:bg-red-500"
                  : "bg-green-600 hover:bg-green-500"
              }`}
            >
              {monitoring ? "停止监听" : "开始监听"}
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500">
          监听带单地址的链上买入/卖出，自动触发跟单买入与跟卖（全额卖出）。同一 txHash
          只触发一次。
        </p>

        {signalLog.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-800">
                  <th className="py-2 pr-4">方向</th>
                  <th className="py-2 pr-4">代币</th>
                  <th className="py-2 pr-4">金额</th>
                  <th className="py-2 pr-4">状态</th>
                  <th className="py-2">说明</th>
                </tr>
              </thead>
              <tbody>
                {signalLog.map((e) => (
                  <tr key={e.txHash} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4">
                      <span
                        className={
                          e.direction === "buy"
                            ? "text-green-400"
                            : "text-red-400"
                        }
                      >
                        {e.direction === "buy" ? "买入" : "卖出"}
                      </span>
                    </td>
                    <td className="py-2 pr-4">{e.tokenSymbol || "-"}</td>
                    <td className="py-2 pr-4">{e.amountText || "-"}</td>
                    <td className="py-2 pr-4">
                      <SignalStatusBadge status={e.status} />
                    </td>
                    <td className="py-2 text-xs text-gray-400 break-all">
                      {e.summary}
                      {e.followers?.some((f) => f.status === "unknown") && (
                        <div className="mt-1 space-y-1">
                          {e.followers
                            .filter((f) => f.status === "unknown")
                            .map((f, i) => (
                              <div key={i} className="text-orange-300">
                                {f.name} ·{" "}
                                <span className="font-mono">{f.address}</span>
                                {f.txHash ? (
                                  <>
                                    {" · "}
                                    <a
                                      href={txExplorerUrl(network, f.txHash)}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-blue-400 hover:underline font-mono"
                                    >
                                      {f.txHash.slice(0, 10)}…
                                      {f.txHash.slice(-8)}
                                    </a>
                                  </>
                                ) : null}
                                {" · 已广播待确认，请链上核对，勿重复交易"}
                              </div>
                            ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {results.length > 0 && (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">结果</h2>
            <div className="text-sm text-gray-400">
              成功 <span className="text-green-400">{successCount}</span> · 失败{" "}
              <span className="text-red-400">{failedCount}</span>
              {unknownCount > 0 && (
                <>
                  {" "}
                  · 待确认{" "}
                  <span className="text-orange-400">{unknownCount}</span>
                </>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-800">
                  <th className="py-2 pr-4">角色</th>
                  <th className="py-2 pr-4">地址</th>
                  <th className="py-2 pr-4">买入</th>
                  <th className="py-2 pr-4">状态</th>
                  <th className="py-2">交易</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4">{r.name}</td>
                    <td className="py-2 pr-4 font-mono text-xs break-all">{r.address}</td>
                    <td className="py-2 pr-4">{r.buyAmount}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="py-2">
                      {r.txHash ? (
                        <a
                          href={txExplorerUrl(network, r.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-400 hover:underline"
                        >
                          查看
                        </a>
                      ) : r.error ? (
                        <span className="text-red-400 text-xs">{r.error}</span>
                      ) : (
                        "-"
                      )}
                      {r.status === "unknown" && r.txHash && (
                        <span className="block text-xs text-orange-300 mt-1">
                          已广播但状态未确认，请先通过 txHash 检查链上结果，勿重复发送
                        </span>
                      )}
                      {r.accountingWarning && (
                        <span className="block text-xs text-yellow-300 mt-1">
                          {r.accountingWarning}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={() => exportCopyTradeCsv(results)}
            className="mt-4 px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-sm"
          >
            导出 CSV
          </button>
        </section>
      )}

      {positions.length > 0 && (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="font-semibold mb-3">跟单持仓</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-800">
                  <th className="py-2 pr-4">地址</th>
                  <th className="py-2 pr-4">代币</th>
                  <th className="py-2 pr-4">数量</th>
                  <th className="py-2 pr-4">成本 ({network.nativeSymbol})</th>
                  <th className="py-2 pr-4">卖出比例</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={posKey(p)} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4 font-mono text-xs break-all">
                      {p.follower}
                    </td>
                    <td className="py-2 pr-4">{p.tokenSymbol}</td>
                    <td className="py-2 pr-4">
                      {ethers.formatUnits(p.amountWei, p.decimals)}
                    </td>
                    <td className="py-2 pr-4">
                      {ethers.formatEther(p.costBnbWei)}
                    </td>
                    <td className="py-2 pr-4">
                      <input
                        type="text"
                        value={sellPct[posKey(p)] ?? "100"}
                        onChange={(e) =>
                          setSellPct((prev) => ({
                            ...prev,
                            [posKey(p)]: e.target.value,
                          }))
                        }
                        disabled={isExecuting}
                        className="w-16 px-2 py-1 rounded-md bg-gray-800 border border-gray-700 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
                      />
                      <span className="ml-1 text-gray-400">%</span>
                    </td>
                    <td className="py-2">
                      <button
                        onClick={() =>
                          sellPosition(p, sellPct[posKey(p)] ?? "100")
                        }
                        disabled={isExecuting}
                        className="px-3 py-1 rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-50 text-sm"
                      >
                        卖出
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            持仓为前端内存缓存；卖出比例 100% 即全部卖出，部分卖出按均价等比扣减成本。
          </p>
        </section>
      )}
    </div>
  );
}
