import { baseSepolia, foundry } from 'viem/chains';

export const SUPPORTED_CHAINS = Object.freeze({
  [baseSepolia.id]: baseSepolia,
  [foundry.id]: foundry
});
export const SUPPORTED_CHAIN_IDS = Object.freeze([baseSepolia.id, foundry.id]);

export function isSupportedChain(chainId) {
  return SUPPORTED_CHAIN_IDS.includes(Number(chainId));
}
