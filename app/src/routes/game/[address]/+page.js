import { error } from '@sveltejs/kit';
import { getAddress, isAddress } from 'viem';

export function load({ params }) {
  if (!isAddress(params.address)) error(400, 'Invalid game address');
  return { address: getAddress(params.address) };
}
