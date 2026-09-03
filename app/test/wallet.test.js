import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSessionCurrent, waitForSuccessfulReceipt } from '../src/lib/wallet.js';

test('receipt helper accepts successful confirmations and repricing', async () => {
  const receipt = { status: 'success' };
  const client = { waitForTransactionReceipt: async ({ onReplaced }) => { onReplaced({ reason: 'repriced' }); return receipt; } };
  assert.equal(await waitForSuccessfulReceipt(client, '0x01'), receipt);
});

test('receipt helper rejects cancellation, replacement and reverts', async () => {
  for (const reason of ['cancelled', 'replaced']) {
    const client = { waitForTransactionReceipt: async ({ onReplaced }) => { onReplaced({ reason }); return { status: 'success' }; } };
    await assert.rejects(waitForSuccessfulReceipt(client, '0x01'), new RegExp(reason));
  }
  await assert.rejects(waitForSuccessfulReceipt({ waitForTransactionReceipt: async () => ({ status: 'reverted' }) }, '0x01'), /reverted/);
});

test('session guard detects generation and identity changes', () => {
  const session = { chainId: 84532, account: '0x1111111111111111111111111111111111111111' };
  assert.doesNotThrow(() => assertSessionCurrent(session, session, 2, 2));
  assert.throws(() => assertSessionCurrent(session, session, 3, 2), /changed/);
  assert.throws(() => assertSessionCurrent({ ...session }, session, 2, 2), /changed/);
});
