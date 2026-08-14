import { ethers } from "ethers";
import type { NetworkConfig } from "../config/networks";
import type { SimpleTxStatus } from "../types";
import { safeErrorMessage } from "../utils/error";
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
  hash?: string;
  status: SimpleTxStatus;
  amountOutMin: bigint;
  error?: string;
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
  let hash: string | undefined;
  let amountOutMin = 0n;

  try {
    const router = getRouter(params.network, params.wallet);
    const wbnb = await router.WETH();
    const path = [wbnb, params.tokenAddress];

    const amounts = await router.getAmountsOut(params.amountInWei, path);
    const expectedOut = BigInt(amounts[1]);

    const BPS = 10_000n;
    amountOutMin = (expectedOut * (BPS - params.slippageBps)) / BPS;
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

    hash = tx.hash;

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      return { hash, status: "success", amountOutMin };
    }

    return {
      hash,
      status: "failed",
      amountOutMin,
      error: "Transaction reverted",
    };
  } catch (error) {
    // 已广播但 receipt 无法确认 → unknown，保留 txHash
    return {
      hash,
      status: hash ? "unknown" : "failed",
      amountOutMin,
      error: safeErrorMessage(error),
    };
  }
}

export async function estimateBuyGasCost(
  wallet: ethers.Wallet,
  network: NetworkConfig,
  tokenAddress: string,
  amountInWei: bigint,
  supportFeeOnTransfer: boolean
): Promise<bigint> {
  const router = getRouter(network, wallet);
  const wbnb = await router.WETH();
  const path = [wbnb, tokenAddress];

  await router.getAmountsOut(amountInWei, path);

  // 估算用：使用极小 amountOutMin 避免因滑点/税导致估算阶段 revert，
  // 只需拿到真实 gas 用量；实际交易的 amountOutMin 由 buyToken 单独计算。
  const amountOutMin = 1n;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const gasLimit = supportFeeOnTransfer
    ? await router.swapExactETHForTokensSupportingFeeOnTransferTokens.estimateGas(
        amountOutMin,
        path,
        wallet.address,
        deadline,
        { value: amountInWei }
      )
    : await router.swapExactETHForTokens.estimateGas(
        amountOutMin,
        path,
        wallet.address,
        deadline,
        { value: amountInWei }
      );

  const provider = wallet.provider as ethers.JsonRpcProvider;
  const feeData = await provider.getFeeData();
  const gasPrice =
    feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000n;

  return BigInt(gasLimit) * gasPrice;
}
