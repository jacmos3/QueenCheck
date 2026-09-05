<script>
  import { indexToAlgebraic, pieceSymbol } from '$lib/board.js';
  export let board = [];
  export let selected = null;
  export let disabled = false;
  export let flipped = false;
  export let lastFrom = null;
  export let lastTo = null;
  export let legalSquares = [];
  export let checkSquare = null;
  export let onselect = () => {};

  $: legal = new Set(legalSquares);
  $: order = Array.from({ length: 64 }, (_, visual) => (flipped ? 63 - visual : visual));

  function squareName(index) {
    const piece = Number(board[index]);
    const occupant = piece
      ? `${piece > 0 ? 'white' : 'black'} piece`
      : 'empty';
    return `${indexToAlgebraic(index)} ${occupant}`;
  }
</script>

<div class="board-wrap" class:flipped>
  <div class="chessboard" role="grid" aria-label={flipped ? 'Chess board, black at bottom' : 'Chess board, white at bottom'}>
    {#each order as index}
      <button
        type="button"
        role="gridcell"
        class:dark={(Math.floor(index / 8) + (index % 8)) % 2 === 1}
        class:selected={selected === index}
        class:last-from={lastFrom === index}
        class:last-to={lastTo === index}
        class:legal={legal.has(index)}
        class:check={checkSquare === index}
        aria-label={squareName(index)}
        aria-selected={selected === index}
        disabled={disabled}
        on:click={() => onselect(index)}
      >
        <span
          class="piece"
          class:white={Number(board[index]) > 0}
          class:black={Number(board[index]) < 0}
          aria-hidden="true"
        >{pieceSymbol(board[index])}</span>
        {#if legal.has(index) && !board[index]}<span class="legal-dot" aria-hidden="true"></span>{/if}
        <small>{indexToAlgebraic(index)}</small>
      </button>
    {/each}
  </div>
</div>
