# Security policy

QueenCheck is pre-audit software for local development and Base Sepolia testing. No version is approved for mainnet, value custody, paid entry, prizes, wagering, or other financial use.

## Reporting a vulnerability

Once this repository is public, use GitHub's private security-advisory reporting flow for vulnerabilities. Do not publish an exploitable issue before maintainers have had a reasonable opportunity to investigate. Include the affected commit, contract or client path, prerequisites, a minimal non-destructive reproduction, impact, and any proposed mitigation.

Never include private keys, seed phrases, funded-account credentials, personal data, or destructive proof-of-concept transactions in a report.

## Release boundary

Only the exact source and bytecode identified by a release can be assessed. Forks, modified deployments, unofficial frontends, wrappers, competitions, and integrations are outside QueenCheck's security claims. See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for trust assumptions and release gates.
