import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TRANSCRIPT_BYTES, mergeTranscripts, parseTranscriptJson, saveTranscript, storageKey, TRANSCRIPT_SCHEMA, validateTranscriptContinuation } from '../src/lib/transcript.js';
import { nextTranscriptRoot } from '../src/lib/eip712.js';

const game = '0x1111111111111111111111111111111111111111';
const player = '0x2222222222222222222222222222222222222222';
const h0 = `0x${'00'.repeat(32)}`; const h1 = `0x${'11'.repeat(32)}`; const h2 = `0x${'22'.repeat(32)}`;
const sig = `0x${'ab'.repeat(65)}`;
const move = (ply, prevTranscriptRoot, nextTranscriptRoot) => ({ gameId: '7', rulesetId: h0, ply, prevTranscriptRoot, fromSquare: 52, toSquare: 36, promotion: 0, nextTranscriptRoot, signer: player, signature: sig });
const transcript = (moves = []) => ({ schema: TRANSCRIPT_SCHEMA, chainId: 84532, game, moves });

test('valid transcript is parsed and scoped', () => {
  const parsed = parseTranscriptJson(JSON.stringify(transcript([move(0, h0, h1)])), { chainId: 84532, game });
  assert.equal(parsed.moves.length, 1); assert.match(storageKey(84532, game, player), /^queencheck:v1:84532:/);
});

test('malformed, hostile and oversized imports are rejected', () => {
  assert.throws(() => parseTranscriptJson('{')); assert.throws(() => parseTranscriptJson(JSON.stringify({ ...transcript(), __proto_payload: 'x' })));
  assert.throws(() => parseTranscriptJson(' '.repeat(MAX_TRANSCRIPT_BYTES + 1)));
  assert.throws(() => parseTranscriptJson(JSON.stringify(transcript([{ ...move(0, h0, h1), signature: '<script>alert(1)</script>' }]))));
});

test('invalid move domains and numeric bounds are rejected', () => {
  assert.throws(() => parseTranscriptJson(JSON.stringify(transcript([{ ...move(0, h0, h1), gameId: `${1n << 256n}` }]))));
  assert.throws(() => parseTranscriptJson(JSON.stringify(transcript([{ ...move(0, h0, h1), promotion: 1 }]))));
  assert.throws(() => parseTranscriptJson(JSON.stringify(transcript([{ ...move(0, h0, h1), fromSquare: 36, toSquare: 36 }]))));
});

test('discontinuous and conflicting histories are rejected', () => {
  assert.throws(() => parseTranscriptJson(JSON.stringify(transcript([move(0, h0, h1), move(2, h1, h2)]))));
  assert.throws(() => mergeTranscripts(transcript([move(0, h0, h1)]), transcript([{ ...move(0, h0, h2), toSquare: 44 }])));
});

test('storage contains only validated public transcript material', () => {
  const memory = new Map(); const storage = { setItem: (key, value) => memory.set(key, value) };
  saveTranscript(storage, transcript([move(0, h0, h1)]), player);
  assert.equal(memory.size, 1); assert.equal([...memory.values()][0].includes('privateKey'), false);
});

test('continuation is bound to exact onchain domain, ply and recalculated roots', () => {
  const base = move(4, h0, h1);
  const message = { gameId: 7n, rulesetId: h0, ply: 4, prevTranscriptRoot: h0, fromSquare: 52, toSquare: 36, promotion: 0 };
  const valid = { ...base, nextTranscriptRoot: nextTranscriptRoot(message) };
  const current = { gameId: '7', rulesetId: h0, ply: 4, transcriptRoot: h0 };
  assert.equal(validateTranscriptContinuation([valid], current), valid.nextTranscriptRoot);
  assert.throws(() => validateTranscriptContinuation([{ ...valid, gameId: '8' }], current), /domain/);
  assert.throws(() => validateTranscriptContinuation([{ ...valid, nextTranscriptRoot: h2 }], current), /root/);
});
