# QueenCheck Project Instructions

## Existing work

- Treat every existing modification as user or prior-agent work unless provenance is certain.
- Inspect `git status` and the relevant diff before editing. Never discard, rewrite, reformat, or revert unrelated changes.
- When resuming interrupted work, inspect the prior thread or summary when available, identify completed work, and continue instead of restarting.
- Do not change branches, commit, merge, push, or alter deployment state unless the user explicitly requests it.
- Never add AI, Claude, or Codex co-author trailers to commits.

## Manager policy

- The primary agent is the manager. Do not create a redundant manager subagent.
- Do not delegate small, clear, sequential tasks. Delegate only bounded independent work or noisy read-heavy investigation that would pollute the primary context.
- Start with the cheapest adequate profile. Escalate model or reasoning only when unresolved ambiguity, risk, or failed validation justifies it.
- Keep at most three subagents active. Parallelize only lightweight read-only work; serialize edits, builds, test suites, browser automation, simulators, and local chains.
- Never assign overlapping write scopes. Wait for implementation to finish before starting verification.
- Require concise subagent results containing conclusions, evidence, file references, residual risks, and the next action. Do not forward raw logs into the primary thread.
- Specialized subagents must not spawn descendants unless the user explicitly requests deeper delegation.

## Project routing

- Use `scout` for targeted file discovery, execution-path mapping, prior-work inspection, and log triage.
- Use `reviewer` for correctness, security, regression, and missing-test analysis.
- Use `contract_auditor` for Solidity security, authorization, protocol invariants, escrow and accounting, dispute logic, liveness, replay resistance, and economic security.
- Use `worker` for one bounded implementation after the relevant behavior is understood.
- Use `verifier` for focused validation after edits are complete.
- For a complex change, prefer `scout` or `reviewer`, then one `worker`, then `verifier`; do not run write and verification phases concurrently.
- Require a focused contract review before implementation when a change affects value custody, state transitions, signatures, settlement, disputes, or deployment assumptions.

## Protocol safeguards

- QueenCheck's protocol core must not introduce fungible tokens, payments, prizes, wagering, escrow, transferable game records, governance tokens, protocol fees, or financial rights.
- Treat contract authorization, signatures, replay protection, external calls, state transitions, timeouts, record minting, and deployment configuration as high-risk boundaries.
- Distinguish frontend validation from enforceable onchain invariants. Never rely on the UI as the only protection for a protocol rule.
- Do not use real private keys, production credentials, or funded mainnet accounts during development or verification.
- Keep generated artifacts, deployed addresses, ABIs, frontend configuration, and contract source synchronized when a task legitimately changes their interface.
- Base Sepolia is the only configured public network. Do not add or deploy to mainnet without a new independent contract audit, legal review, explicit deployment plan, and explicit user authorization.
- The game record is opt-in and soulbound. Any change that makes it transferable or attaches economic benefits requires a fresh architecture and legal review.

## Verification

- Prefer targeted contract or frontend tests before broader suites.
- Serialize contract compilation/tests, deployment simulations, frontend builds, and browser automation on this machine.
- For protocol changes, verify live moves, signed checkpoints, replay/domain separation, atomic batch failure, timeout grace, terminal chess states, and record non-transferability.

## Resource safety

- Before starting memory- or CPU-intensive work, inspect the current machine's available resources and active workload. If resource headroom is limited or unknown, run builds, browser automation, simulators, dependency installation, repository-wide scans, and heavy verification sequentially.
- Prefer `rg -I` restricted to relevant text source and configuration files. Never run an unrestricted multithreaded `git grep` for broad or secret scanning.
- If `git grep` is necessary, use `--threads=1 -I` and exclude dependencies, generated files, build artifacts, images, and media.
- If a command reaches its timeout, do not assume it stopped. Check the exact process and terminate only that orphan before continuing.
- Never start a heavy operation while an earlier Git, build, browser, test, simulator, or local-chain process may still be running.
