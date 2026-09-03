# QueenCheck

QueenCheck is verifiable chess with an onchain match record. A game can move one turn at a time onchain, accumulate mutually signed moves offline, or switch between those two rhythms at any point. The same contract validates every move and maintains one canonical board, state hash, and transcript root.

The optional match record is a dynamic, soulbound NFT. Its fully onchain SVG follows the latest checkpoint: it changes after every live move, or after an offline batch is archived. It is opt-in, non-transferable, burnable by its holder, and carries no payment, prize, governance, redemption, or other economic right.

Project site: [queencheck.com](https://queencheck.com)

## Status

QueenCheck is pre-audit software intended for local development and Base Sepolia testing only. No mainnet network is configured. Do not use it to custody value or organize paid or prize-bearing play.

The previous economic protocol is frozen at Git tag `protocol-lab-v1.0.0` in the historical `ChessGameSolidity` repository. QueenCheck preserves that Git history for attribution and traceability, but its current tree removes the token, bonding, rewards, arbitration, governance, and wagering design.

## How play works

- **Live:** the player whose turn it is submits one move. The board, transcript root, and claimed match-record SVG update immediately.
- **Offline:** after the game has been created and accepted once onchain, each player can sign the same EIP-712 move authorization when it is their turn without further RPC access. Anyone can later relay up to 16 consecutive signed moves as one atomic checkpoint.
- **Mixed:** live and offline moves use the same state machine. A game can change rhythm whenever its local transcript starts from the current onchain state.

An offline game longer than one checkpoint is archived in consecutive chunks. Every accepted move is emitted in an event, so the complete transcript remains reconstructable; signatures are verified but not stored.

## Repository

- `contracts/` — chess state machine, deterministic factory, soulbound record, and onchain renderer
- `test/` — protocol, replay, chess, timeout, and record tests
- `ignition/` — reproducible deployment module
- `app/` — static SvelteKit client
- `app/src/lib/deployments/` — versioned public deployment evidence used by the client
- `docs/` — protocol, threat model, deployment, and legal-product boundaries

## Development

Requirements: Node.js `22.13+` (the repository pins `22.22.0`).

```bash
npm ci
npm run compile
npm test

npm --prefix app ci
npm --prefix app test
npm --prefix app run check
npm --prefix app run build
```

Use `npm run test:all` after both dependency sets are installed. Generated artifacts, deployment state, local environment files, and Hardhat keystore data are ignored.

## Deployment policy

Only Base Sepolia (`84532`) is configured. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). A mainnet release requires a new independent security audit, legal review, operational threat model, monitored testnet period, and explicit deployment decision.

## Documentation

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md)
- [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md)
- [`docs/LEGAL_BOUNDARY.md`](docs/LEGAL_BOUNDARY.md)
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- [`docs/LINEAGE.md`](docs/LINEAGE.md)

MIT licensed. No audit, warranty, regulatory certification, or promise of economic value is provided.
