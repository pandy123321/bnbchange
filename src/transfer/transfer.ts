import { ethers } from "ethers";
import type { TransferRecipient, TransferResult } from "../types";
import { safeErrorMessage } from "../utils/error";

export async function runBatchTransfer(
  wallet: ethers.Wallet,
  recipients: TransferRecipient[],
  onUpdate: (index: number, result: TransferResult) => void
): Promise<void> {
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];

    onUpdate(i, {
      address: recipient.address,
      amount: recipient.amountText,
      status: "processing",
    });

    try {
      const tx = await wallet.sendTransaction({
        to: recipient.address,
        value: recipient.amountWei,
      });

      onUpdate(i, {
        address: recipient.address,
        amount: recipient.amountText,
        status: "processing",
        txHash: tx.hash,
      });

      const receipt = await tx.wait();

      if (receipt?.status === 1) {
        onUpdate(i, {
          address: recipient.address,
          amount: recipient.amountText,
          status: "success",
          txHash: tx.hash,
        });
      } else {
        onUpdate(i, {
          address: recipient.address,
          amount: recipient.amountText,
          status: "failed",
          txHash: tx.hash,
          error: "Transaction reverted",
        });
      }
    } catch (error) {
      onUpdate(i, {
        address: recipient.address,
        amount: recipient.amountText,
        status: "failed",
        error: safeErrorMessage(error),
      });
      // V0.1 不自动 Retry，继续下一笔
    }
  }
}
