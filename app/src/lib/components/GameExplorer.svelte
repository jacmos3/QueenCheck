<script>
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { getAddress, isAddress, zeroAddress } from 'viem';
  import { loadPublicGameDirectory } from '$lib/game-discovery.js';

  const filters = [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'Open' },
    { value: 'active', label: 'Playing' },
    { value: 'completed', label: 'Done' }
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

<section class="lobby-tables" id="matches" aria-labelledby="matches-heading" aria-busy={loading}>
  <div class="lobby-tables-bar">
    <h2 id="matches-heading">Tables</h2>
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
    <button class="ghost compact-action refresh-button" type="button" on:click={refresh} disabled={loading}>
      {loading ? 'Reading…' : 'Refresh'}
    </button>
  </div>

  {#if error}
    <div class="panel explorer-state" role="alert">
      <strong>Could not read the public tables.</strong>
      <p>{error}</p>
      <button class="secondary" type="button" on:click={refresh}>Try again</button>
    </div>
  {:else if loading && !games.length}
    <div class="table-rows" aria-label="Loading public matches">
      {#each Array(4) as _}<div class="table-row placeholder-card"></div>{/each}
    </div>
  {:else if !visibleGames.length}
    <div class="panel explorer-state">
      <strong>{games.length ? `No ${filters.find((item) => item.value === filter)?.label.toLowerCase()} tables in view.` : searchTruncated ? 'No matches in the recent indexed window.' : 'No confirmed tables yet.'}</strong>
      <p>{games.length ? 'Pick another filter or refresh.' : searchTruncated ? 'Older matches exist outside this bounded public-RPC search. Open one with its address.' : 'Open a table above to post the first public match.'}</p>
    </div>
  {:else}
    <ol class="table-rows">
      {#each visibleGames as game}
        <li>
          <a class="table-row" href={`/game/${game.address}`} aria-label={`Open game ${game.gameId}`}>
            <span class={`status-chip status-${game.group}`}>{game.statusLabel}</span>
            <span class="table-id">#{game.gameId}</span>
            <span class="table-players">
              <code title={game.white}>{shortAddress(game.white)}</code>
              <span class="versus">vs</span>
              <code title={game.hasBlackPlayer ? game.black : game.invited}>{opponent(game)}</code>
            </span>
            <span class="table-ply">{game.ply} ply</span>
          </a>
        </li>
      {/each}
    </ol>
    {#if hasMore}<p class="list-note">Latest {games.length} verified matches{searchTruncated ? '; older activity is outside this public-RPC window' : ''}.</p>{/if}
  {/if}

  <form class="table-lookup" on:submit|preventDefault={openGame} novalidate>
    <label class="sr-only" for="game-address">Game address</label>
    <input
      id="game-address"
      bind:value={gameAddress}
      inputmode="text"
      autocomplete="off"
      spellcheck="false"
      placeholder="Paste a game address"
      aria-describedby={addressError ? 'game-address-error' : undefined}
    />
    <button class="compact-action" type="submit">Sit</button>
    {#if addressError}<p class="form-error compact-message" id="game-address-error" role="alert">{addressError}</p>{/if}
  </form>
  {#if confirmedThrough}<p class="list-note">Confirmed through block {blockLabel(confirmedThrough)} · {totalCreated} created</p>{/if}
</section>
