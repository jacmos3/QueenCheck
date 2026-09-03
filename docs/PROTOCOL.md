# QueenCheck protocol

## Purpose

QueenCheck records and verifies standard chess without introducing an economic protocol. The contracts do not issue fungible tokens, accept stakes, hold prizes, charge protocol fees, resolve wagers, or grant governance rights.

## Components

- `ChessRulesEngine` evaluates chess legality, check, checkmate, and stalemate.
- `QueenCheckGame` owns the canonical board and applies live or signed moves through the same transition function.
- `QueenCheckFactory` creates deterministic minimal-proxy games and is the canonical game registry.
- `QueenCheckRecord` lets either participant opt into one soulbound match record per game.
- `QueenCheckRenderer` derives JSON and SVG entirely from current game state.

All implementation, registry, rules, record, and renderer relationships are fixed at deployment. The protocol has no upgrade proxy, owner setter, emergency withdrawal, or privileged game mutation.

## Game lifecycle

1. White creates an open challenge or names an invited opponent, with an optional turn duration.
2. The invited opponent (or the first eligible player for an open challenge) explicitly joins. Until that consent, no move, timeout result, or record is possible.
3. On acceptance, the initial board, state hash, transcript root, and first deadline are fixed.
4. Moves are applied by either `play` or `checkpoint`.
5. Checkmate, stalemate, draw rules, agreement, resignation, or a finalized timeout makes the result terminal.
6. Either participant may claim and later burn their own soulbound record.

## Live and offline moves

Both paths use the same canonical move fields: immutable game and ruleset identifiers, exact expected ply, previous transcript root, source and destination squares (`0..63`, row-major), and promotion choice. A direct move derives those fields onchain; an offline move signs them as `MoveAuthorization`.

`play` accepts exactly one move from the current player's transaction sender. `checkpoint` accepts between 1 and 16 moves and a matching EIP-712 signature for each expected player. Checkpoint submission is permissionless; authorization comes from the signatures, not the relayer.

The EIP-712 domain binds name `QueenCheck`, version `1`, chain ID, and the individual game contract. The struct additionally binds the game ID, ruleset ID, ply, and previous transcript root. A signature therefore cannot be replayed in another game, clone, chain, ruleset, ply, or history branch.

Each batch is atomic. If one signature or chess transition fails, no earlier move in that transaction remains applied. A terminal result stops further moves. Every accepted move updates `stateHash` and the chained `transcriptRoot`, and emits its move fields plus the resulting commitments. The transcript root is `keccak256(abi.encode(previousRoot, moveStructHash))`, identically for live and signed play.

## Offline data availability

Before a checkpoint, signed moves exist only with the players. Each client must retain or export the versioned transcript. QueenCheck does not pretend that local signatures are already archived, and it does not depend on a proprietary relay. Because the signature chain uses transcript roots rather than future storage hashes, all gameplay after the initial onchain create/join bootstrap can be signed without RPC access and later submitted in ordered chunks of at most 16 moves. Creating and accepting the game first is necessary to bind signatures to its chain, clone address, game ID, players, and initial root.

## Draws and timeouts

The game supports stalemate, participant-agreed draw, repetition, the claimable 50-move rule, and the automatic 75-move rule. Only the player having the move may claim threefold repetition or the 50-move rule. An EIP-712 draw agreement can be relayed by anyone when both participants sign the same current state.

Timed games use a two-stage timeout. After the move deadline, the opponent signals a claim; a grace period allows the expected player to publish a valid continuation before finalization. At the exact end of the grace period, the game freezes and only permissionless timeout finalization remains available, so mempool ordering cannot substitute another result after the cutoff. Signatures cannot prove when they were created, so this mechanism is a liveness compromise, not a trusted timestamp service. Untimed games avoid that tradeoff.

## Match record

Claiming is voluntary and restricted to registered game participants. The ERC-721 record implements the ERC-5192 locked signal, rejects transfers and approvals, and permits the holder to burn. Metadata is derived from the registered game and confers no rights outside that record.

The SVG changes whenever the canonical board changes. A live move is one checkpoint in practice; an offline sequence changes the SVG when its next batch reaches the chain.

## Protocol invariants

- Only the expected player can authorize the next legal move.
- `ply`, `stateHash`, and `transcriptRoot` advance together or not at all.
- One state branch becomes canonical; stale or replayed authorizations fail.
- Terminal games never return to active play.
- The factory registry cannot be forged by an arbitrary look-alike game.
- Records cannot be transferred or approved and do not control games.
- No normal protocol call accepts or releases ETH or tokens.
