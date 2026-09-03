import { getAddress, isAddress, isHex } from 'viem';
import { nextTranscriptRoot } from './eip712.js';

export const TRANSCRIPT_SCHEMA = 'queencheck.transcript/v1';
export const MAX_TRANSCRIPT_BYTES = 256 * 1024;
export const MAX_MOVES = 512;
const MAX_UINT256 = (1n << 256n) - 1n;
const uint = (value, max) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 && BigInt(value) <= BigInt(max);
const uint256String = (value) => typeof value === 'string' && /^\d{1,78}$/.test(value) && BigInt(value) <= MAX_UINT256;
const bytes32 = (value) => typeof value === 'string' && isHex(value, { strict: true }) && value.length === 66;
const promotion = (value) => uint(value, 5) && (Number(value) === 0 || Number(value) >= 2);

export function validateMoveAuthorization(move) {
  if (!move || typeof move !== 'object' || Array.isArray(move)) return false;
  const keys = ['gameId', 'rulesetId', 'ply', 'prevTranscriptRoot', 'fromSquare', 'toSquare', 'promotion', 'nextTranscriptRoot', 'signer', 'signature'];
  if (Object.keys(move).some((key) => !keys.includes(key))) return false;
  return uint256String(move.gameId) && bytes32(move.rulesetId) && uint(move.ply, 0xffffffff) &&
    bytes32(move.prevTranscriptRoot) && uint(move.fromSquare, 63) && uint(move.toSquare, 63) &&
    Number(move.fromSquare) !== Number(move.toSquare) && promotion(move.promotion) &&
    bytes32(move.nextTranscriptRoot) && isAddress(move.signer) && typeof move.signature === 'string' &&
    isHex(move.signature, { strict: true }) && move.signature.length >= 2 && move.signature.length <= 8194;
}

export function validateTranscript(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Transcript must be an object');
  const allowed = ['schema', 'chainId', 'game', 'moves'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Transcript contains unknown fields');
  if (value.schema !== TRANSCRIPT_SCHEMA || !uint(value.chainId, 0xffffffff) || !isAddress(value.game)) throw new Error('Invalid transcript header');
  if (expected.chainId && Number(value.chainId) !== Number(expected.chainId)) throw new Error('Transcript chain does not match');
  if (expected.game && getAddress(value.game) !== getAddress(expected.game)) throw new Error('Transcript game does not match');
  if (!Array.isArray(value.moves) || value.moves.length > MAX_MOVES || !value.moves.every(validateMoveAuthorization)) throw new Error('Invalid transcript moves');
  for (let index = 1; index < value.moves.length; index += 1) {
    const previous = value.moves[index - 1];
    const current = value.moves[index];
    if (
      Number(current.ply) !== Number(previous.ply) + 1 ||
      current.prevTranscriptRoot !== previous.nextTranscriptRoot ||
      current.gameId !== previous.gameId ||
      current.rulesetId !== previous.rulesetId
    ) throw new Error('Transcript chain is discontinuous');
  }
  return {
    schema: TRANSCRIPT_SCHEMA,
    chainId: Number(value.chainId),
    game: getAddress(value.game),
    moves: value.moves.map((move) => ({ ...move, signer: getAddress(move.signer) }))
  };
}

export function parseTranscriptJson(text, expected = {}) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_TRANSCRIPT_BYTES) throw new Error('Transcript exceeds size limit');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Transcript is not valid JSON'); }
  return validateTranscript(value, expected);
}

export function storageKey(chainId, game, account) {
  if (!uint(chainId, 0xffffffff) || !isAddress(game) || !isAddress(account)) throw new Error('Invalid storage scope');
  return `queencheck:v1:${Number(chainId)}:${getAddress(game).toLowerCase()}:${getAddress(account).toLowerCase()}`;
}

export function loadTranscript(storage, chainId, game, account) {
  const raw = storage.getItem(storageKey(chainId, game, account));
  if (!raw) return { schema: TRANSCRIPT_SCHEMA, chainId: Number(chainId), game: getAddress(game), moves: [] };
  return parseTranscriptJson(raw, { chainId, game });
}

export function saveTranscript(storage, transcript, account) {
  const valid = validateTranscript(transcript);
  const json = JSON.stringify(valid);
  if (new TextEncoder().encode(json).length > MAX_TRANSCRIPT_BYTES) throw new Error('Transcript exceeds size limit');
  storage.setItem(storageKey(valid.chainId, valid.game, account), json);
}

export function mergeTranscripts(current, incoming) {
  const first = validateTranscript(current);
  const second = validateTranscript(incoming, first);
  const byPly = new Map(first.moves.map((move) => [Number(move.ply), move]));
  for (const move of second.moves) {
    const existing = byPly.get(Number(move.ply));
    if (existing && JSON.stringify(existing) !== JSON.stringify(move)) throw new Error(`Conflicting move at ply ${move.ply}`);
    byPly.set(Number(move.ply), move);
  }
  return validateTranscript({ ...first, moves: [...byPly.values()].sort((a, b) => Number(a.ply) - Number(b.ply)) });
}

export function validateTranscriptContinuation(moves, current) {
  if (!Array.isArray(moves)) throw new Error('Transcript moves must be an array');
  let expectedPly = Number(current.ply);
  let expectedRoot = current.transcriptRoot;
  for (const move of moves) {
    if (move.gameId !== String(current.gameId) || move.rulesetId !== current.rulesetId) {
      throw new Error(`Transcript domain mismatch at ply ${move.ply}.`);
    }
    if (Number(move.ply) !== expectedPly || move.prevTranscriptRoot !== expectedRoot) {
      throw new Error(`Transcript does not continue from the current onchain state at ply ${move.ply}.`);
    }
    const message = {
      gameId: BigInt(move.gameId), rulesetId: move.rulesetId, ply: Number(move.ply),
      prevTranscriptRoot: move.prevTranscriptRoot, fromSquare: Number(move.fromSquare),
      toSquare: Number(move.toSquare), promotion: Number(move.promotion)
    };
    const computed = nextTranscriptRoot(message);
    if (move.nextTranscriptRoot !== computed) throw new Error(`Invalid transcript root at ply ${move.ply}.`);
    expectedPly += 1;
    expectedRoot = computed;
  }
  return expectedRoot;
}
