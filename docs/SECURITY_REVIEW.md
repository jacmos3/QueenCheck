# Security review record

Date: 2026-09-03

This is an evidence record for the repository review performed during the QueenCheck rebuild. It is not a substitute for an independent professional audit and does not authorize mainnet or value-bearing use.

## Scope and method

The review covered the game, rules engine, factory, soulbound record, onchain renderer, deployment module, generated ABI boundary, static client, offline transcript format, dependencies, and release workflows. Manual data-flow and invariant review preceded focused tests. Findings were retested against the corrected code rather than carried forward from an obsolete revision.

## Corrected findings

- An invited opponent could previously be attributed to a game without accepting it.
- Castling-right bits were inconsistent with the inherited rules-engine convention.
- A stale draw offer survived subsequent moves.
- Terminal move hashes, transcript commitments, and event ordering diverged.
- The record did not expose the complete ERC-5192 signal.
- Timeout documentation and implementation described different deadlines.
- SVG coordinate arithmetic overflowed and made initial record metadata revert.
- Threefold and 50-move claims were callable by the participant not having the move.
- Moves and competing terminal actions remained possible after timeout grace expiry.
- The client did not reject reverted or disallowed replacement transactions.
- The client had independently configurable factory and record trust roots.
- Imported transcript domains and calculated roots were not revalidated before every signature.
- Several lifecycle actions and signed draw agreements were absent from the client.
- Account/network changes could race asynchronous client state.
- The client pinned a runtime dependency chain with High and Moderate `ws` advisories.
- Ignition's production build path did not preserve the required `viaIR` settings and could not reproduce a deployment build.
- A fixed Ignition deployment ID and schema-only manifest check could misattribute stale deployment state to a newer commit.
- The client trusted a manifest address without independently comparing all component bytecode hashes and immutable relationships.
- Source and live-deployment checks were initially independent, allowing an old exact-source deployment to be mislabeled as a newer release.
- The app-only CI job initially lacked the root production artifacts required to enforce the deployed-manifest gate.

The current regression suites cover these paths, including EIP-712 and ERC-1271 authorization, replay and stale branches, atomic batches, live/checkpoint equivalence, exact timeout boundaries, repetition, castling, en passant, promotion, dynamic metadata, soulbinding, and forced ETH.

## Current result

The final targeted re-review found no outstanding confirmed Critical, High, or Medium vulnerability in the reviewed code paths. Runtime npm audits report zero known advisories for both dependency sets. This statement is limited to the exact reviewed tree and is not an assertion that the software is defect-free.

## Residual and external risks

- The chess engine remains a complex correctness surface and needs an independent audit of the exact release commit and bytecode.
- A chain fork preserving chain ID, clone address, and state is outside ordinary EIP-712 replay separation.
- The ruleset identifier does not itself prove rules-engine bytecode; deployment records and source verification are mandatory.
- A worst-case checkpoint may use more gas than the covered 16-ply fixture; clients can publish smaller batches.
- Unpublished offline transcripts can be withheld or lost, and signatures do not prove wall-clock creation time.
- The static client requires hosting-level CSP and security headers; repository configuration alone cannot guarantee that a provider serves them.
- The current SvelteKit build graph retains three Low `cookie` advisories in development-only packages because no compatible upstream patch is published. The deployed static client and runtime dependency audit are unaffected.
- Legal, privacy, marketing, competition, and jurisdictional questions require qualified counsel before a public production launch.
