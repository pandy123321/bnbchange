import type { NetworkConfig } from "../config/networks";

export function txExplorerUrl(network: NetworkConfig, txHash: string): string {
  return `${network.explorerBaseUrl}/tx/${txHash}`;
}

export function addressExplorerUrl(
  network: NetworkConfig,
  address: string
): string {
  return `${network.explorerBaseUrl}/address/${address}`;
}
