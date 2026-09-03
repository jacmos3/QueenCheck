<script>
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { getAddress, isAddress, zeroAddress } from 'viem';
  import { loadPublicGameDirectory } from '$lib/game-discovery.js';

  const filters = [
    { value: 'all', label: 'Recent' },
    { value: 'open', label: 'Open' },
    { value: 'active', label: 'In progress' },
    { value: 'completed', label: 'Completed' }
  ];

  let games = [];
  let totalCreated = '0';
  let confirmedThrough = '';
  let hasMore = false;
  let searchTruncated = false;
  let filter = 'all';
  let loading = true;
  let error = '';
  let gameAddress = '';
  let addressError = '';
  let requestGeneration = 0;

  $: visibleGames = filter === 'all' ? games : games.filter((game) => game.group === filter);
  $: counts = {
    all: games.length,
    open: games.filter((game) => game.group === 'open').length,
    active: games.filter((game) => game.group === 'active').length,
    completed: games.filter((game) => game.group === 'completed').length
  };

  onMount(() => {
    void refresh(false);
    return () => { requestGeneration += 1; };
  });

  function friendly(cause) {
    if (!cause || typeof cause !== 'object') return 'Public match data is temporarily unavailable.';
    if (typeof cause.shortMessage === 'string') return cause.shortMessage;
    return cause instanceof Error ? cause.message : 'Public match data is temporarily unavailable.';
  }

  async function refresh(force = true) {
    const generation = ++requestGeneration;
    loading = true;
    error = '';
    try {
      const result = await loadPublicGameDirectory({ force });
      if (generation !== requestGeneration) return;
      games = result.games;
      totalCreated = result.totalCreated;
      confirmedThrough = result.confirmedThrough;
      hasMore = result.hasMore;
      searchTruncated = result.searchTruncated;
    } catch (cause) {
      if (generation === requestGeneration) error = friendly(cause);
    } finally {
      if (generation === requestGeneration) loading = false;
    }
  }

  function openGame() {
    addressError = '';
    const candidate = gameAddress.trim();
    if (!isAddress(candidate)) {
      addressError = 'Enter a valid game contract address.';
      return;
    }
    void goto(`/game/${getAddress(candidate)}`);
  }

  function shortAddress(address) {
    if (!address || address === zeroAddress) return 'Open seat';
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  function opponent(game) {
    if (game.hasBlackPlayer) return shortAddress(game.black);
    if (game.invited !== zeroAddress) return `Invited ${shortAddress(game.invited)}`;
    return 'Open seat';
  }

  function blockLabel(block) {
    const numeric = Number(block);
    return Number.isSafeInteger(numeric) ? numeric.toLocaleString('en-US') : block;
  }
</script>

<section class="match-explorer" id="matches" aria-labelledby="matches-heading" aria-busy={loading}>
  <div class="section-heading">
    <div>
      <span class="eyebrow">Public onchain activity</span>
      <h2 id="matches-heading">Watch before you connect.</h2>
      <p>Browse confirmed Base Sepolia matches in read-only mode. A wallet is requested only when you choose to play or sign.</p>
    </div>
    <button class="secondary refresh-button" type="button" on:click={refresh} disabled={loading}>
      {loading ? 'Reading chain…' : 'Refresh'}
    </button>
  </div>

  <div class="activity-summary" aria-label="Match activity summary">
    <div><strong>{totalCreated}</strong><span>Total created</span></div>
    <div><strong>{counts.open}</strong><span>Open in view</span></div>
    <div><strong>{counts.active}</strong><span>Playing now</span></div>
    <div><strong>{counts.completed}</strong><span>Completed in view</span></div>
  </div>

  <form class="game-lookup" on:submit|preventDefault={openGame} novalidate>
    <label for="game-address">Already have a game address?</label>
    <div class="lookup-row">
      <input
        id="game-address"
        bind:value={gameAddress}
        inputmode="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="0x…"
        aria-describedby={addressError ? 'game-address-error' : undefined}
      />
      <button type="submit">Open spectator view</button>
    </div>
    {#if addressError}<p class="form-error compact-message" id="game-address-error" role="alert">{addressError}</p>{/if}
  </form>

  <div class="match-toolbar">
    <div class="match-filters" aria-label="Filter public matches">
      {#each filters as item}
        <button
          type="button"
          class:active={filter === item.value}
          aria-pressed={filter === item.value}
          on:click={() => filter = item.value}
        >{item.label}<span>{counts[item.value]}</span></button>
      {/each}
    </div>
    {#if confirmedThrough}<small>Confirmed through block {blockLabel(confirmedThrough)}</small>{/if}
  </div>

  {#if error}
    <div class="panel explorer-state" role="alert">
      <strong>Could not read the public match list.</strong>
      <p>{error}</p>
      <button class="secondary" type="button" on:click={refresh}>Try again</button>
    </div>
  {:else if loading && !games.length}
    <div class="match-loading" aria-label="Loading public matches">
      {#each Array(3) as _}<div class="match-card placeholder-card"></div>{/each}
    </div>
  {:else if !visibleGames.length}
    <div class="panel explorer-state">
      <strong>{games.length ? `No ${filters.find((item) => item.value === filter)?.label.toLowerCase()} matches in the current view.` : searchTruncated ? 'No matches found in the recent indexed window.' : 'No confirmed matches yet.'}</strong>
      <p>{games.length ? 'Choose another filter or refresh the onchain snapshot.' : searchTruncated ? 'Older matches exist but are outside this bounded public-RPC search. Open one directly with its game address.' : 'Connect a wallet below to create the first public QueenCheck match.'}</p>
    </div>
  {:else}
    <div class="match-list">
      {#each visibleGames as game}
        <a class="match-card" href={`/game/${game.address}`} aria-label={`Open game ${game.gameId} in spectator mode`}>
          <div class="match-card-top">
            <span class={`status-chip status-${game.group}`}>{game.statusLabel}</span>
            <strong>Game #{game.gameId}</strong>
          </div>
          <div class="match-players">
            <span><small>White</small><code title={game.white}>{shortAddress(game.white)}</code></span>
            <span class="versus">vs</span>
            <span><small>Black</small><code title={game.hasBlackPlayer ? game.black : game.invited}>{opponent(game)}</code></span>
          </div>
          <div class="match-meta"><span>{game.ply} {game.ply === 1 ? 'ply' : 'plies'}</span><span>Created at block {blockLabel(game.createdBlock)}</span><span>View board →</span></div>
        </a>
      {/each}
    </div>
    {#if hasMore}<p class="list-note">Showing the latest {games.length} verified matches. {searchTruncated ? 'Older activity is outside this bounded public-RPC search.' : 'New and older matches may not be in this snapshot.'}</p>{/if}
  {/if}
</section>
