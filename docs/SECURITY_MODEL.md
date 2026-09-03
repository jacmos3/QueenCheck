# Security model

## Security objective

QueenCheck aims to make the published onchain result and board a deterministic consequence of player-authorized legal moves. It does not attempt to prove that a human, rather than chess software, chose those moves, and it does not secure offchain signatures that players lose before publication.

## Trust boundaries

- Wallets authorize transactions and EIP-712 messages. A compromised wallet can play or resign for its owner.
- The browser offers convenience validation, but the contracts enforce all chess and authorization rules.
- Relayers and RPC providers may censor, delay, reorder, or refuse requests; they cannot alter a valid signed move or bypass canonical state checks.
- Indexers reconstruct event history for convenience. Contract state and logs remain authoritative.
- The SVG renderer reads only a factory-registered game linked to a record token.

## Required protections

- EIP-712 domain separation by chain and clone address.
- Explicit game ID, ruleset, ply, and previous-transcript-root binding.
- EOA and ERC-1271 verification through `SignatureChecker`.
- Bounded, atomic checkpoint batches.
- Self-check rejection and one shared transition path for live and offline play.
- Terminal-state monotonicity and timeout grace.
- Deterministic factory registry checks before record minting.
- Soulbound transfer and approval rejection.
- No payable public API, withdrawal path, delegatecall extension, owner role, or upgrade hook.

## Known limitations

- A signature proves authorization, not the wall-clock time when it was produced.
- Offline signing checks authorization and history continuity; chess legality becomes final only when the contract executes the checkpoint.
- Unpublished offline transcripts can be lost or withheld. Export redundancy is a user responsibility until checkpointed.
- Public mempools reveal submitted moves. QueenCheck is not a private chess system.
- Onchain chess consumes gas; offline batching reduces transactions but does not make verification free.
- Smart-contract chess correctness remains a high-risk surface. Test coverage is not a substitute for an independent audit.
- Soulbound does not mean invisible: wallet addresses, games, and claimed records are public.
- Domain separation cannot distinguish an exceptional chain fork that preserves the same chain ID, clone address, and state. Canonical deployment and chain selection remain operational trust assumptions.
- `RULESET_ID` identifies the intended rules semantics, not an independently proven code hash. Release records must include and verify the deployed rules-engine address, bytecode, source, compiler, and lockfile.
- The Base Sepolia client accepts its trust root only from the committed deployment manifest. A release must fail if any exact source match, runtime code hash, immutable relationship, commit, or lockfile binding cannot be established.
- The 16-ply checkpoint fixture used 9,652,810 execution gas locally; tests enforce a 12,000,000-gas regression ceiling for that fixture. Pathological positions and target-network limits still require measurement, and smaller batches remain available.

## Release gates

Base Sepolia may be used only after tests, build, bytecode-size checks, ABI synchronization, dependency audit, and a focused contract review pass. Mainnet is intentionally absent and must remain blocked until all of the following exist:

1. an independent audit of the exact commit and deployed bytecode;
2. a legal review of product presentation, competitions, privacy, and record semantics;
3. a monitored testnet period with incident procedures;
4. reproducible deployment and source verification;
5. an explicit decision that does not silently add economic rights.
