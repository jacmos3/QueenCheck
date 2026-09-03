<script>
  import GameClient from '$lib/components/GameClient.svelte';
  export let data;
</script>
<svelte:head><title>Game · QueenCheck</title></svelte:head>
{#key data.address}<GameClient address={data.address} />{/key}
