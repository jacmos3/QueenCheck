import { createPublicClient, createWalletClient, custom, getAddress } from 'viem';
import { SUPPORTED_CHAINS, isSupportedChain } from './config.js';

export async function connectInjected() {
  const provider = globalThis.window?.ethereum;
  if (!provider) throw new Error('No EIP-1193 wallet found');
  const [rawAccount] = await provider.request({ method: 'eth_requestAccounts' });
  const chainId = Number(await provider.request({ method: 'eth_chainId' }));
  const [confirmedAccount] = await provider.request({ method: 'eth_accounts' });
  const confirmedChainId = Number(await provider.request({ method: 'eth_chainId' }));
  if (!confirmedAccount || getAddress(confirmedAccount) !== getAddress(rawAccount) || confirmedChainId !== chainId) {
    throw new Error('Wallet account or network changed while connecting. Try again.');
  }
  if (!isSupportedChain(chainId)) throw new Error('Switch to Base Sepolia (84532) or local chain (31337)');
  const chain = SUPPORTED_CHAINS[chainId];
  const transport = custom(provider);
  return { account: getAddress(rawAccount), chainId, chain, publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account: rawAccount, chain, transport }) };
}

export function randomSalt() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function waitForSuccessfulReceipt(publicClient, hash) {
  let disallowedReplacement = '';
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    onReplaced(replacement) {
      if (replacement.reason !== 'repriced') {
        disallowedReplacement = replacement.reason;
      }
    }
  });
  if (disallowedReplacement) {
    throw new Error(`Transaction was ${disallowedReplacement} before confirmation.`);
  }
  if (receipt.status !== 'success') throw new Error('Transaction reverted onchain.');
  return receipt;
}

export function sessionFingerprint(session) {
  if (!session) return '';
  return `${Number(session.chainId)}:${getAddress(session.account).toLowerCase()}`;
}

export function assertSessionCurrent(current, snapshot, generation, expectedGeneration) {
  if (!current || current !== snapshot || generation !== expectedGeneration || sessionFingerprint(current) !== sessionFingerprint(snapshot)) {
    throw new Error('Wallet account or network changed during the operation. Reconnect and try again.');
  }
}
