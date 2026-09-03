# Deployment

## Supported targets

- Hardhat simulated networks for development and tests.
- Base Sepolia (`84532`) for public, non-material testing.

No mainnet target is configured. Do not add one as a convenience alias.

## Local verification

```bash
npm ci
npm run compile
npm test
npm run check:size
npm run sync:abi
npm run check:abi
npm run check:deployment

npm --prefix app ci
npm --prefix app test
npm --prefix app run check
npm --prefix app run build
npm audit --omit=dev --audit-level=high
npm --prefix app audit --omit=dev --audit-level=high

# Exercises the complete Ignition graph against an ephemeral OP-style chain.
npm run deploy:local
```

The compile, contract-test, and deployment scripts all select Hardhat's
`production` build profile explicitly. The profile pins the same optimizer,
`viaIR`, Cancun EVM target, and WASM compiler settings used for the release
artifacts; do not validate one profile and deploy another.

## Secret handling

Hardhat configuration variables are lazy. Store the Base Sepolia RPC URL and dedicated testnet deployer key in the encrypted Hardhat keystore, never in tracked files:

```bash
npx hardhat keystore set BASE_SEPOLIA_RPC_URL
npx hardhat keystore set QUEENCHECK_DEPLOYER_PRIVATE_KEY
```

Use a dedicated testnet-only account. Never reuse a production, treasury, personal-custody, or mainnet-funded key.

## Base Sepolia

After all release checks pass:

```bash
npm run deploy:base-sepolia
```

The command refuses a dirty tree, a branch other than `main`, or a commit that is not the live `origin/main` HEAD. Every Ignition deployment ID contains the full source commit, so ignored state from another revision cannot be resumed as the current release. It deploys with Ignition, requires exact source verification through Sourcify for every top-level contract and the factory-created record, verifies the immutable component relationships and live bytecode, then writes `app/src/lib/deployments/base-sepolia.json`. That versioned manifest binds the Git commit and tree, a fingerprint of all release-sensitive files, generated ABI, compiler profile, production artifact/build-info fingerprints, dependency lockfile hashes, chain, deployer, transaction hashes, addresses, runtime code hashes, relationship graph, and verification evidence.

Commit and push that generated manifest immediately after a successful deployment. The Base Sepolia client reads the factory address only from this manifest; no public environment override is accepted. A deployment is not complete merely because the transactions succeeded.

`npm run check:deployment` rechecks the source fingerprint, ABI, compiler inputs, production build-info and artifacts, then queries Base Sepolia and Sourcify to compare all five live runtimes, creation transactions, exact source matches, and component relationships. Runtime comparison masks only compiler-declared immutable slots, whose values are checked separately through the relationship graph; all executable and metadata bytes must match the current production build. The web build runs this check automatically, and CI compiles the production artifacts before building the app. The browser independently enforces the code hashes and relationship graph before enabling a game read or transaction. Any release-sensitive source change fails the release build until the manifest is reset to `not-deployed` or a matching deployment is published.

The client is configured with only the manifest's factory address. It derives `record()` from that verified factory and checks the record's bytecode and back-reference; never configure an unrelated record address.

`app/static/_headers` supplies a restrictive baseline for hosts that support the standard static `_headers` format. After publishing, verify the headers on the real `queencheck.com` response; providers that ignore this file must be configured equivalently at the edge. Do not claim CSP, HSTS, clickjacking, MIME-sniffing, referrer, or permissions-policy protection until that live check passes.

The deployment module creates the rules engine, locked game implementation, renderer, and factory as separate components. The factory then creates its immutable record contract; this avoids embedding the large chess engine in factory initcode.
