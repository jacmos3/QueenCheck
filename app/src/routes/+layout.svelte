<script>
  import '../app.css';
</script>

<header class="site-header">
  <a class="brand" href="/" aria-label="QueenCheck home"><span>♛</span> QueenCheck</a>
  <nav class="site-nav" aria-label="Primary">
    <a href="/#matches">Tables</a>
    <a href="/#play">Sit down</a>
    <span class="domain">Base Sepolia</span>
  </nav>
</header>
<main><slot /></main>
<footer>
  <strong>QueenCheck</strong>
  <span>Verified chess · no token, prize, or wager · testnet only</span>
</footer>
