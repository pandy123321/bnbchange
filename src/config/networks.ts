import type { NetworkKey } from "../types";

export interface TokenConfig {
  symbol: string;
  name: string;
  address: string | null; // null = 原生币
  decimals: number;
}

export interface NetworkConfig {
  key: NetworkKey;
  name: string;
  chainId: number;
  rpcUrls: string[]; // 首选在前，连接失败时自动回退到下一个
  routerAddress?: string; // 仅支持 PancakeSwap 跟单的链（BSC）存在
  explorerBaseUrl: string;
  nativeSymbol: string;
  tokens: TokenConfig[];
}

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  "bsc-mainnet": {
    key: "bsc-mainnet",
    name: "BSC 主网",
    chainId: 56,
    rpcUrls: [
      import.meta.env.VITE_BSC_MAINNET_RPC_URL ??
        "https://bsc-dataseed.bnbchain.org",
      "https://bsc-dataseed1.defibit.io",
      "https://bsc-dataseed2.ninicoin.io",
      "https://bsc-rpc.publicnode.com",
      "https://binance.llamarpc.com",
    ],
    routerAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    explorerBaseUrl: "https://bscscan.com",
    nativeSymbol: "BNB",
    tokens: [
      { symbol: "BNB", name: "BNB", address: null, decimals: 18 },
      {
        symbol: "USDT",
        name: "Tether USD",
        address: "0x55d398326f99059fF775485246999027B3197955",
        decimals: 18,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        decimals: 18,
      },
      {
        symbol: "BUSD",
        name: "Binance USD",
        address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
        decimals: 18,
      },
      {
        symbol: "WBNB",
        name: "Wrapped BNB",
        address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        decimals: 18,
      },
    ],
  },

  "bsc-testnet": {
    key: "bsc-testnet",
    name: "BSC 测试网",
    chainId: 97,
    rpcUrls: [
      import.meta.env.VITE_BSC_TESTNET_RPC_URL ??
        "https://bsc-testnet-dataseed.bnbchain.org",
      "https://bsc-testnet.publicnode.com",
      "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    ],
    routerAddress: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    explorerBaseUrl: "https://testnet.bscscan.com",
    nativeSymbol: "tBNB",
    tokens: [{ symbol: "tBNB", name: "tBNB", address: null, decimals: 18 }],
  },

  "eth-mainnet": {
    key: "eth-mainnet",
    name: "以太坊",
    chainId: 1,
    rpcUrls: [
      "https://ethereum.publicnode.com",
      "https://eth.llamarpc.com",
      "https://rpc.ankr.com/eth",
      "https://cloudflare-eth.com",
    ],
    explorerBaseUrl: "https://etherscan.io",
    nativeSymbol: "ETH",
    tokens: [
      { symbol: "ETH", name: "Ether", address: null, decimals: 18 },
      {
        symbol: "USDT",
        name: "Tether USD",
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        decimals: 6,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        decimals: 6,
      },
      {
        symbol: "DAI",
        name: "Dai Stablecoin",
        address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        decimals: 18,
      },
      {
        symbol: "WETH",
        name: "Wrapped Ether",
        address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        decimals: 18,
      },
    ],
  },

  "polygon-mainnet": {
    key: "polygon-mainnet",
    name: "Polygon 主网",
    chainId: 137,
    rpcUrls: [
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.llamarpc.com",
      "https://polygon-rpc.com",
      "https://rpc.ankr.com/polygon",
    ],
    explorerBaseUrl: "https://polygonscan.com",
    nativeSymbol: "POL",
    tokens: [
      { symbol: "POL", name: "Polygon", address: null, decimals: 18 },
      {
        symbol: "USDT",
        name: "Tether USD",
        address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        decimals: 6,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        decimals: 6,
      },
      {
        symbol: "WETH",
        name: "Wrapped Ether",
        address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
        decimals: 18,
      },
      {
        symbol: "WMATIC",
        name: "Wrapped MATIC",
        address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
        decimals: 18,
      },
    ],
  },

  "arbitrum-mainnet": {
    key: "arbitrum-mainnet",
    name: "Arbitrum 主网",
    chainId: 42161,
    rpcUrls: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.llamarpc.com",
      "https://rpc.ankr.com/arbitrum",
    ],
    explorerBaseUrl: "https://arbiscan.io",
    nativeSymbol: "ETH",
    tokens: [
      { symbol: "ETH", name: "Ether", address: null, decimals: 18 },
      {
        symbol: "USDT",
        name: "Tether USD",
        address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        decimals: 6,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        decimals: 6,
      },
      {
        symbol: "ARB",
        name: "Arbitrum",
        address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
        decimals: 18,
      },
      {
        symbol: "WETH",
        name: "Wrapped Ether",
        address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        decimals: 18,
      },
    ],
  },

  "optimism-mainnet": {
    key: "optimism-mainnet",
    name: "Optimism 主网",
    chainId: 10,
    rpcUrls: [
      "https://mainnet.optimism.io",
      "https://optimism.llamarpc.com",
      "https://rpc.ankr.com/optimism",
      "https://optimism.publicnode.com",
    ],
    explorerBaseUrl: "https://optimistic.etherscan.io",
    nativeSymbol: "ETH",
    tokens: [
      { symbol: "ETH", name: "Ether", address: null, decimals: 18 },
      {
        symbol: "USDT",
        name: "Tether USD",
        address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
        decimals: 6,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        decimals: 6,
      },
      {
        symbol: "OP",
        name: "Optimism",
        address: "0x4200000000000000000000000000000000000042",
        decimals: 18,
      },
      {
        symbol: "WETH",
        name: "Wrapped Ether",
        address: "0x4200000000000000000000000000000000000006",
        decimals: 18,
      },
    ],
  },

  "base-mainnet": {
    key: "base-mainnet",
    name: "Base 主网",
    chainId: 8453,
    rpcUrls: [
      "https://mainnet.base.org",
      "https://base.llamarpc.com",
      "https://base-rpc.publicnode.com",
      "https://rpc.ankr.com/base",
    ],
    explorerBaseUrl: "https://basescan.org",
    nativeSymbol: "ETH",
    tokens: [
      { symbol: "ETH", name: "Ether", address: null, decimals: 18 },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
      },
      {
        symbol: "DAI",
        name: "Dai Stablecoin",
        address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
        decimals: 18,
      },
      {
        symbol: "cbBTC",
        name: "Coinbase Wrapped BTC",
        address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
        decimals: 8,
      },
      {
        symbol: "WETH",
        name: "Wrapped Ether",
        address: "0x4200000000000000000000000000000000000006",
        decimals: 18,
      },
    ],
  },
};
