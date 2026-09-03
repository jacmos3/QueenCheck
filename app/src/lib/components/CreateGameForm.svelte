<script>
  import { env } from '$env/dynamic/public';
  import { decodeEventLog, getAddress, isAddress, zeroAddress } from 'viem';
  import { assertTrustedDeployment } from '$lib/deployment.js';
  import { factoryAbi } from '$lib/contracts/abi.js';
  import { assertSessionCurrent, randomSalt, waitForSuccessfulReceipt } from '$lib/wallet.js';
  export let session;
  let opponent = '';
  let timeoutMinutes = 0;
  let busy = false;
  let error = '';
  let gameAddress = '';
  let sessionGeneration = 0;
  let previousSession = session;
  $: if (session !== previousSession) { previousSession = session; sessionGeneration += 1; }

  async function createGame() {
    error = ''; gameAddress = '';
    const snapshot = session;
    const generation = sessionGeneration;
    if (!snapshot) { error = 'Connect a wallet first.'; return; }
    if (opponent && !isAddress(opponent)) { error = 'Opponent address is invalid.'; return; }
    const minutes = Math.round(Number(timeoutMinutes));
    if (!Number.isFinite(minutes) || minutes < 0 || (minutes !== 0 && (minutes < 5 || minutes > 43200))) {
      error = 'Timeout must be disabled (0) or between 5 minutes and 30 days.';
      return;
    }
    busy = true;
    try {
      const { factory } = await assertTrustedDeployment(snapshot.publicClient, snapshot.chainId, env);
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      const hash = await snapshot.walletClient.writeContract({ address: factory, abi: factoryAbi, functionName: 'createGame', args: [opponent ? getAddress(opponent) : zeroAddress, randomSalt(), minutes * 60] });
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      const receipt = await waitForSuccessfulReceipt(snapshot.publicClient, hash);
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== getAddress(factory)) continue;
        try {
          const decoded = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
          if (decoded.eventName === 'GameCreated') gameAddress = decoded.args.game;
        } catch { /* unrelated log */ }
      }
      if (!gameAddress) error = 'Transaction confirmed, but the game address was not found in the receipt. Check the explorer.';
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) {
        error = cause && typeof cause === 'object' && typeof cause.shortMessage === 'string' ? cause.shortMessage : cause instanceof Error ? cause.message : 'Creation failed';
      }
    }
    finally {
      if (session === snapshot && sessionGeneration === generation) busy = false;
    }
  }

  async function copyAddress() { await navigator.clipboard.writeText(gameAddress); }
</script>

<form class="panel create-form" on:submit|preventDefault={createGame}>
  <div><span class="eyebrow">New match</span><h2>Create a verifiable game</h2></div>
  <label>Opponent address <small>optional — leave empty for an open challenge</small>
    <input bind:value={opponent} autocomplete="off" placeholder="0x…" />
  </label>
  <label>Turn timeout in minutes <small>0 disables the timeout</small>
    <input bind:value={timeoutMinutes} min="0" max="43200" step="1" type="number" />
  </label>
  <button disabled={busy}>{busy ? 'Creating…' : 'Create game'}</button>
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  {#if gameAddress}
    <div class="success"><strong>Game created</strong><code>{gameAddress}</code><div class="button-row"><a class="button" href={`/game/${gameAddress}`}>Open game</a><button class="ghost" type="button" on:click={copyAddress}>Copy address</button></div></div>
  {/if}
</form>
