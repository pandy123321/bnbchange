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
  parseRecipientInput,
  totalAmountWei,
} from "./parser";
import {
  checkTransferFunds,
  estimateTransferGas,
  fetchTokenConfig,
  formatAmount,
  getTokenBalance,
  isNative,
} from "./token";
import { runBatchTransfer } from "./transfer";
import { Blockies, shortAddress } from "./Blockies";
import { exportTransferCsv } from "../utils/csv";
import { txExplorerUrl } from "../utils/explorer";
import { assertExpectedChain } from "../utils/chain";
import { safeErrorMessage } from "../utils/error";

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_LABELS = ["准备", "收款列表", "预览", "确认", "结果"];

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

function Stepper({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-2 mb-5 overflow-x-auto">
      {STEP_LABELS.map((label, i) => {
        const n = (i + 1) as Step;
        const active = n === step;
        const done = n < step;
        return (
          <div key={label} className="flex items-center gap-2 shrink-0">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium border ${
                active
                  ? "bg-blue-600 border-blue-500 text-white"
                  : done
                  ? "bg-green-600 border-green-500 text-white"
                  : "bg-gray-800 border-gray-700 text-gray-400"
              }`}
            >
              {done ? "✓" : n}
            </div>
            <span
              className={`text-sm ${
                active ? "text-gray-100" : done ? "text-green-400" : "text-gray-500"
              }`}
            >
              {label}
            </span>
            {n < 5 && <span className="text-gray-700">—</span>}
          </div>
        );
      })}
    </div>
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
  const [step, setStep] = useState<Step>(1);

  const [walletMode, setWalletMode] = useState<"privateKey" | "metamask">(
    "privateKey"
  );
  const [privateKey, setPrivateKey] = useState("");
  const [wallet, setWallet] = useState<SignerWallet | null>(null);

  const [token, setToken] = useState<TokenConfig>(network.tokens[0]);
  const [isCustom, setIsCustom] = useState(false);
  const [customAddress, setCustomAddress] = useState("");

  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [nativeBalanceWei, setNativeBalanceWei] = useState<bigint | null>(null);
  const [recipientsText, setRecipientsText] = useState("");
  const [parsed, setParsed] = useState<TransferRecipient[] | null>(null);
  const [gasTotalWei, setGasTotalWei] = useState<bigint | null>(null);
  const [dupes, setDupes] = useState<string[]>([]);
  const [largeAck, setLargeAck] = useState(false);
  const [results, setResults] = useState<TransferResult[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const executionRef = useRef(false);
  const metaSubRef = useRef<(() => void) | null>(null);
  const balanceReqRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 大额冷静警告阈值：总额 > 10 个代币单位（按代币 decimals 折算）
  const largeAmountWei = 10n * 10n ** BigInt(token.decimals);

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
      if (reqId !== balanceReqRef.current) return;
      setBalanceWei(tokenBal);
      setNativeBalanceWei(nativeBal);
    } catch (e) {
      if (reqId === balanceReqRef.current) setError(safeErrorMessage(e));
    }
  }

  function invalidateParsed() {
    setParsed(null);
    setDupes([]);
    setGasTotalWei(null);
    setLargeAck(false);
  }

  function handlePrivateKeyChange(value: string) {
    setPrivateKey(value);
    setWallet(null);
    setBalanceWei(null);
    setNativeBalanceWei(null);
  }

  function switchWalletMode(mode: "privateKey" | "metamask") {
    if (isExecuting) return;
    setWalletMode(mode);
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

  async function computeGas(recipients: TransferRecipient[]) {
    if (!wallet) return;
    setGasTotalWei(null);
    let total = 0n;
    try {
      for (const r of recipients) {
        const gasLimit = await estimateTransferGas(
          wallet,
          token,
          r.address,
          r.amountWei
        );
        const feeData = await provider.getFeeData();
        const gasPrice =
          feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000n;
        total += gasLimit * gasPrice;
      }
      setGasTotalWei(total);
    } catch {
      setGasTotalWei(null);
    }
  }

  function goToStep2() {
    setError("");
    if (!wallet) {
      setError("请先连接发送钱包（输入私钥或连接小狐狸）");
      return;
    }
    setStep(2);
  }

  function goToStep3() {
    setError("");
    try {
      const recipients = parseRecipientInput(recipientsText, token.decimals);
      setParsed(recipients);
      setDupes(findDuplicates(recipients));
      setGasTotalWei(null);
      setStep(3);
      void computeGas(recipients);
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  function goToStep4() {
    if (!parsed) return;
    setError("");
    setLargeAck(false);
    setStep(4);
  }

  async function execute() {
    if (executionRef.current) return;
    if (!parsed) return;

    executionRef.current = true;
    setIsExecuting(true);
    onExecutingChange(true);

    try {
      if (!rpcReady) {
        setError("RPC 网络未就绪，禁止发起交易");
        return;
      }
      if (!wallet) {
        setError("请先连接发送钱包");
        return;
      }

      setError("");

      const totalValue = totalAmountWei(parsed);

      // Gas 价格在批量估算前读取一次，避免每笔重复读取
      let gasPrice: bigint;
      try {
        const feeData = await provider.getFeeData();
        gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000n;
      } catch (e) {
        setError(`无法获取 Gas 价格：${safeErrorMessage(e)}`);
        return;
      }

      // Gas 预检：逐笔估算（原生币支付 gas）
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
          totalGasCost += gasLimit * gasPrice;
        }
      } catch (e) {
        setError(
          `交易预估失败（收款地址为合约且无接收函数，或代币转账失败）：${safeErrorMessage(e)}`
        );
        return;
      }

      // 余额预检：原生币合并判断（本金 + Gas），ERC20 分别判断（本金 / Gas）
      const tokenBalance = isNative(token)
        ? nativeBalance
        : await getTokenBalance(token, wallet.address, provider);
      const funds = checkTransferFunds(
        token,
        tokenBalance,
        nativeBalance,
        totalValue,
        totalGasCost
      );
      if (!funds.ok) {
        setError(funds.reason ?? "余额不足");
        return;
      }

      await assertExpectedChain(wallet.provider!, network.chainId);

      const initial: TransferResult[] = parsed.map((r) => ({
        address: r.address,
        amount: r.amountText,
        status: "processing",
      }));
      setResults(initial);
      setStep(5);

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

  function downloadTemplate() {
    const header = "address,amount";
    const example = `0x000000000000000000000000000000000000dEaD,1.0\n0x000000000000000000000000000000000000dEaD,0.5`;
    const blob = new Blob(["\uFEFF" + header + "\n" + example], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "批量转账模板.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setRecipientsText(String(reader.result ?? ""));
      invalidateParsed();
    };
    reader.onerror = () => setError("文件读取失败");
    reader.readAsText(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  const successCount = results.filter((r) => r.status === "success").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const unknownCount = results.filter((r) => r.status === "unknown").length;
  const selectValue = isCustom ? "__custom__" : token.symbol;
  const totalWei = parsed ? totalAmountWei(parsed) : 0n;
  const isLarge = totalWei > largeAmountWei;

  return (
    <div className="space-y-6">
      <Stepper step={step} />

      {step === 1 && (
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
              <label className="block text-xs text-gray-400 mb-1">
                发送方私钥
              </label>
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
              <div className="flex items-center gap-2">
                <Blockies address={wallet.address} size={20} />
                <span className="font-mono">{shortAddress(wallet.address)}</span>
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

          <div className="mt-5">
            <h2 className="font-semibold mb-3">币种</h2>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  选择币种
                </label>
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
                  <label className="block text-xs text-gray-400 mb-1">
                    代币合约地址
                  </label>
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
          </div>

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          <div className="mt-5 flex justify-end">
            <button
              onClick={goToStep2}
              className="px-5 py-2 rounded-md bg-blue-600 hover:bg-blue-500 font-medium"
            >
              下一步
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="font-semibold mb-3">收款列表</h2>
          <p className="text-xs text-gray-500 mb-3">
            每行一笔，格式{" "}
            <code className="text-gray-300">address,amount</code>
            ；支持粘贴、CSV/JSON 拖拽或文件导入。
          </p>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`border-2 border-dashed rounded-lg p-1 transition-colors ${
              dragOver ? "border-blue-500 bg-blue-500/5" : "border-gray-700"
            }`}
          >
            <textarea
              value={recipientsText}
              onChange={(e) => handleRecipientsChange(e.target.value)}
              disabled={isExecuting}
              rows={8}
              placeholder={"0xAAA... , 0.1\n0xBBB... , 0.2\n0xCCC... , 0.3"}
              className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isExecuting}
              className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
            >
              导入 CSV/JSON
            </button>
            <button
              onClick={downloadTemplate}
              disabled={isExecuting}
              className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
            >
              下载模板
            </button>
          </div>

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          <div className="mt-5 flex justify-between">
            <button
              onClick={() => setStep(1)}
              disabled={isExecuting}
              className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
            >
              上一步
            </button>
            <button
              onClick={goToStep3}
              disabled={isExecuting}
              className="px-5 py-2 rounded-md bg-blue-600 hover:bg-blue-500 font-medium"
            >
              下一步
            </button>
          </div>
        </section>
      )}

      {step === 3 && parsed && (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="font-semibold mb-3">预览汇总</h2>

          <div className="grid md:grid-cols-3 gap-4 mb-4">
            <div className="rounded-lg bg-gray-800 p-4">
              <div className="text-xs text-gray-400">收款笔数</div>
              <div className="text-2xl font-semibold">{parsed.length}</div>
            </div>
            <div className="rounded-lg bg-gray-800 p-4">
              <div className="text-xs text-gray-400">
                合计（{token.symbol}）
              </div>
              <div className="text-2xl font-semibold">
                {formatAmount(totalWei, token.decimals)}
              </div>
            </div>
            <div className="rounded-lg bg-gray-800 p-4">
              <div className="text-xs text-gray-400">
                预估 Gas（{network.nativeSymbol}）
              </div>
              <div className="text-2xl font-semibold">
                {gasTotalWei == null
                  ? wallet
                    ? "估算中…"
                    : "连接钱包后显示"
                  : ethers.formatEther(gasTotalWei)}
              </div>
            </div>
          </div>

          {dupes.length > 0 && (
            <div className="mb-4 rounded-lg border border-yellow-800 bg-yellow-900/20 px-4 py-2 text-sm text-yellow-300">
              检测到重复地址：{dupes.map((d) => shortAddress(d)).join(", ")}
              （不会自动合并，将分别转账）
            </div>
          )}

          <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-900">
                <tr className="text-left text-gray-400 border-b border-gray-800">
                  <th className="py-2 px-3">#</th>
                  <th className="py-2 px-3">地址</th>
                  <th className="py-2 px-3">金额</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((r, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="py-2 px-3 text-gray-400">{i + 1}</td>
                    <td className="py-2 px-3">
                      <span className="flex items-center gap-2">
                        <Blockies address={r.address} size={18} />
                        <span className="font-mono text-xs">
                          {shortAddress(r.address)}
                        </span>
                      </span>
                    </td>
                    <td className="py-2 px-3">
                      {r.amountText} {token.symbol}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          <div className="mt-5 flex justify-between">
            <button
              onClick={() => setStep(2)}
              disabled={isExecuting}
              className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
            >
              上一步
            </button>
            <button
              onClick={goToStep4}
              disabled={isExecuting}
              className="px-5 py-2 rounded-md bg-blue-600 hover:bg-blue-500 font-medium"
            >
              下一步
            </button>
          </div>
        </section>
      )}

      {step === 4 && parsed && (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="font-semibold mb-3">确认转账</h2>

          <div className="rounded-lg bg-gray-800 p-4 mb-4 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">收款笔数</span>
              <span>{parsed.length} 笔</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">
                合计 {token.symbol}
              </span>
              <span className="font-semibold">
                {formatAmount(totalWei, token.decimals)}
              </span>
            </div>
            {gasTotalWei != null && (
              <div className="flex justify-between">
                <span className="text-gray-400">
                  预估 Gas（{network.nativeSymbol}）
                </span>
                <span>{ethers.formatEther(gasTotalWei)}</span>
              </div>
            )}
          </div>

          {isLarge && (
            <div className="mb-4 rounded-lg border border-red-800 bg-red-900/20 px-4 py-3">
              <p className="text-sm text-red-300 font-medium mb-2">
                大额转账冷静警告
              </p>
              <p className="text-xs text-red-300/80">
                本次转账总额超过{" "}
                {formatAmount(largeAmountWei, token.decimals)} {token.symbol}
                ，请仔细核对收款地址，确认无误后再继续。
              </p>
              <label className="flex items-center gap-2 text-sm mt-2">
                <input
                  type="checkbox"
                  checked={largeAck}
                  onChange={(e) => setLargeAck(e.target.checked)}
                  disabled={isExecuting}
                  className="accent-red-600"
                />
                我已核对收款地址与金额，了解转账不可撤销
              </label>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          <div className="mt-5 flex justify-between">
            <button
              onClick={() => setStep(3)}
              disabled={isExecuting}
              className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
            >
              上一步
            </button>
            <button
              onClick={execute}
              disabled={isExecuting || !rpcReady || (isLarge && !largeAck)}
              className="px-5 py-2 rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-50 font-medium"
            >
              {isExecuting ? "执行中..." : "确认并转账"}
            </button>
          </div>
        </section>
      )}

      {step === 5 && (
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

          {successCount === results.length && results.length > 0 && (
            <div className="mb-4 rounded-lg border border-green-800 bg-green-900/20 px-4 py-3 flex items-center gap-2 animate-pulse">
              <span className="text-green-400 text-lg">✓</span>
              <span className="text-sm text-green-300">
                全部转账已完成
              </span>
            </div>
          )}

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
                    <td className="py-2 pr-4">
                      <span className="flex items-center gap-2">
                        <Blockies address={r.address} size={18} />
                        <span className="font-mono text-xs">
                          {shortAddress(r.address)}
                        </span>
                      </span>
                    </td>
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

          <div className="mt-4 flex gap-3">
            <button
              onClick={() => exportTransferCsv(results)}
              className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-sm"
            >
              导出 CSV
            </button>
            <button
              onClick={() => {
                setStep(1);
                setRecipientsText("");
                setParsed(null);
                setResults([]);
                setDupes([]);
                setGasTotalWei(null);
                setLargeAck(false);
              }}
              disabled={isExecuting}
              className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-sm"
            >
              开始新转账
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
