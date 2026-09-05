<script>
  import ChessBoard from './ChessBoard.svelte';
  import { indexToAlgebraic } from '$lib/board.js';
  import {
    createPracticeChess,
    playPracticeMove,
    practiceLegalSquares,
    practiceView
  } from '$lib/practice.js';

  export let moves = [];
  export let status = 'White to move';

  let chess = createPracticeChess();
  let view = practiceView(chess);
  let selected = null;
  let flipped = false;
  moves = view.moves;
  status = view.status;

  $: legalSquares = selected == null ? [] : practiceLegalSquares(chess, selected);

  function sync() {
    view = practiceView(chess);
    moves = view.moves;
    status = view.status;
    selected = null;
  }

  function onselect(index) {
    if (view.over) return;
    if (selected == null) {
      const piece = chess.get(indexToAlgebraic(index));
      if (piece && piece.color === chess.turn()) selected = index;
      return;
    }
    if (index === selected) { selected = null; return; }
    const piece = chess.get(indexToAlgebraic(index));
    if (piece && piece.color === chess.turn()) { selected = index; return; }
    if (playPracticeMove(chess, selected, index)) sync();
    else selected = null;
  }

  function undo() {
    chess.undo();
    sync();
  }

  function reset() {
    chess.reset();
    sync();
  }
</script>

<div class="table-column practice-table">
  <div class="player-row" class:to-move={!view.whiteToMove && !view.over}>
    <div class="who">
      <span>Black</span>
      <strong>Waiting</strong>
    </div>
    <div class="clock-chip" class:live={!view.whiteToMove && !view.over}>
      <span>∞</span>
      <small>{!view.whiteToMove && !view.over ? 'To move' : 'Ready'}</small>
    </div>
  </div>

  <ChessBoard
    board={view.board}
    {selected}
    {flipped}
    lastFrom={view.lastFrom}
    lastTo={view.lastTo}
    {legalSquares}
    checkSquare={view.checkSquare}
    disabled={view.over}
    {onselect}
  />

  <div class="player-row" class:to-move={view.whiteToMove && !view.over}>
    <div class="who">
      <span>White</span>
      <strong>Practice</strong>
    </div>
    <div class="clock-chip" class:live={view.whiteToMove && !view.over}>
      <span>∞</span>
      <small>{view.whiteToMove && !view.over ? 'To move' : 'Ready'}</small>
    </div>
  </div>

  <div class="table-tools">
    <p class="turn-copy">{status}. Local board — nothing is signed or sent.</p>
    <div class="button-row">
      <button class="ghost compact-action" type="button" on:click={undo} disabled={!moves.length}>Undo</button>
      <button class="ghost compact-action" type="button" on:click={reset} disabled={!moves.length && !view.over}>Reset</button>
      <button class="ghost compact-action" type="button" on:click={() => flipped = !flipped}>{flipped ? 'White at bottom' : 'Flip'}</button>
    </div>
  </div>
</div>
