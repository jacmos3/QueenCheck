import test from 'node:test';
import assert from 'node:assert/strict';
import { algebraicToIndex } from '../src/lib/board.js';
import {
  createPracticeChess,
  pairedSans,
  playPracticeMove,
  practiceLegalSquares,
  practiceStatus,
  practiceView
} from '../src/lib/practice.js';

test('practice e2-e4 updates the view and scoresheet', () => {
  const chess = createPracticeChess();
  assert.ok(practiceLegalSquares(chess, algebraicToIndex('e2')).includes(algebraicToIndex('e4')));
  assert.ok(playPracticeMove(chess, algebraicToIndex('e2'), algebraicToIndex('e4')));
  const view = practiceView(chess);
  assert.equal(view.moves.join(' '), 'e4');
  assert.equal(view.whiteToMove, false);
  assert.equal(view.status, 'Black to move');
  assert.equal(view.lastFrom, algebraicToIndex('e2'));
  assert.equal(view.lastTo, algebraicToIndex('e4'));
  assert.deepEqual(pairedSans(view.moves), [{ n: 1, white: 'e4', black: '' }]);
});

test('illegal practice moves are ignored', () => {
  const chess = createPracticeChess();
  assert.equal(playPracticeMove(chess, algebraicToIndex('e2'), algebraicToIndex('e5')), null);
  assert.equal(chess.fen().split(' ')[1], 'w');
});

test('practice reports mate after a short game', () => {
  const chess = createPracticeChess();
  for (const [from, to] of [['e2', 'e4'], ['e7', 'e5'], ['d1', 'h5'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['h5', 'f7']]) {
    assert.ok(playPracticeMove(chess, algebraicToIndex(from), algebraicToIndex(to)), `${from}${to}`);
  }
  const view = practiceView(chess);
  assert.equal(view.over, true);
  assert.equal(practiceStatus(chess), 'Checkmate');
  assert.ok(view.checkSquare != null);
});
