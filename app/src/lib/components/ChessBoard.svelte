<script>
  import { indexToAlgebraic, pieceSymbol } from '$lib/board.js';
  export let board = [];
  export let selected = null;
  export let disabled = false;
  export let onselect = () => {};
</script>

<div class="chessboard" role="grid" aria-label="Chess board">
  {#each board as piece, index}
    <button
      type="button"
      role="gridcell"
      class:dark={(Math.floor(index / 8) + index % 8) % 2 === 1}
      class:selected={selected === index}
      aria-label={`${indexToAlgebraic(index)}${piece ? ` ${Number(piece) > 0 ? 'white' : 'black'} piece` : ' empty'}`}
      aria-selected={selected === index}
      disabled={disabled}
      on:click={() => onselect(index)}
    ><span aria-hidden="true">{pieceSymbol(piece)}</span><small>{indexToAlgebraic(index)}</small></button>
  {/each}
</div>
