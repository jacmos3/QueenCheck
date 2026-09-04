import test from 'node:test';
import assert from 'node:assert/strict';
import { zeroAddress } from 'viem';
import { canClaimMatchRecord, matchRecordAvailability, matchRecordTokenId } from '../src/lib/game-actions.js';

const white = '0x1111111111111111111111111111111111111111';
const black = '0x2222222222222222222222222222222222222222';
const outsider = '0x3333333333333333333333333333333333333333';

test('record claim is available only to players in a joined game', () => {
  const active = { white, black, status: 1 };
  assert.equal(canClaimMatchRecord(active, white), true);
  assert.equal(canClaimMatchRecord(active, black), true);
  assert.equal(canClaimMatchRecord(active, outsider), false);
});

test('record claim is unavailable before join and after cancelling an unjoined game', () => {
  assert.equal(canClaimMatchRecord({ white, black: zeroAddress, status: 0 }, white), false);
  assert.equal(canClaimMatchRecord({ white, black: zeroAddress, status: 5 }, white), false);
});

test('record token id matches the contract abi.encode derivation', () => {
  assert.equal(
    matchRecordTokenId(84532, white, black),
    112174983027197662782552805045523113880783060926836573269992832746266722305997n
  );
  assert.throws(() => matchRecordTokenId(-1, white, black), /Invalid record scope/);
});

test('record actions distinguish unclaimed, owned, and burned records', () => {
  const active = { white, black, status: 1 };
  assert.deepEqual(matchRecordAvailability(active, white, false, ''), { canClaim: true, canBurn: false });
  assert.deepEqual(matchRecordAvailability(active, white, true, white), { canClaim: false, canBurn: true });
  assert.deepEqual(matchRecordAvailability(active, white, true, ''), { canClaim: false, canBurn: false });
  assert.deepEqual(matchRecordAvailability(active, black, true, white), { canClaim: false, canBurn: false });
});
