import test from 'node:test';
import assert from 'node:assert/strict';
import { boardToFen, indexToAlgebraic, squareIndex } from '../src/lib/board.js';

test('contract board mapping is row-major', () => {
  assert.equal(squareIndex(0, 0), 0); assert.equal(squareIndex(7, 7), 63);
  assert.equal(indexToAlgebraic(0), 'a8'); assert.equal(indexToAlgebraic(63), 'h1');
});

test('signed pieces convert to a chess.js compatible FEN', () => {
  const board = Array(64).fill(0); board[0] = -4; board[4] = -6; board[60] = 6; board[63] = 4;
  assert.equal(boardToFen(board, false), 'r3k3/8/8/8/8/8/8/4K2R b - - 0 1');
});

test('invalid board indexes and lengths are rejected', () => {
  assert.throws(() => squareIndex(-1, 0)); assert.throws(() => indexToAlgebraic(64)); assert.throws(() => boardToFen([]));
  const board = Array(64).fill(0); board[0] = 99;
  assert.throws(() => boardToFen(board));
});

test('FEN preserves castling, en-passant and counters from the contract', () => {
  const board = Array(64).fill(0);
  board[0] = -4; board[4] = -6; board[7] = -4;
  board[36] = 1; board[56] = 4; board[60] = 6; board[63] = 4;
  assert.equal(
    boardToFen(board, { whiteToMove: false, castlingFlags: 0, enPassantCol: 4, enPassantRow: 4, halfmoveClock: 0, ply: 1 }),
    'r3k2r/8/8/8/4P3/8/8/R3K2R b KQkq e3 0 1'
  );
});
