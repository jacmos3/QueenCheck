<script>
  import WalletButton from '$lib/components/WalletButton.svelte';
  import CreateGameForm from '$lib/components/CreateGameForm.svelte';
  let session = null;
</script>

<svelte:head><title>QueenCheck — verifiable chess</title></svelte:head>
<section class="hero">
  <div class="hero-copy">
    <span class="eyebrow">Live or checkpointed onchain</span>
    <h1>Chess with a history you can verify.</h1>
    <p class="lede">Play each move onchain, or sign moves offline and archive them in batches. Change mode during the match without changing the rules.</p>
    <div class="notice"><strong>Chess, not finance.</strong> QueenCheck has no token, prize, wagering, yield, or financial rights. Its optional match record is soulbound and burnable.</div>
    <WalletButton bind:session onconnect={(value) => session = value} />
  </div>
  <div class="hero-mark" aria-hidden="true">♛</div>
</section>

<section class="content-grid">
  {#if session}<CreateGameForm {session} />{:else}<div class="panel muted-panel"><h2>Connect to begin</h2><p>A wallet is used only to create, join and sign chess moves. QueenCheck never asks for or stores private keys.</p></div>{/if}
  <div class="panel"><span class="eyebrow">Two rhythms, one game</span><h2>Choose move by move</h2><ol><li><strong>Live:</strong> every move updates the onchain board and SVG immediately.</li><li><strong>Offline:</strong> each player signs their own moves; up to 16 are checkpointed together.</li><li><strong>Portable:</strong> export and import signed transcript JSON. There is no pretend peer-to-peer sync.</li></ol></div>
</section>
