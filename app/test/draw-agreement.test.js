import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrawAgreement, drawAgreementTypedData, parseDrawAgreementJson, withDrawSignature } from '../src/lib/draw-agreement.js';

const game = '0x1111111111111111111111111111111111111111';
const white = '0x2222222222222222222222222222222222222222';
const root = `0x${'11'.repeat(32)}`;
const state = { gameId: '7', rulesetId: `0x${'22'.repeat(32)}`, ply: 4, stateHash: `0x${'33'.repeat(32)}`, transcriptRoot: root };

test('draw typed data is bound to the exact game state', () => {
  const agreement = createDrawAgreement(84532, game, state);
  const typed = drawAgreementTypedData(84532, game, agreement);
  assert.equal(typed.primaryType, 'DrawAgreement');
  assert.deepEqual(typed.message, { ...state, gameId: 7n });
});

test('draw agreement parser rejects stale state and hostile fields', () => {
  const agreement = createDrawAgreement(84532, game, state);
  assert.throws(() => parseDrawAgreementJson(JSON.stringify({ ...agreement, extra: true })));
  assert.throws(() => parseDrawAgreementJson(JSON.stringify(agreement), { chainId: 84532, game, state: { ...state, ply: 5 } }), /ply/);
});

test('draw signatures are unique and strictly validated', () => {
  const agreement = createDrawAgreement(84532, game, state);
  const signed = withDrawSignature(agreement, white, `0x${'aa'.repeat(65)}`);
  const replaced = withDrawSignature(signed, white, `0x${'bb'.repeat(65)}`);
  assert.equal(replaced.signatures.length, 1);
  assert.match(replaced.signatures[0].signature, /^0xbb/);
});
