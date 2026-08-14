export interface LicenseVerifyResponse {
  ok: boolean;
  expiresAt?: number | null;
  error?: string;
}

export async function verifyLicense(code: string): Promise<LicenseVerifyResponse> {
  const baseUrl =
    import.meta.env.VITE_LICENSE_API_BASE_URL ?? "http://127.0.0.1:8787";
  const normalized = code.trim().toUpperCase();

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/tool/verify-license`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: normalized }),
    });
  } catch {
    throw new Error("无法连接授权服务器");
  }

  if (!res.ok) {
    return { ok: false, error: "授权码无效或不可用" };
  }

  return (await res.json()) as LicenseVerifyResponse;
}
