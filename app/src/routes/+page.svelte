<script>
  import WalletButton from '$lib/components/WalletButton.svelte';
  import CreateGameForm from '$lib/components/CreateGameForm.svelte';
  import GameExplorer from '$lib/components/GameExplorer.svelte';
  import ChessBoard from '$lib/components/ChessBoard.svelte';
  import { START_BOARD } from '$lib/board.js';
  let session = null;
</script>

<svelte:head>
  <title>QueenCheck — sit down to a verifiable game</title>
  <meta name="description" content="Play chess with a public, checkable history. Live moves or signed offline batches. No token, prize, or wager." />
  <meta property="og:title" content="QueenCheck — sit down to a verifiable game" />
  <meta property="og:description" content="Play chess with a public, checkable history. Live moves or signed offline batches. No token, prize, or wager." />
  <meta property="og:image" content="https://queencheck.com/og.png" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://queencheck.com/" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="QueenCheck — sit down to a verifiable game" />
  <meta name="twitter:description" content="Play chess with a public, checkable history. Live moves or signed offline batches. No token, prize, or wager." />
  <meta name="twitter:image" content="https://queencheck.com/og.png" />
</svelte:head>

<section class="hero">
  <div class="hero-copy">
    <span class="eyebrow">A table you can trust</span>
    <h1>Play the game. Keep the score forever.</h1>
    <p class="lede">QueenCheck is chess with a public scoresheet. Move live onchain, or sign a run of moves at the board and archive them later. Same rules either way.</p>
    <div class="hero-actions">
      <WalletButton bind:session onconnect={(value) => session = value} />
      <a class="button ghost" href="#matches">Watch a table</a>
    </div>
    <p class="notice"><strong>Chess, not finance.</strong> No token, prize, wager, or yield. The optional match record is soulbound and burnable.</p>
  </div>
  <div class="hero-stage">
    <img class="hero-photo" src="/hero.jpg" alt="" width="1280" height="720" />
    <div class="hero-board" aria-hidden="true">
      <ChessBoard board={START_BOARD} disabled={true} />
    </div>
  </div>
</section>

<section class="how" aria-labelledby="how-heading">
  <div class="section-heading">
    <div>
      <span class="eyebrow">How a sitting works</span>
      <h2 id="how-heading">Three beats. One position.</h2>
    </div>
  </div>
  <ol class="how-grid">
    <li>
      <span>1</span>
      <h3>Open or join a table</h3>
      <p>Create a challenge, name an opponent, or take an open seat. Spectators need no wallet.</p>
    </li>
    <li>
      <span>2</span>
      <h3>Move your way</h3>
      <p>Send a live move, or sign offline when it is your turn. Switch mid-game. The contract is the arbiter.</p>
    </li>
    <li>
      <span>3</span>
      <h3>The board does not forget</h3>
      <p>Every accepted ply updates the public position and SVG. Draw, resign, flag, or mate — the result stays put.</p>
    </li>
  </ol>
</section>

<GameExplorer />

<section class="content-grid" id="play">
  {#if session}
    <CreateGameForm {session} />
  {:else}
    <div class="panel muted-panel">
      <span class="eyebrow">Ready to sit?</span>
      <h2>Connect only when you want the move.</h2>
      <p>Browsing is free of wallet prompts. Connect to create a table, join, or sign. QueenCheck never asks for or stores keys.</p>
    </div>
  {/if}
  <div class="panel rhythm-panel">
    <span class="eyebrow">Two tempos</span>
    <h2>Live or signed, same chess.</h2>
    <ul>
      <li><strong>Live.</strong> You click, the chain moves, the record SVG follows.</li>
      <li><strong>Offline.</strong> You sign here; the other player imports the file. Archive up to 16 plies.</li>
      <li><strong>Honest files.</strong> Transcripts are JSON you keep. There is no hidden relay.</li>
    </ul>
  </div>
</section>
