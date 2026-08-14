import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { NETWORKS } from "./config/networks";
import type { NetworkKey } from "./types";
import { LicenseGate } from "./license/LicenseGate";
import { BatchTransfer } from "./transfer/BatchTransfer";
import { CopyTrade } from "./swap/CopyTrade";

type Tab = "transfer" | "copytrade";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 ${
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
  const [verified, setVerified] = useState(false);
  const [networkKey, setNetworkKey] = useState<NetworkKey>("bsc-testnet");
  const [tab, setTab] = useState<Tab>("transfer");
  const [rpcError, setRpcError] = useState("");
  const [blockNumber, setBlockNumber] = useState<number | null>(null);

  const network = NETWORKS[networkKey];

  const provider = useMemo(
    () => new ethers.JsonRpcProvider(network.rpcUrl),
    [network.rpcUrl]
  );

  useEffect(() => {
    let cancelled = false;
    setRpcError("");
    setBlockNumber(null);

    provider
      .getNetwork()
      .then((n) => {
        if (cancelled) return null;
        if (Number(n.chainId) !== network.chainId) {
          setRpcError(
            `RPC 网络不一致（期望 ${network.chainId}，实际 ${Number(n.chainId)}）`
          );
          return null;
        }
        return provider.getBlockNumber();
      })
      .then((block) => {
        if (cancelled || block == null) return;
        setBlockNumber(block);
      })
      .catch(() => {
        if (!cancelled) setRpcError("无法连接 RPC，请检查网络配置");
      });

    return () => {
      cancelled = true;
    };
  }, [provider, network.chainId]);

  if (!verified) {
    return <LicenseGate onVerified={() => setVerified(true)} />;
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
          <h1 className="font-semibold">BSC Batch &amp; Copy Trade Tool</h1>
          <div className="flex items-center gap-3 text-sm">
            <select
              value={networkKey}
              onChange={(e) => setNetworkKey(e.target.value as NetworkKey)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1"
            >
              <option value="bsc-testnet">BSC Testnet</option>
              <option value="bsc-mainnet">BSC Mainnet</option>
            </select>
            <span className="text-green-400">License ✓</span>
            {rpcError ? (
              <span className="text-red-400">{rpcError}</span>
            ) : blockNumber != null ? (
              <span className="text-gray-400">Block #{blockNumber}</span>
            ) : (
              <span className="text-gray-500">连接中...</span>
            )}
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 flex gap-1">
          <TabButton active={tab === "transfer"} onClick={() => setTab("transfer")}>
            批量转账
          </TabButton>
          <TabButton active={tab === "copytrade"} onClick={() => setTab("copytrade")}>
            带单跟单
          </TabButton>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {tab === "transfer" ? (
          <BatchTransfer network={network} provider={provider} />
        ) : (
          <CopyTrade network={network} provider={provider} />
        )}
      </main>
    </div>
  );
}
