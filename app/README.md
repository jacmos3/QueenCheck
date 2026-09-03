# QueenCheck web client

Static SvelteKit client for `queencheck.com`. It has no application backend. Public discovery and spectator views use the fixed, unauthenticated Base Sepolia endpoint `https://sepolia.base.org`; wallet access is requested only for writes and EIP-712 signatures. Connected local development can also use chain `31337`; mainnet is intentionally unavailable.

## Configuration

Base Sepolia's factory address and discovery start block come only from the versioned, exact-source-verified manifest at `src/lib/deployments/base-sepolia.json`; an environment variable or URL parameter cannot silently replace either value. Before showing a public match or enabling a write, the client checks the RPC chain, hashes the live bytecode of the factory, implementation, rules engine, renderer, and record, and verifies every immutable relationship against that manifest. Public discovery reads only confirmed `GameCreated` logs from that factory, then rechecks registration, bytecode and immutable game identity before rendering a card. `.env.example` contains only the optional local-chain factory override. Never add a private key, mnemonic, RPC credential or other secret. The client stores only versioned public move authorizations and signatures in browser local storage, scoped by chain, game and account.

## Contract synchronization boundary

`src/lib/contracts/abi.generated.js` is generated from the final Hardhat artifacts by `npm run sync:abi`; `src/lib/contracts/abi.js` is the stable import boundary. CI rejects a stale generated ABI. In particular, the synchronized interface covers:

- `createGame` parameters and the indexed `GameCreated` event;
- game state getters and the flattened row-major board;
- `previewMoves`, used as a non-mutating contract preflight for the next checkpoint;
- the `MoveAuthorization` tuple and `checkpoint` signature array;
- lifecycle, draw-claim and timeout action names, signed draw agreements, and record `claim`.

Offline signatures chain directly through `prevTranscriptRoot`, so after the one-time onchain create/join bootstrap a complete game can be signed without RPC simulation. Before import, signing or checkpointing, the client enforces the exact onchain game/ruleset/ply/root continuation, recalculates every next root and verifies every existing EIP-712 signature (including ERC-1271 through the public client). It uses `previewMoves` to check each up-to-16-move publication chunk before sending it.

The signed-draw flow uses a separate strict JSON schema bound to the exact current game ID, ruleset, ply, state hash and transcript root. Both EOA and ERC-1271 signatures are verified before submission; any archived move invalidates a stale agreement.

## Local commands

With Node.js 22.13 or later, first run `npm ci` and `npm run compile` from the repository root so the deployment checker can compare fresh production artifacts with the live contracts. Then run `npm ci`, `npm test`, `npm run check`, and `npm run build` from `app/`. Dependencies are exactly pinned in both lockfiles.

For the `queencheck.semproxlab.it` Apache document root, run `npm run package:apache -- /absolute/output/path.zip` after a successful build. The command refuses to overwrite an existing archive, converts the static fallback into `index.html`, removes the provider-specific `_headers` file, and includes the reviewed `.htaccess` for HTTPS, SPA routing, caching, and response security headers. Its HTTPS redirect is deliberately pinned to `queencheck.semproxlab.it`; change and review that host before reusing the package for another domain.
