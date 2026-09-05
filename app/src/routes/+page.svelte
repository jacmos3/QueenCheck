<script>
  import WalletButton from '$lib/components/WalletButton.svelte';
  import CreateGameForm from '$lib/components/CreateGameForm.svelte';
  import GameExplorer from '$lib/components/GameExplorer.svelte';
  import PracticeTable from '$lib/components/PracticeTable.svelte';
  import { pairedSans } from '$lib/practice.js';

  let session = null;
  let moves = [];
  let status = 'White to move';
  $: sheet = pairedSans(moves);
</script>

<svelte:head>
  <title>QueenCheck</title>
  <meta name="description" content="Play chess with a public, checkable history. Live moves or signed offline batches. No token, prize, or wager." />
  <meta property="og:title" content="QueenCheck" />
  <meta property="og:description" content="Play chess with a public, checkable history. Live moves or signed offline batches. No token, prize, or wager." />
  <meta property="og:image" content="https://queencheck.com/og.png" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://queencheck.com/" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="QueenCheck" />
  <meta name="twitter:description" content="Play chess with a public, checkable history. Live moves or signed offline batches. No token, prize, or wager." />
  <meta name="twitter:image" content="https://queencheck.com/og.png" />
</svelte:head>

<section class="play-shell" id="play">
  <PracticeTable bind:moves bind:status />

  <aside class="lobby-rail">
    <div class="scoresheet-card">
      <div class="scoresheet-head">
        <strong>{status}</strong>
        <small>{moves.length ? `${moves.length} ply` : 'Start a move'}</small>
      </div>
      {#if sheet.length}
        <ol class="scoresheet">
          {#each sheet as row}
            <li>
              <span class="n">{row.n}.</span>
              <span>{row.white}</span>
              <span>{row.black}</span>
            </li>
          {/each}
        </ol>
      {:else}
        <p class="turn-copy">Click a white pawn. Legal squares light up. This game is only on this page.</p>
      {/if}
    </div>

    <div class="panel compact table-card" id="open-table">
      <span class="eyebrow">Open a table</span>
      <WalletButton bind:session onconnect={(value) => session = value} />
      {#if session}
        <CreateGameForm {session} />
      {:else}
        <p>Connect to sit as White. Spectating never needs a wallet.</p>
        <a class="button ghost" href="#matches">Join a public table</a>
      {/if}
    </div>
    <p class="quiet-note">Onchain games use the same board. No token, prize, or wager.</p>
  </aside>
</section>

<GameExplorer />
