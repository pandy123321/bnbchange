import { useRef, useState } from "react";
import { ethers } from "ethers";
import type { NetworkConfig } from "../config/networks";
import type { TransferRecipient, TransferResult } from "../types";
import { createWallet, getWalletBalance } from "../wallet/wallet";
import {
  findDuplicates,
  parseRecipients,
  totalAmountWei,
} from "./parser";
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
  const [privateKey, setPrivateKey] = useState("");
  const [wallet, setWallet] = useState<ethers.Wallet | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [recipientsText, setRecipientsText] = useState("");
  const [parsed, setParsed] = useState<TransferRecipient[] | null>(null);
  const [summary, setSummary] = useState("");
  const [results, setResults] = useState<TransferResult[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState("");
  const executionRef = useRef(false);

  function handlePrivateKeyChange(value: string) {
    setPrivateKey(value);
    // 源输入变化 → 旧 wallet / 余额立即失效
    setWallet(null);
    setBalanceWei(null);
  }

  function handleRecipientsChange(value: string) {
    setRecipientsText(value);
    // 源输入变化 → 旧 parsed / summary 立即失效
    setParsed(null);
    setSummary("");
  }

  async function loadWallet() {
    setError("");
    setWallet(null);
    setBalanceWei(null);
    setParsed(null);
    setSummary("");
    setResults([]);

    try {
      const w = createWallet(privateKey, provider);
      setWallet(w);
      const bal = await getWalletBalance(w.address, provider);
      setBalanceWei(bal);
    } catch (e) {
      setError(safeErrorMessage(e));
    }
  }

  function validate() {
    setError("");
    setSummary("");
    setParsed(null);

    try {
      const recipients = parseRecipients(recipientsText);
      const dupes = findDuplicates(recipients);
      const total = totalAmountWei(recipients);

      setParsed(recipients);

      const parts = [`共 ${recipients.length} 笔，合计 ${ethers.formatEther(total)} ${network.nativeSymbol}`];
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
        setError("请先导入 Sender Private Key");
        return;
      }
      if (!parsed) {
        setError("请先点击 Validate 校验收款列表");
        return;
      }

      setError("");

      // 余额 + Gas 预检：首笔广播前重新读余额并估算总 Gas（Fail Closed）
      const currentBalance = await getWalletBalance(wallet.address, provider);
      let totalGasCost = 0n;
      for (const r of parsed) {
        const gasLimit = await wallet.estimateGas({
          to: r.address,
          value: r.amountWei,
        });
        const feeData = await provider.getFeeData();
        const gasPrice =
          feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000n;
        totalGasCost += BigInt(gasLimit) * gasPrice;
      }

      const totalNeeded = totalAmountWei(parsed) + totalGasCost;
      if (currentBalance < totalNeeded) {
        setError(
          `余额不足：需 ${ethers.formatEther(totalNeeded)} ${network.nativeSymbol}（含预估 Gas），当前 ${ethers.formatEther(currentBalance)}`
        );
        return;
      }

      // 广播前再次核验实际 Chain ID（Fail Closed）
      await assertExpectedChain(provider, network.chainId);

      const initial: TransferResult[] = parsed.map((r) => ({
        address: r.address,
        amount: r.amountText,
        status: "processing",
      }));
      setResults(initial);

      await runBatchTransfer(
        wallet,
        parsed,
        network.chainId,
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
        <h2 className="font-semibold mb-3">Sender 钱包</h2>
        <label className="block text-xs text-gray-400 mb-1">Sender Private Key</label>
        <div className="flex gap-2">
          <input
            type="password"
            value={privateKey}
            onChange={(e) => handlePrivateKeyChange(e.target.value)}
            placeholder="0x..."
            className="flex-1 px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={loadWallet}
            disabled={isExecuting || !rpcReady}
            className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
          >
            读取钱包
          </button>
        </div>

        {wallet && (
          <div className="mt-3 text-sm space-y-1">
            <div>
              <span className="text-gray-400">Address: </span>
              <span className="font-mono break-all">{wallet.address}</span>
            </div>
            {balanceWei != null && (
              <div>
                <span className="text-gray-400">Balance: </span>
                <span className="font-semibold">
                  {ethers.formatEther(balanceWei)} {network.nativeSymbol}
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="font-semibold mb-3">收款列表（地址,金额 一行一笔）</h2>
        <textarea
          value={recipientsText}
          onChange={(e) => handleRecipientsChange(e.target.value)}
          rows={6}
          placeholder={"0xAAA...,0.1\n0xBBB...,0.25\n0xCCC...,0.5"}
          className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono text-sm focus:outline-none focus:border-blue-500"
        />

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={validate}
            disabled={isExecuting}
            className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
          >
            Validate
          </button>
          <button
            onClick={start}
            disabled={isExecuting || !rpcReady || !wallet || !parsed}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-medium"
          >
            {isExecuting ? "执行中..." : "Start Batch Transfer"}
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
                  <th className="py-2 pr-4">Address</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">TX</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4 font-mono text-xs break-all">{r.address}</td>
                    <td className="py-2 pr-4">{r.amount}</td>
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
                          View
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
            Export CSV
          </button>
        </section>
      )}
    </div>
  );
}
