import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import type { NetworkConfig } from "../config/networks";
import type {
  CopyTradeResult,
  FollowerConfig,
  SignerWallet,
} from "../types";
import { createWallet, getWalletBalance } from "../wallet/wallet";
import { connectMetaMask, onMetaMaskChange } from "../wallet/metamask";
import {
  estimateBuyGasCost,
  getTokenMetadata,
  type TokenMetadata,
} from "./pancake";
import { runCopyTrade, type CopyTradeWallet } from "./copyTradeEngine";
import { exportCopyTradeCsv } from "../utils/csv";
import { txExplorerUrl } from "../utils/explorer";
import { safeErrorMessage } from "../utils/error";

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
  const [isExecuting, setIsExecuting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const executionRef = useRef(false);
  const metaSubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => metaSubRef.current?.();
  }, []);

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

      await runCopyTrade(
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
    } catch (e) {
      setError(safeErrorMessage(e));
    } finally {
      executionRef.current = false;
      setIsExecuting(false);
      onExecutingChange(false);
    }
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
    </div>
  );
}
