import { ethers } from "ethers";
import type { NetworkConfig } from "../config/networks";
import type { SignerWallet, SimpleTxStatus } from "../types";
import { assertExpectedChain } from "../utils/chain";
import { isConfirmedRevert, safeErrorMessage } from "../utils/error";
import { ERC20_MIN_ABI, PANCAKE_ROUTER_V2_ABI } from "./abi";

export interface TokenMetadata {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface BuyParams {
  wallet: SignerWallet;
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
  // 买入前报价得到的目标代币数量（仅用于 Quote / UI，不用于持仓记账）
  expectedOut: bigint;
  // 买入确认后实际到账数量（balance delta），持仓记账 SoT，覆盖 FOT 代币
  receivedAmountWei: bigint;
  // 链上成功但到账量无法解析（0）时的结算告警，用于 UI 提示、禁止建仓
  accountingWarning?: string;
  error?: string;
}

export function getRouter(
  network: NetworkConfig,
  wallet: SignerWallet
): ethers.Contract {
  if (!network.routerAddress) {
    throw new Error("当前网络不支持 PancakeSwap 跟单");
  }
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

async function getGasPrice(provider: ethers.Provider): Promise<bigint> {
  const feeData = await provider.getFeeData();
  return feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000n;
}

export async function buyToken(params: BuyParams): Promise<BuyResult> {
  let hash: string | undefined;
  let amountOutMin = 0n;
  let expectedOut = 0n;
  let receivedAmountWei = 0n;

  try {
    // 广播前再次核验实际 Chain ID（Fail Closed）
    await assertExpectedChain(params.wallet.provider!, params.network.chainId);

    const router = getRouter(params.network, params.wallet);
    const wbnb = await router.WETH();
    const path = [wbnb, params.tokenAddress];

    // 买入前余额，用于结算实际到账量（覆盖 Fee-On-Transfer 代币）
    const token = new ethers.Contract(
      params.tokenAddress,
      ERC20_MIN_ABI,
      params.wallet
    );
    const balanceBefore = BigInt(
      await token.balanceOf(params.wallet.address)
    );

    const amounts = await router.getAmountsOut(params.amountInWei, path);
    expectedOut = BigInt(amounts[1]);

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
      // 交易已确认 success，后续结算 RPC 故障不得改变交易状态（保持 success）
      try {
        const balanceAfter = BigInt(
          await token.balanceOf(params.wallet.address)
        );
        receivedAmountWei =
          balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
      } catch {
        return {
          hash,
          status: "success",
          amountOutMin,
          expectedOut,
          receivedAmountWei: 0n,
          accountingWarning:
            "买入已确认，但暂时无法读取实际到账量，请链上核对，未计入持仓",
        };
      }

      if (receivedAmountWei <= 0n) {
        return {
          hash,
          status: "success",
          amountOutMin,
          expectedOut,
          receivedAmountWei,
          accountingWarning:
            "买入已确认，但实际到账量无法确定，请通过链上核对，未计入持仓",
        };
      }
      return {
        hash,
        status: "success",
        amountOutMin,
        expectedOut,
        receivedAmountWei,
      };
    }

    return {
      hash,
      status: "failed",
      amountOutMin,
      expectedOut,
      receivedAmountWei,
      error: "交易已回滚",
    };
  } catch (error) {
    // 已广播但 receipt 无法确认 → unknown，保留 txHash；
    // 已确认 revert（CALL_EXCEPTION 且 receipt.status === 0）→ failed
    const status = hash
      ? isConfirmedRevert(error)
        ? "failed"
        : "unknown"
      : "failed";
    return {
      hash,
      status,
      amountOutMin,
      expectedOut,
      receivedAmountWei,
      error: safeErrorMessage(error),
    };
  }
}

export async function estimateBuyGasCost(
  wallet: SignerWallet,
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

  const provider = wallet.provider;
  if (!provider) {
    throw new Error("钱包未连接 Provider");
  }
  return BigInt(gasLimit) * (await getGasPrice(provider));
}

export interface SellParams {
  wallet: SignerWallet;
  tokenAddress: string;
  amountInWei: bigint;
  slippageBps: bigint;
  network: NetworkConfig;
  supportFeeOnTransfer: boolean;
}

export interface SellResult {
  status: SimpleTxStatus;
  phase?: "approval" | "swap";
  approvalHash?: string;
  swapHash?: string;
  amountOutMin: bigint;
  error?: string;
}

// 卖出 Swap 在 allowance 不足导致预检 revert 时使用的保守 Gas 预算上限。
// 仅是资金预算，不代表 Swap 业务一定可执行；Testnet 需按典型 FOT 代币实测校准。
const SELL_SWAP_GAS_FALLBACK_LIMIT = 1_500_000n;

export async function sellToken(params: SellParams): Promise<SellResult> {
  let approvalHash: string | undefined;
  let approvalConfirmed = false;
  let swapHash: string | undefined;
  let amountOutMin = 0n;

  try {
    await assertExpectedChain(params.wallet.provider!, params.network.chainId);

    const router = getRouter(params.network, params.wallet);
    const routerAddress = params.network.routerAddress!;
    const wbnb = await router.WETH();
    const path = [params.tokenAddress, wbnb];

    const token = new ethers.Contract(
      params.tokenAddress,
      ERC20_MIN_ABI,
      params.wallet
    );

    const balance = BigInt(await token.balanceOf(params.wallet.address));
    if (balance < params.amountInWei) {
      throw new Error("代币余额不足");
    }

    const allowance = BigInt(
      await token.allowance(params.wallet.address, routerAddress)
    );
    const needsApproval = allowance < params.amountInWei;

    // ---- 完整 Gas Preflight（广播任何交易前，避免先授权后才发现无法卖出）----
    const gasPrice = await getGasPrice(params.wallet.provider!);
    const deadline0 = Math.floor(Date.now() / 1000) + 600;

    let approvalGasCost = 0n;
    if (needsApproval) {
      const approveGas = await token.approve.estimateGas(
        routerAddress,
        params.amountInWei
      );
      approvalGasCost = BigInt(approveGas) * gasPrice;
    }

    // swap gas：allowance 不足时 estimateGas 会 revert，回退到保守预算上限；
    // 若 allowance 已充足仍 revert，说明 Swap 业务本身不可执行，必须 Fail Closed。
    let swapGasCost: bigint;
    try {
      const swapGas = params.supportFeeOnTransfer
        ? await router.swapExactTokensForETHSupportingFeeOnTransferTokens.estimateGas(
            params.amountInWei,
            1n,
            path,
            params.wallet.address,
            deadline0
          )
        : await router.swapExactTokensForETH.estimateGas(
            params.amountInWei,
            1n,
            path,
            params.wallet.address,
            deadline0
          );
      swapGasCost = BigInt(swapGas) * gasPrice;
    } catch (error) {
      if (!needsApproval) {
        // allowance 已充足仍 revert → 非 allowance 前置条件问题，禁止继续授权
        throw error;
      }
      // allowance 不足导致的预检 revert：仅作资金预算，不代表 Swap 一定可执行
      swapGasCost = SELL_SWAP_GAS_FALLBACK_LIMIT * gasPrice;
    }

    const nativeBalance0 = await params.wallet.provider!.getBalance(
      params.wallet.address
    );
    if (nativeBalance0 < approvalGasCost + swapGasCost) {
      throw new Error(
        `${params.network.nativeSymbol} 余额不足以完成授权 + 卖出（预估 Gas 不足）`
      );
    }

    // ---- 1. Approval phase ----
    if (needsApproval) {
      const approveTx = await token.approve(routerAddress, params.amountInWei);
      approvalHash = approveTx.hash;
      const approveReceipt = await approveTx.wait();

      if (approveReceipt?.status !== 1) {
        return {
          status: "failed",
          phase: "approval",
          approvalHash,
          amountOutMin,
          error: "授权交易失败",
        };
      }
      approvalConfirmed = true;
      // 授权确认后再次 Fail Closed Chain ID
      await assertExpectedChain(
        params.wallet.provider!,
        params.network.chainId
      );
    }

    // ---- 2. Swap phase ----
    const amounts = await router.getAmountsOut(params.amountInWei, path);
    const expectedOut = BigInt(amounts[1]);

    const BPS = 10_000n;
    amountOutMin = (expectedOut * (BPS - params.slippageBps)) / BPS;
    if (amountOutMin <= 0n) {
      throw new Error("滑点导致最小获得量为 0，请调整滑点");
    }

    const deadline = Math.floor(Date.now() / 1000) + 600;

    // Swap 前再次校验原生币余额（授权后余额已变化）
    const swapGas = params.supportFeeOnTransfer
      ? await router.swapExactTokensForETHSupportingFeeOnTransferTokens.estimateGas(
          params.amountInWei,
          amountOutMin,
          path,
          params.wallet.address,
          deadline
        )
      : await router.swapExactTokensForETH.estimateGas(
          params.amountInWei,
          amountOutMin,
          path,
          params.wallet.address,
          deadline
        );
    const swapGasCost2 = BigInt(swapGas) * gasPrice;
    const nativeBalance = await params.wallet.provider!.getBalance(
      params.wallet.address
    );
    if (nativeBalance < swapGasCost2) {
      throw new Error(`${params.network.nativeSymbol} 余额不足以支付卖出 Gas`);
    }

    const tx = params.supportFeeOnTransfer
      ? await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
          params.amountInWei,
          amountOutMin,
          path,
          params.wallet.address,
          deadline
        )
      : await router.swapExactTokensForETH(
          params.amountInWei,
          amountOutMin,
          path,
          params.wallet.address,
          deadline
        );

    swapHash = tx.hash;

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      return {
        status: "success",
        phase: "swap",
        approvalHash,
        swapHash,
        amountOutMin,
      };
    }

    return {
      status: "failed",
      phase: "swap",
      approvalHash,
      swapHash,
      amountOutMin,
      error: "交易已回滚",
    };
  } catch (error) {
    // 已广播但未确认：按阶段保留 txHash，返回 unknown，禁止盲目重发
    if (swapHash) {
      const status = isConfirmedRevert(error) ? "failed" : "unknown";
      return {
        status,
        phase: "swap",
        approvalHash,
        swapHash,
        amountOutMin,
        error: safeErrorMessage(error),
      };
    }
    // 授权已广播但 receipt 未确认
    if (approvalHash && !approvalConfirmed) {
      const status = isConfirmedRevert(error) ? "failed" : "unknown";
      return {
        status,
        phase: "approval",
        approvalHash,
        amountOutMin,
        error: safeErrorMessage(error),
      };
    }
    // 授权已确认（或无授权）但 Swap 尚未广播 → swap 前失败，保留真实错误
    return {
      status: "failed",
      phase: "swap",
      approvalHash,
      amountOutMin,
      error: safeErrorMessage(error),
    };
  }
}
