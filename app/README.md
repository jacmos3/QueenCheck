# QueenCheck web client

Static SvelteKit client for `queencheck.com`. It has no application backend: reads, writes and EIP-712 signatures go through the user's injected EIP-1193 wallet. Only Base Sepolia (`84532`) and a local development chain (`31337`) are accepted; mainnet is intentionally unavailable.

## Configuration

Base Sepolia's factory address comes only from the versioned, exact-source-verified manifest at `src/lib/deployments/base-sepolia.json`; an environment variable cannot silently replace it. Before enabling reads or writes, the client hashes the live bytecode of the factory, implementation, rules engine, renderer, and record, and verifies every immutable relationship against that manifest. `.env.example` contains only the optional local-chain override. Never add a private key, mnemonic, RPC credential or other secret. The client stores only versioned public move authorizations and signatures in browser local storage, scoped by chain, game and account.

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

With Node.js 22.13 or later: `npm install`, `npm test`, `npm run check`, then `npm run build`. Dependencies are exactly pinned in `package.json`; commit the generated lockfile after the integration install.
