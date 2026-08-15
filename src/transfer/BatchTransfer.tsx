import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import type { NetworkConfig, TokenConfig } from "../config/networks";
import type {
  SignerWallet,
  TransferRecipient,
  TransferResult,
} from "../types";
import { createWallet } from "../wallet/wallet";
import { connectMetaMask, onMetaMaskChange } from "../wallet/metamask";
import {
  findDuplicates,
  parseAddresses,
  totalAmountWei,
} from "./parser";
import {
  estimateTransferGas,
  fetchTokenConfig,
  formatAmount,
  getTokenBalance,
  isNative,
  parseAmount,
} from "./token";
import { runBatchTransfer } from "./transfer";
import { exportTransferCsv } from "../utils/csv";
import { txExplorerUrl } from "../utils/explorer";
import { assertExpectedChain } from "../utils/chain";
import { safeErrorMessage } from "../utils/error";

function StatusBadge({ status }: { status: TransferResult["status"] }) {
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

export function BatchTransfer({
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
  const [walletMode, setWalletMode] = useState<"privateKey" | "metamask">(
    "privateKey"
  );
  const [privateKey, setPrivateKey] = useState("");
  const [wallet, setWallet] = useState<SignerWallet | null>(null);

  // 币种选择
  const [token, setToken] = useState<TokenConfig>(network.tokens[0]);
  const [isCustom, setIsCustom] = useState(false);
  const [customAddress, setCustomAddress] = useState("");

  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [nativeBalanceWei, setNativeBalanceWei] = useState<bigint | null>(null);
  const [recipientsText, setRecipientsText] = useState("");
  const [amountText, setAmountText] = useState("");
  const [parsed, setParsed] = useState<TransferRecipient[] | null>(null);
  const [summary, setSummary] = useState("");
  const [results, setResults] = useState<TransferResult[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState("");
  const executionRef = useRef(false);
  const metaSubRef = useRef<(() => void) | null>(null);
  const balanceReqRef = useRef(0);

  useEffect(() => {
    return () => metaSubRef.current?.();
  }, []);

  async function refreshBalance(w: SignerWallet, tk: TokenConfig) {
    const reqId = ++balanceReqRef.current;
    setBalanceWei(null);
    setNativeBalanceWei(null);
    try {
      const [tokenBal, nativeBal] = await Promise.all([
        getTokenBalance(tk, w.address, provider),
        provider.getBalance(w.address),
      ]);
      if (reqId !== balanceReqRef.current) return; // 丢弃过期结果
      setBalanceWei(tokenBal);
      setNativeBalanceWei(nativeBal);
    } catch (e) {
      if (reqId === balanceReqRef.current) setError(safeErrorMessage(e));
    }
  }

  function invalidateParsed() {
    setParsed(null);
    setSummary("");
  }

  function handlePrivateKeyChange(value: string) {
    setPrivateKey(value);
    // 源输入变化 → 旧 wallet / 余额立即失效
    setWallet(null);
    setBalanceWei(null);
    setNativeBalanceWei(null);
  }

  function switchWalletMode(mode: "privateKey" | "metamask") {
    if (isExecuting) return;
    setWalletMode(mode);
    // 模式切换 → 旧 wallet / 余额立即失效
    setWallet(null);
    setBalanceWei(null);
    setNativeBalanceWei(null);
    metaSubRef.current?.();
    metaSubRef.current = null;
    setError("");
  }

  async function connectMeta() {
    setError("");
    setWallet(null);
    setBalanceWei(null);
    setNativeBalanceWei(null);
    try {
      const session = await connectMetaMask(network);
      setWallet(session.signer);
      await refreshBalance(session.signer, token);
      metaSubRef.current?.();
      metaSubRef.current = onMetaMaskChange(() => {
        setWallet(null);
        setBalanceWei(null);
        setNativeBalanceWei(null);
      });
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  function disconnectMeta() {
    metaSubRef.current?.();
    metaSubRef.current = null;
    setWallet(null);
    setBalanceWei(null);
    setNativeBalanceWei(null);
  }

  function handleRecipientsChange(value: string) {
    setRecipientsText(value);
    // 源输入变化 → 旧 parsed / summary 立即失效
    invalidateParsed();
  }

  function handleAmountChange(value: string) {
    setAmountText(value);
    // 金额变化 → 旧 parsed / summary 立即失效
    invalidateParsed();
  }

  async function loadWallet() {
    setError("");
    setWallet(null);
    setBalanceWei(null);
    setNativeBalanceWei(null);
    invalidateParsed();
    setResults([]);

    try {
      const w = createWallet(privateKey, provider);
      setWallet(w);
      await refreshBalance(w, token);
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  function handleTokenSelect(value: string) {
    if (isExecuting) return;
    if (value === "__custom__") {
      setIsCustom(true);
      return;
    }
    setIsCustom(false);
    const found = network.tokens.find((t) => t.symbol === value);
    if (!found) return;
    setToken(found);
    invalidateParsed();
    setError("");
    if (wallet) refreshBalance(wallet, found);
  }

  function handleCustomAddressChange(value: string) {
    setCustomAddress(value);
  }

  async function loadCustomToken() {
    setError("");
    try {
      const cfg = await fetchTokenConfig(customAddress, provider);
      setToken(cfg);
      setIsCustom(false);
      invalidateParsed();
      if (wallet) refreshBalance(wallet, cfg);
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  function validate() {
    setError("");
    setSummary("");
    setParsed(null);

    try {
      if (!amountText.trim()) {
        throw new Error("请填写每笔金额");
      }

      const amountWei = parseAmount(amountText, token.decimals);
      if (amountWei <= 0n) {
        throw new Error("每笔金额必须大于 0");
      }

      const addrs = parseAddresses(recipientsText);
      const recipients: TransferRecipient[] = addrs.map((a) => ({
        lineNo: a.lineNo,
        address: a.address,
        amountText,
        amountWei,
      }));

      const dupes = findDuplicates(recipients);
      const total = totalAmountWei(recipients);

      setParsed(recipients);

      const unit = isNative(token) ? "wei" : "最小单位";
      const parts = [
        `共 ${recipients.length} 笔，每笔 ${amountText} ${token.symbol}（= ${amountWei} ${unit}），合计 ${formatAmount(total, token.decimals)} ${token.symbol}（= ${total} ${unit}）`,
      ];
      if (dupes.length) {
        parts.push(`检测到重复地址：${dupes.join(", ")}（不会自动合并）`);
      }
      setSummary(parts.join("；"));
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  async function start() {
    if (executionRef.current) return;
    executionRef.current = true;
    setIsExecuting(true);
    onExecutingChange(true);

    try {
      if (!rpcReady) {
        setError("RPC 网络未就绪，禁止发起交易");
        return;
      }
      if (!wallet) {
        setError("请先连接发送钱包（输入私钥或连接小狐狸）");
        return;
      }
      if (!parsed) {
        setError("请先校验收款列表");
        return;
      }

      setError("");

      const totalValue = totalAmountWei(parsed);

      // 二次确认：明确展示每笔金额（含 wei）与总笔数，防止误操作
      const unit = isNative(token) ? "wei" : "最小单位";
      const confirmMsg =
        `即将向 ${parsed.length} 个地址发起转账：\n` +
        `每笔 ${parsed[0].amountText} ${token.symbol}（= ${parsed[0].amountWei} ${unit}）\n` +
        `合计 ${formatAmount(totalValue, token.decimals)} ${token.symbol}（= ${totalValue} ${unit}）\n\n` +
        `确认继续？`;
      if (!window.confirm(confirmMsg)) {
        return;
      }

      // 1) 转账本金预检：所选币种余额须 ≥ 本金
      const tokenBalance = await getTokenBalance(token, wallet.address, provider);
      if (tokenBalance < totalValue) {
        setError(
          `余额不足：需 ${formatAmount(totalValue, token.decimals)} ${token.symbol}，当前 ${formatAmount(tokenBalance, token.decimals)} ${token.symbol}`
        );
        return;
      }

      // 2) Gas 预检：逐笔估算（原生币支付 gas）
      const nativeBalance = await provider.getBalance(wallet.address);
      let totalGasCost = 0n;
      try {
        for (const r of parsed) {
          const gasLimit = await estimateTransferGas(
            wallet,
            token,
            r.address,
            r.amountWei
          );
          const feeData = await provider.getFeeData();
          const gasPrice =
            feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000n;
          totalGasCost += gasLimit * gasPrice;
        }
      } catch (e) {
        setError(
          `交易预估失败（收款地址为合约且无接收函数，或代币转账失败）：${safeErrorMessage(e)}`
        );
        return;
      }

      if (nativeBalance < totalGasCost) {
        setError(
          `原生币不足：需 ${ethers.formatEther(totalGasCost)} ${network.nativeSymbol} 用于支付 Gas，当前 ${ethers.formatEther(nativeBalance)} ${network.nativeSymbol}`
        );
        return;
      }

      // 广播前再次核验实际 Chain ID（Fail Closed）——使用实际签名的钱包 Provider
      await assertExpectedChain(wallet.provider!, network.chainId);

      const initial: TransferResult[] = parsed.map((r) => ({
        address: r.address,
        amount: r.amountText,
        status: "processing",
      }));
      setResults(initial);

      await runBatchTransfer(
        wallet,
        token,
        parsed,
        network,
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

  const selectValue = isCustom ? "__custom__" : token.symbol;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="font-semibold mb-3">发送钱包</h2>

        <div className="inline-flex rounded-lg bg-gray-800 border border-gray-700 p-1 mb-4">
          <button
            onClick={() => switchWalletMode("privateKey")}
            disabled={isExecuting}
            className={`px-3 py-1.5 rounded-md text-sm ${
              walletMode === "privateKey"
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-gray-200"
            } disabled:opacity-50`}
          >
            输入私钥
          </button>
          <button
            onClick={() => switchWalletMode("metamask")}
            disabled={isExecuting}
            className={`px-3 py-1.5 rounded-md text-sm ${
              walletMode === "metamask"
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-gray-200"
            } disabled:opacity-50`}
          >
            连接小狐狸
          </button>
        </div>

        {walletMode === "privateKey" ? (
          <>
            <label className="block text-xs text-gray-400 mb-1">发送方私钥</label>
            <div className="flex gap-2">
              <input
                type="password"
                value={privateKey}
                onChange={(e) => handlePrivateKeyChange(e.target.value)}
                disabled={isExecuting}
                placeholder="0x..."
                className="flex-1 px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50"
              />
              <button
                onClick={loadWallet}
                disabled={isExecuting || !rpcReady}
                className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
              >
                读取钱包
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
            {wallet && (
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

        {wallet && (
          <div className="mt-3 text-sm space-y-1">
            <div>
              <span className="text-gray-400">地址: </span>
              <span className="font-mono break-all">{wallet.address}</span>
            </div>
            {balanceWei != null && (
              <div>
                <span className="text-gray-400">币种余额: </span>
                <span className="font-semibold">
                  {formatAmount(balanceWei, token.decimals)} {token.symbol}
                </span>
              </div>
            )}
            {nativeBalanceWei != null && (
              <div>
                <span className="text-gray-400">原生币余额（付 Gas）: </span>
                <span className="text-gray-300">
                  {ethers.formatEther(nativeBalanceWei)} {network.nativeSymbol}
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="font-semibold mb-3">币种</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">选择币种</label>
            <select
              value={selectValue}
              onChange={(e) => handleTokenSelect(e.target.value)}
              disabled={isExecuting}
              className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            >
              {network.tokens.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol}
                </option>
              ))}
              <option value="__custom__">自定义代币…</option>
            </select>
          </div>
          {isCustom && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">代币合约地址</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customAddress}
                  onChange={(e) => handleCustomAddressChange(e.target.value)}
                  disabled={isExecuting}
                  placeholder="0x..."
                  className="flex-1 px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50"
                />
                <button
                  onClick={loadCustomToken}
                  disabled={isExecuting || !rpcReady}
                  className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                >
                  读取
                </button>
              </div>
            </div>
          )}
        </div>
        {token.address && (
          <p className="mt-2 text-xs text-gray-500 font-mono break-all">
            {token.name} · {token.address}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="font-semibold mb-3">收款列表</h2>

        <div className="mb-4">
          <label className="block text-xs text-gray-400 mb-1">
            每笔金额（{token.symbol}）
          </label>
          <input
            type="text"
            value={amountText}
            onChange={(e) => handleAmountChange(e.target.value)}
            disabled={isExecuting}
            placeholder="0.1"
            className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-gray-500">
            所有收款地址均按此固定金额转账
          </p>
        </div>

        <label className="block text-xs text-gray-400 mb-1">收款地址（每行一个）</label>
        <textarea
          value={recipientsText}
          onChange={(e) => handleRecipientsChange(e.target.value)}
          disabled={isExecuting}
          rows={6}
          placeholder={"0xAAA...\n0xBBB...\n0xCCC..."}
          className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
        />

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={validate}
            disabled={isExecuting}
            className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
          >
            校验
          </button>
          <button
            onClick={start}
            disabled={isExecuting || !rpcReady || !wallet || !parsed}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-medium"
          >
            {isExecuting ? "执行中..." : "开始批量转账"}
          </button>
        </div>

        {summary && <p className="mt-3 text-sm text-gray-300">{summary}</p>}
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
                  <th className="py-2 pr-4">地址</th>
                  <th className="py-2 pr-4">金额</th>
                  <th className="py-2 pr-4">状态</th>
                  <th className="py-2">交易</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4 font-mono text-xs break-all">{r.address}</td>
                    <td className="py-2 pr-4">
                      {r.amount} {token.symbol}
                    </td>
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
            onClick={() => exportTransferCsv(results)}
            className="mt-4 px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-sm"
          >
            导出 CSV
          </button>
        </section>
      )}
    </div>
  );
}
