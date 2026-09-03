export const EMPTY_BOARD = Object.freeze(Array(64).fill(0));
const symbols = Object.freeze({ 1: '♙', 2: '♘', 3: '♗', 4: '♖', 5: '♕', 6: '♔', '-1': '♟', '-2': '♞', '-3': '♝', '-4': '♜', '-5': '♛', '-6': '♚' });
const fenPieces = Object.freeze({ 1: 'P', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K', '-1': 'p', '-2': 'n', '-3': 'b', '-4': 'r', '-5': 'q', '-6': 'k' });

export function squareIndex(row, col) {
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 7 || col < 0 || col > 7) throw new RangeError('Invalid board coordinate');
  return row * 8 + col;
}

export function indexToAlgebraic(index) {
  if (!Number.isInteger(index) || index < 0 || index > 63) throw new RangeError('Invalid square index');
  const row = Math.floor(index / 8);
  const col = index % 8;
  return `${String.fromCharCode(97 + col)}${8 - row}`;
}

export function pieceSymbol(piece) { return symbols[String(Number(piece))] ?? ''; }

export function boardToFen(board, options = {}) {
  if (!Array.isArray(board) || board.length !== 64) throw new TypeError('Board must contain 64 squares');
  const normalized = typeof options === 'boolean' ? { whiteToMove: options } : options;
  const whiteToMove = normalized.whiteToMove ?? true;
  const ranks = [];
  for (let row = 0; row < 8; row += 1) {
    let empty = 0;
    let rank = '';
    for (let col = 0; col < 8; col += 1) {
      const piece = Number(board[squareIndex(row, col)]);
      const token = fenPieces[String(piece)];
      if (!token && piece !== 0) throw new TypeError('Board contains an unsupported piece');
      if (!token) empty += 1;
      else { if (empty) rank += empty; empty = 0; rank += token; }
    }
    if (empty) rank += empty;
    ranks.push(rank);
  }
  const flags = Number(normalized.castlingFlags ?? 63);
  let castling = '';
  if (!(flags & 1) && !(flags & 4) && Number(board[60]) === 6 && Number(board[63]) === 4) castling += 'K';
  if (!(flags & 1) && !(flags & 2) && Number(board[60]) === 6 && Number(board[56]) === 4) castling += 'Q';
  if (!(flags & 8) && !(flags & 16) && Number(board[4]) === -6 && Number(board[7]) === -4) castling += 'k';
  if (!(flags & 8) && !(flags & 32) && Number(board[4]) === -6 && Number(board[0]) === -4) castling += 'q';
  if (!castling) castling = '-';

  let enPassant = '-';
  const enPassantCol = Number(normalized.enPassantCol ?? -1);
  const enPassantRow = Number(normalized.enPassantRow ?? 0);
  if (Number.isInteger(enPassantCol) && enPassantCol >= 0 && enPassantCol < 8) {
    const targetRow = whiteToMove ? enPassantRow - 1 : enPassantRow + 1;
    if (targetRow >= 0 && targetRow < 8) enPassant = indexToAlgebraic(squareIndex(targetRow, enPassantCol));
  }
  const halfmoveClock = Number.isInteger(Number(normalized.halfmoveClock)) && Number(normalized.halfmoveClock) >= 0 ? Number(normalized.halfmoveClock) : 0;
  const ply = Number.isInteger(Number(normalized.ply)) && Number(normalized.ply) >= 0 ? Number(normalized.ply) : 0;
  return `${ranks.join('/')} ${whiteToMove ? 'w' : 'b'} ${castling} ${enPassant} ${halfmoveClock} ${Math.floor(ply / 2) + 1}`;
}

export function chessToSignedBoard(chess) {
  const values = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
  return chess.board().flat().map((piece) => piece ? values[piece.type] * (piece.color === 'w' ? 1 : -1) : 0);
}
