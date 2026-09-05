import { Chess } from 'chess.js';
import { algebraicToIndex, chessToSignedBoard, indexToAlgebraic, kingSquare } from './board.js';

export function createPracticeChess(fen) {
  return fen ? new Chess(fen) : new Chess();
}

export function isPromotionMove(chess, from, to) {
  const piece = chess.get(indexToAlgebraic(from));
  if (!piece || piece.type !== 'p') return false;
  const rank = indexToAlgebraic(to)[1];
  return rank === '8' || rank === '1';
}

export function practiceLegalSquares(chess, from) {
  if (!Number.isInteger(from) || from < 0 || from > 63) return [];
  return chess.moves({ square: indexToAlgebraic(from), verbose: true }).map((move) => algebraicToIndex(move.to));
}

export function playPracticeMove(chess, from, to, promotion = 'q') {
  const spec = { from: indexToAlgebraic(from), to: indexToAlgebraic(to) };
  if (isPromotionMove(chess, from, to)) spec.promotion = promotion;
  try {
    return chess.move(spec) ?? null;
  } catch {
    return null;
  }
}

export function practiceStatus(chess) {
  if (chess.isCheckmate()) return 'Checkmate';
  if (chess.isStalemate()) return 'Stalemate';
  if (chess.isDraw()) return 'Draw';
  const side = chess.turn() === 'w' ? 'White' : 'Black';
  return chess.inCheck() ? `${side} in check` : `${side} to move`;
}

export function practiceView(chess) {
  const board = chessToSignedBoard(chess);
  const history = chess.history({ verbose: true });
  const last = history.at(-1);
  return {
    board,
    moves: chess.history(),
    status: practiceStatus(chess),
    whiteToMove: chess.turn() === 'w',
    over: chess.isGameOver(),
    lastFrom: last ? algebraicToIndex(last.from) : null,
    lastTo: last ? algebraicToIndex(last.to) : null,
    checkSquare: chess.inCheck() ? kingSquare(board, chess.turn() === 'w') : null
  };
}

export function pairedSans(moves) {
  const rows = [];
  for (let index = 0; index < moves.length; index += 2) {
    rows.push({ n: index / 2 + 1, white: moves[index], black: moves[index + 1] ?? '' });
  }
  return rows;
}
