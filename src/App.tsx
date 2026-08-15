import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { NETWORKS } from "./config/networks";
import type { NetworkKey } from "./types";
import { LicenseGate } from "./license/LicenseGate";
import { verifySession } from "./license/licenseApi";
import { BatchTransfer } from "./transfer/BatchTransfer";
import { CopyTrade } from "./swap/CopyTrade";
import { pickProvider } from "./utils/rpc";

type Tab = "transfer" | "copytrade";

// 授权安全模型（Fail Closed）：
// - 客户端不再信任任何 localStorage/sessionStorage/IndexedDB 中的“授权/时间戳”状态，
//   杜绝手工写入 bnb_tool_license=permanent 或未来时间戳绕过授权；
// - 每次启动都必须通过服务端在线验证（一次性 session 或手动输入授权码），
//   授权码被吊销后下次启动即失效；
// - 开发环境绕过仅在 import.meta.env.DEV 下生效，生产构建恒为 false，无法绕过。

function TabButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 text-sm font-medium border-b-2 disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "border-blue-500 text-gray-100"
          : "border-transparent text-gray-400 hover:text-gray-200"
      }`}
    >
      {children}
    </button>
  );
}

export default function App() {
  // 仅用于本地冒烟测试的环境变量开关；默认不绕过授权门禁。
  // 强制绑定开发环境：生产构建（npm run build / dist）下 import.meta.env.DEV 恒为 false，
  // 因此即使误设 VITE_BYPASS_LICENSE=1，也无法绕过授权（Fail Closed）。
  const licenseBypass =
    import.meta.env.DEV && import.meta.env.VITE_BYPASS_LICENSE === "1";
  const [verified, setVerified] = useState(licenseBypass);
  const [checkingSession, setCheckingSession] = useState(false);
  const [networkKey, setNetworkKey] = useState<NetworkKey>("bsc-testnet");
  const [tab, setTab] = useState<Tab>("transfer");
  const [provider, setProvider] = useState<ethers.JsonRpcProvider | null>(null);
  const [rpcError, setRpcError] = useState("");
  const [rpcReady, setRpcReady] = useState(false);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);

  const network = NETWORKS[networkKey];

  // 桌面端验证授权码后，会用系统浏览器打开带 ?session=<token> 的地址；
  // 这里消费该一次性 token 换取“已验证”状态，避免在浏览器里二次输入授权码。
  useEffect(() => {
    if (verified || licenseBypass) return;
    const token = new URLSearchParams(window.location.search).get("session");
    if (!token) return;

    setCheckingSession(true);
    verifySession(token)
      .then((res) => {
        if (res.ok) {
          setVerified(true);
        }
      })
      .catch(() => {
        // 忽略，回退到手动输入授权码
      })
      .finally(() => {
        setCheckingSession(false);
        const url = new URL(window.location.href);
        url.searchParams.delete("session");
        window.history.replaceState({}, "", url);
      });
  }, [verified, licenseBypass]);

  useEffect(() => {
    let cancelled = false;
    setRpcError("");
    setRpcReady(false);
    setBlockNumber(null);
    setProvider(null);

    pickProvider(network.rpcUrls, network.chainId)
      .then(async ({ provider: p }) => {
        if (cancelled) return;
        setProvider(p);
        setRpcReady(true);
        const block = await p.getBlockNumber();
        if (!cancelled) setBlockNumber(block);
      })
      .catch((e) => {
        if (cancelled) return;
        setRpcError(
          e instanceof Error ? e.message : "无法连接 RPC，请检查网络配置"
        );
      });

    return () => {
      cancelled = true;
    };
  }, [network]);

  if (!verified) {
    if (checkingSession) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-950 text-gray-100">
          <p className="text-sm text-gray-400">正在验证授权...</p>
        </div>
      );
    }
    return (
      <LicenseGate
        onVerified={() => {
          setVerified(true);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
          <h1 className="font-semibold">BSC 批量转账与跟单工具</h1>
          <div className="flex items-center gap-3 text-sm">
            <select
              value={networkKey}
              onChange={(e) => {
                const key = e.target.value as NetworkKey;
                setNetworkKey(key);
                if (!NETWORKS[key].routerAddress && tab === "copytrade") {
                  setTab("transfer");
                }
              }}
              disabled={isExecuting}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 disabled:opacity-50"
            >
              {Object.entries(NETWORKS).map(([key, n]) => (
                <option key={key} value={key}>
                  {n.name}
                </option>
              ))}
            </select>
            <span className="text-green-400">授权 ✓</span>
            {rpcError ? (
              <span className="text-red-400">{rpcError}</span>
            ) : rpcReady && blockNumber != null ? (
              <span className="text-gray-400">区块 #{blockNumber}</span>
            ) : (
              <span className="text-gray-500">连接中...</span>
            )}
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 flex gap-1">
          <TabButton
            active={tab === "transfer"}
            onClick={() => setTab("transfer")}
            disabled={isExecuting}
          >
            批量转账
          </TabButton>
          <TabButton
            active={tab === "copytrade"}
            onClick={() => setTab("copytrade")}
            disabled={isExecuting || !network.routerAddress}
          >
            带单跟单
          </TabButton>
          {!network.routerAddress && (
            <span className="ml-2 self-center text-xs text-gray-500">
              跟单仅支持 BSC（PancakeSwap）
            </span>
          )}
        </div>
      </header>

      {!rpcReady && (
        <div className="max-w-5xl mx-auto px-4 pt-4">
          <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-2 text-sm text-red-300">
            {rpcError
              ? `RPC 网络不可用：${rpcError}`
              : "正在连接 RPC 网络..."}
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-6">
        {provider ? (
          tab === "transfer" ? (
            <BatchTransfer
              key={network.key}
              network={network}
              provider={provider}
              rpcReady={rpcReady}
              onExecutingChange={setIsExecuting}
            />
          ) : (
            <CopyTrade
              key={network.key}
              network={network}
              provider={provider}
              rpcReady={rpcReady}
              onExecutingChange={setIsExecuting}
            />
          )
        ) : (
          <div className="text-center text-gray-500 py-16">
            {rpcError ? "RPC 网络不可用，请稍后重试" : "正在连接 RPC 网络..."}
          </div>
        )}
      </main>
    </div>
  );
}
