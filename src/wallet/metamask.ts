import { ethers } from "ethers";
import type { NetworkConfig } from "../config/networks";

export interface MetaMaskSession {
  address: string;
  signer: ethers.JsonRpcSigner;
}

export function hasMetaMask(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

function expectedChainHex(network: NetworkConfig): string {
  return "0x" + network.chainId.toString(16);
}

async function currentChainHex(): Promise<string> {
  return (await window.ethereum!.request({ method: "eth_chainId" })) as string;
}

export async function ensureMetaMaskChain(network: NetworkConfig): Promise<void> {
  const expectedHex = expectedChainHex(network);

  if ((await currentChainHex()) === expectedHex) return;

  try {
    await window.ethereum!.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expectedHex }],
    });
    return;
  } catch (switchErr) {
    const code = (switchErr as { code?: number }).code;
    if (code === 4902) {
      try {
        await window.ethereum!.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: expectedHex,
              chainName: network.name,
              nativeCurrency: {
                name: network.nativeSymbol,
                symbol: network.nativeSymbol,
                decimals: 18,
              },
              rpcUrls: network.rpcUrls,
              blockExplorerUrls: [network.explorerBaseUrl],
            },
          ],
        });
        return;
      } catch {
        throw new Error(`请手动在 MetaMask 中添加并切换到 ${network.name} 网络`);
      }
    }
    throw new Error(`请在 MetaMask 中切换到 ${network.name} 网络`);
  }
}

export async function connectMetaMask(
  network: NetworkConfig
): Promise<MetaMaskSession> {
  if (!hasMetaMask()) {
    throw new Error(
      "未检测到 MetaMask。桌面版请先在本机 Chrome / Edge / Brave 安装 MetaMask 扩展并重启应用；或改用「输入私钥」"
    );
  }

  const provider = new ethers.BrowserProvider(
    window.ethereum as unknown as ethers.Eip1193Provider
  );
  const accounts = await provider.send("eth_requestAccounts", []);
  if (!accounts || accounts.length === 0) {
    throw new Error("未获取到 MetaMask 账户");
  }

  await ensureMetaMaskChain(network);

  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  return { address, signer };
}

// 账户或链变化时回调，用于使已连接的 MetaMask 状态失效，避免页面显示与签名账户不一致
export function onMetaMaskChange(handler: () => void): () => void {
  const eth = window.ethereum;
  if (!eth?.on) return () => {};

  eth.on("accountsChanged", handler);
  eth.on("chainChanged", handler);

  return () => {
    eth.removeListener?.("accountsChanged", handler);
    eth.removeListener?.("chainChanged", handler);
  };
}
