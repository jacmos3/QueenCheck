import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

export const PUBLIC_CHAIN_ID = baseSepolia.id;
export const PUBLIC_RPC_ORIGIN = 'https://sepolia.base.org';

let publicClient;

export function getPublicClient() {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(PUBLIC_RPC_ORIGIN, {
        retryCount: 1,
        timeout: 12_000
      })
    });
  }
  return publicClient;
}

export function getPublicReadSession() {
  return {
    chainId: PUBLIC_CHAIN_ID,
    chain: baseSepolia,
    publicClient: getPublicClient()
  };
}
