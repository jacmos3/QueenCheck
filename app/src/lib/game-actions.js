import { encodeAbiParameters, getAddress, isAddress, keccak256, zeroAddress } from 'viem';

const MAX_UINT256 = (1n << 256n) - 1n;

export function matchRecordTokenId(chainId, game, account) {
  let normalizedChainId;
  try { normalizedChainId = BigInt(chainId); }
  catch { throw new Error('Invalid record chain'); }
  if (normalizedChainId < 0n || normalizedChainId > MAX_UINT256 || !isAddress(game) || !isAddress(account)) {
    throw new Error('Invalid record scope');
  }
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }],
    [normalizedChainId, getAddress(game), getAddress(account)]
  )));
}

export function canClaimMatchRecord(game, account) {
  if (!game || !isAddress(account) || !isAddress(game.white) || !isAddress(game.black)) return false;
  if (Number(game.status) === 0 || getAddress(game.black) === getAddress(zeroAddress)) return false;
  const claimant = getAddress(account);
  return claimant === getAddress(game.white) || claimant === getAddress(game.black);
}

export function matchRecordAvailability(game, account, claimed, owner) {
  const claimant = isAddress(account) ? getAddress(account) : '';
  const ownsRecord = Boolean(claimant && isAddress(owner) && getAddress(owner) === claimant);
  return {
    canClaim: !claimed && !ownsRecord && canClaimMatchRecord(game, account),
    canBurn: ownsRecord
  };
}
