import type { NetworkConfig, TokenConfig } from "../config/networks";
import type { SignerWallet, TransferRecipient, TransferResult } from "../types";
import { assertExpectedChain } from "../utils/chain";
import { isConfirmedRevert, safeErrorMessage } from "../utils/error";
import { sendTransfer } from "./token";

export async function runBatchTransfer(
  wallet: SignerWallet,
  token: TokenConfig,
  recipients: TransferRecipient[],
  network: NetworkConfig,
  onUpdate: (index: number, result: TransferResult) => void
): Promise<void> {
  // 资金执行层自校验：广播前再次核验实际 Chain ID（Fail Closed）
  try {
    await assertExpectedChain(wallet.provider!, network.chainId);
  } catch (error) {
    for (let i = 0; i < recipients.length; i++) {
      onUpdate(i, {
        address: recipients[i].address,
        amount: recipients[i].amountText,
        status: "failed",
        error: safeErrorMessage(error),
      });
    }
    return;
  }

  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];

    onUpdate(i, {
      address: recipient.address,
      amount: recipient.amountText,
      status: "processing",
    });

    let txHash: string | undefined;

    try {
      const tx = await sendTransfer(
        wallet,
        token,
        recipient.address,
        recipient.amountWei
      );

      txHash = tx.hash;

      onUpdate(i, {
        address: recipient.address,
        amount: recipient.amountText,
        status: "processing",
        txHash,
      });

      const receipt = await tx.wait();

      if (receipt?.status === 1) {
        onUpdate(i, {
          address: recipient.address,
          amount: recipient.amountText,
          status: "success",
          txHash,
        });
      } else {
        onUpdate(i, {
          address: recipient.address,
          amount: recipient.amountText,
          status: "failed",
          txHash,
          error: "交易已回滚",
        });
      }
    } catch (error) {
      // 已广播（取得 txHash）但 receipt 无法确认 → unknown，必须保留 txHash；
      // 若已确认 revert（CALL_EXCEPTION 且 receipt.status === 0）→ failed
      const status = txHash
        ? isConfirmedRevert(error)
          ? "failed"
          : "unknown"
        : "failed";
      onUpdate(i, {
        address: recipient.address,
        amount: recipient.amountText,
        status,
        txHash,
        error: safeErrorMessage(error),
      });
      // V0.1 不自动 Retry，继续下一笔
    }
  }
}
