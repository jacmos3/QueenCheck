import test from 'node:test';
import assert from 'node:assert/strict';
import { moveAuthorizationTypes, moveTypedData, nextTranscriptRoot } from '../src/lib/eip712.js';

test('typed data is bound to QueenCheck, chain and game contract', () => {
  const game = '0x1111111111111111111111111111111111111111';
  const data = moveTypedData(84532, game, { ply: 4 });
  assert.deepEqual(data.domain, { name: 'QueenCheck', version: '1', chainId: 84532, verifyingContract: game });
  assert.equal(data.primaryType, 'MoveAuthorization');
  assert.deepEqual(moveAuthorizationTypes.MoveAuthorization.map((field) => field.name), ['gameId', 'rulesetId', 'ply', 'prevTranscriptRoot', 'fromSquare', 'toSquare', 'promotion']);
});

test('transcript root binds every signed move field and previous root', () => {
  const base = {
    gameId: 7n,
    rulesetId: `0x${'11'.repeat(32)}`,
    ply: 0,
    prevTranscriptRoot: `0x${'22'.repeat(32)}`,
    fromSquare: 52,
    toSquare: 36,
    promotion: 0
  };
  const root = nextTranscriptRoot(base);
  assert.match(root, /^0x[0-9a-f]{64}$/);
  assert.notEqual(nextTranscriptRoot({ ...base, toSquare: 44 }), root);
  assert.notEqual(nextTranscriptRoot({ ...base, prevTranscriptRoot: `0x${'33'.repeat(32)}` }), root);
});
