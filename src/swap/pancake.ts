import { ethers } from "ethers";
import type { NetworkConfig } from "../config/networks";
import { ERC20_MIN_ABI, PANCAKE_ROUTER_V2_ABI } from "./abi";

export interface TokenMetadata {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface BuyParams {
  wallet: ethers.Wallet;
  tokenAddress: string;
  amountInWei: bigint;
  slippageBps: bigint;
  network: NetworkConfig;
  supportFeeOnTransfer: boolean;
}

export interface BuyResult {
  hash: string;
  success: boolean;
  amountOutMin: bigint;
}

export function getRouter(
  network: NetworkConfig,
  wallet: ethers.Wallet
): ethers.Contract {
  return new ethers.Contract(
    network.routerAddress,
    PANCAKE_ROUTER_V2_ABI,
    wallet
  );
}

export async function getTokenMetadata(
  tokenAddress: string,
  provider: ethers.Provider
): Promise<TokenMetadata> {
  const address = ethers.getAddress(tokenAddress);
  const token = new ethers.Contract(address, ERC20_MIN_ABI, provider);

  const [symbol, name, decimals] = await Promise.all([
    token.symbol(),
    token.name(),
    token.decimals(),
  ]);

  return { address, symbol, name, decimals: Number(decimals) };
}

export async function getQuote(
  router: ethers.Contract,
  wbnb: string,
  tokenAddress: string,
  amountInWei: bigint
): Promise<bigint> {
  const amounts = await router.getAmountsOut(amountInWei, [wbnb, tokenAddress]);
  return BigInt(amounts[1]);
}

export async function buyToken(params: BuyParams): Promise<BuyResult> {
  const router = getRouter(params.network, params.wallet);
  const wbnb = await router.WETH();
  const path = [wbnb, params.tokenAddress];

  const amounts = await router.getAmountsOut(params.amountInWei, path);
  const expectedOut = BigInt(amounts[1]);

  const BPS = 10_000n;
  const amountOutMin = (expectedOut * (BPS - params.slippageBps)) / BPS;
  if (amountOutMin <= 0n) {
    throw new Error("滑点导致最小获得量为 0，请调整滑点");
  }

  const deadline = Math.floor(Date.now() / 1000) + 600;

  const tx = params.supportFeeOnTransfer
    ? await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
        amountOutMin,
        path,
        params.wallet.address,
        deadline,
        { value: params.amountInWei }
      )
    : await router.swapExactETHForTokens(
        amountOutMin,
        path,
        params.wallet.address,
        deadline,
        { value: params.amountInWei }
      );

  const receipt = await tx.wait();

  return {
    hash: tx.hash,
    success: receipt?.status === 1,
    amountOutMin,
  };
}
