export interface LicenseVerifyResponse {
  ok: boolean;
  expiresAt?: number | null;
  error?: string;
}

export interface SessionResponse {
  ok: boolean;
  sessionToken?: string;
  expiresAt?: number | null;
  error?: string;
}

const BASE_URL =
  import.meta.env.VITE_LICENSE_API_BASE_URL ?? "http://127.0.0.1:8788";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("无法连接授权服务器");
  }

  if (!res.ok) {
    return { ok: false, error: "授权码无效或不可用" } as T;
  }

  return (await res.json()) as T;
}

export async function verifyLicense(code: string): Promise<LicenseVerifyResponse> {
  const normalized = code.trim().toUpperCase();
  return postJson<LicenseVerifyResponse>("/api/tool/verify-license", {
    code: normalized,
  });
}

// 桌面端验证授权码成功后，用一次性 token 换取“已验证”状态（浏览器免二次输入）
export async function verifySession(token: string): Promise<LicenseVerifyResponse> {
  return postJson<LicenseVerifyResponse>("/api/tool/verify-session", { token });
}
