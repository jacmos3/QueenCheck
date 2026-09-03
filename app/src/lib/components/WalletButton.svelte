<script>
  import { onMount } from 'svelte';
  import { connectInjected } from '$lib/wallet.js';
  export let session = null;
  export let onconnect = () => {};
  export let ondisconnect = () => {};
  let error = '';
  let busy = false;
  let connectionGeneration = 0;

  function invalidateSession() {
    connectionGeneration += 1;
    busy = false;
    session = null;
    error = 'Wallet account or network changed. Reconnect to re-verify the session.';
    ondisconnect();
  }

  onMount(() => {
    const provider = globalThis.window?.ethereum;
    if (!provider?.on) return;
    provider.on('accountsChanged', invalidateSession);
    provider.on('chainChanged', invalidateSession);
    return () => {
      provider.removeListener?.('accountsChanged', invalidateSession);
      provider.removeListener?.('chainChanged', invalidateSession);
    };
  });

  async function connect() {
    const generation = ++connectionGeneration;
    busy = true; error = '';
    try {
      const connected = await connectInjected();
      if (generation !== connectionGeneration) throw new Error('Wallet changed while connecting. Try again.');
      session = connected; onconnect(session);
    }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Wallet connection failed'; }
    finally { if (generation === connectionGeneration) busy = false; }
  }
</script>

<div class="wallet-control">
  {#if session}
    <span class="wallet-pill" title={session.account}>{session.account.slice(0, 6)}…{session.account.slice(-4)} · {session.chain.name}</span>
  {:else}
    <button class="secondary" on:click={connect} disabled={busy}>{busy ? 'Connecting…' : 'Connect wallet'}</button>
  {/if}
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
</div>
