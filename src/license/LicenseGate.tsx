import { useState } from "react";
import { verifyLicense } from "./licenseApi";

export function LicenseGate({
  onVerified,
}: {
  onVerified: (expiresAt: number | null) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleVerify() {
    if (!code.trim()) {
      setError("请输入授权码");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await verifyLicense(code);
      if (res.ok) {
        onVerified(res.expiresAt ?? null);
      } else {
        setError(res.error ?? "授权码无效或不可用");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法连接授权服务器");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 text-gray-100">
      <div className="w-full max-w-sm p-8 rounded-xl bg-gray-900 border border-gray-800 shadow-xl">
        <h1 className="text-xl font-semibold text-center mb-1">
          BSC 批量转账与跟单工具
        </h1>
        <p className="text-center text-xs text-gray-500 mb-6">仅限内部授权使用</p>

        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          className="w-full mb-4 px-3 py-2 rounded-md bg-gray-800 border border-gray-700 font-mono text-center tracking-widest focus:outline-none focus:border-blue-500"
          onKeyDown={(e) => e.key === "Enter" && handleVerify()}
        />

        {error && (
          <p className="text-red-400 text-sm mb-3 text-center">{error}</p>
        )}

        <button
          onClick={handleVerify}
          disabled={loading}
          className="w-full py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-medium"
        >
          {loading ? "验证中..." : "验证"}
        </button>
      </div>
    </div>
  );
}
