import type { NetworkKey } from "../types";

export interface NetworkConfig {
  key: NetworkKey;
  name: string;
  chainId: number;
  rpcUrl: string;
  routerAddress: string;
  explorerBaseUrl: string;
  nativeSymbol: string;
}

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  "bsc-mainnet": {
    key: "bsc-mainnet",
    name: "BSC Mainnet",
    chainId: 56,
    rpcUrl:
      import.meta.env.VITE_BSC_MAINNET_RPC_URL ??
      "https://bsc-dataseed.bnbchain.org",
    routerAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    explorerBaseUrl: "https://bscscan.com",
    nativeSymbol: "BNB",
  },

  "bsc-testnet": {
    key: "bsc-testnet",
    name: "BSC Testnet",
    chainId: 97,
    rpcUrl:
      import.meta.env.VITE_BSC_TESTNET_RPC_URL ??
      "https://bsc-testnet-dataseed.bnbchain.org",
    routerAddress: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    explorerBaseUrl: "https://testnet.bscscan.com",
    nativeSymbol: "tBNB",
  },
};
