<script>
  import WalletButton from '$lib/components/WalletButton.svelte';
  import CreateGameForm from '$lib/components/CreateGameForm.svelte';
  import GameExplorer from '$lib/components/GameExplorer.svelte';
  let session = null;
</script>

<svelte:head>
  <title>QueenCheck — verifiable chess</title>
  <meta name="description" content="Watch and play verifiable chess, live or checkpointed onchain." />
  <meta property="og:title" content="QueenCheck — verifiable chess" />
  <meta property="og:description" content="Watch and play verifiable chess, live or checkpointed onchain." />
  <meta property="og:image" content="https://queencheck.com/og.png" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://queencheck.com/" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="QueenCheck — verifiable chess" />
  <meta name="twitter:description" content="Watch and play verifiable chess, live or checkpointed onchain." />
  <meta name="twitter:image" content="https://queencheck.com/og.png" />
</svelte:head>
<section class="hero">
  <div class="hero-copy">
    <span class="eyebrow">Live or checkpointed onchain</span>
    <h1>Chess with a history you can verify.</h1>
    <p class="lede">Play each move onchain, or sign moves offline and archive them in batches. Change mode during the match without changing the rules.</p>
    <div class="notice"><strong>Chess, not finance.</strong> QueenCheck has no token, prize, wagering, yield, or financial rights. Its optional match record is soulbound and burnable.</div>
    <div class="hero-actions"><WalletButton bind:session onconnect={(value) => session = value} /><a class="button ghost" href="#matches">Browse public matches</a></div>
  </div>
  <div class="hero-mark" aria-hidden="true">♛</div>
</section>

<GameExplorer />

<section class="content-grid" id="play">
  {#if session}<CreateGameForm {session} />{:else}<div class="panel muted-panel"><span class="eyebrow">Ready to play?</span><h2>Connect only when you want to act.</h2><p>Browsing and spectating need no wallet. Connect above to create, join and sign chess moves; QueenCheck never asks for or stores private keys.</p></div>{/if}
  <div class="panel"><span class="eyebrow">Two rhythms, one game</span><h2>Choose move by move</h2><ol><li><strong>Live:</strong> every move updates the onchain board and SVG immediately.</li><li><strong>Offline:</strong> each player signs their own moves; up to 16 are checkpointed together.</li><li><strong>Portable:</strong> export and import signed transcript JSON. There is no pretend peer-to-peer sync.</li></ol></div>
</section>
