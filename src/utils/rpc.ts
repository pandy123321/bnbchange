import { ethers } from "ethers";

const PROBE_TIMEOUT_MS = 6000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("RPC 请求超时")),
      ms
    );
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

export interface PickedProvider {
  provider: ethers.JsonRpcProvider;
  url: string;
}

// 按顺序探测 rpcUrls，返回第一个 chainId 匹配且可出块的节点
export async function pickProvider(
  rpcUrls: string[],
  expectedChainId: number
): Promise<PickedProvider> {
  let lastError: unknown = null;

  for (const url of rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const network = await withTimeout(provider.getNetwork(), PROBE_TIMEOUT_MS);
      if (Number(network.chainId) !== expectedChainId) {
        lastError = new Error(
          `RPC 链不一致：期望 ${expectedChainId}，实际 ${Number(network.chainId)}`
        );
        continue;
      }
      await withTimeout(provider.getBlockNumber(), PROBE_TIMEOUT_MS);
      return { provider, url };
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError ?? new Error("无可用 RPC 节点");
}
