import { ethers } from "ethers";

export async function assertExpectedChain(
  provider: ethers.Provider,
  expectedChainId: number
): Promise<void> {
  const actual = await provider.getNetwork();
  if (Number(actual.chainId) !== expectedChainId) {
    throw new Error(
      `RPC 网络不一致：期望 ${expectedChainId}，实际 ${Number(actual.chainId)}`
    );
  }
}
