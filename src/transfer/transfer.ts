import { ethers } from "ethers";
import type { TransferRecipient, TransferResult } from "../types";
import { assertExpectedChain } from "../utils/chain";
import { safeErrorMessage } from "../utils/error";

export async function runBatchTransfer(
  wallet: ethers.Wallet,
  recipients: TransferRecipient[],
  expectedChainId: number,
  onUpdate: (index: number, result: TransferResult) => void
): Promise<void> {
  // 资金执行层自校验：广播前再次核验实际 Chain ID（Fail Closed）
  try {
    await assertExpectedChain(wallet.provider!, expectedChainId);
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
      const tx = await wallet.sendTransaction({
        to: recipient.address,
        value: recipient.amountWei,
      });

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
          error: "Transaction reverted",
        });
      }
    } catch (error) {
      // 已广播（取得 txHash）但 receipt 无法确认 → unknown，必须保留 txHash
      onUpdate(i, {
        address: recipient.address,
        amount: recipient.amountText,
        status: txHash ? "unknown" : "failed",
        txHash,
        error: safeErrorMessage(error),
      });
      // V0.1 不自动 Retry，继续下一笔
    }
  }
}
