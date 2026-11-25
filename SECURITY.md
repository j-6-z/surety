# Security

Surety is a beta running on Monad mainnet with real USDC. The contract has not been independently audited. Bond only what you can afford to lose.

## Reporting a problem

If you find a vulnerability, please open a private security advisory on this repository (Security tab, "Report a vulnerability") instead of a public issue. If money is at risk right now, say so in the first line.

## What to read

- [Threat model](audit/THREAT_MODEL.md): who can attack the vault, what stops them, and what is left over.
- [Static analysis notes](audit/SLITHER.md): every Slither and lint finding, and why it stands.
- The README's "Security and testing" section: coverage, invariants and the mutation check, with the command for each.

## Trust assumptions, in short

- **The owner is fully trusted.** It can pause the vault, replace the arbiter and lift the refund caps. It is a single key today.
- **The arbiter is trusted within limits.** It can pay claims from any provider's cover, capped per claim and per provider per day.
- **The relay is run by one party and its verdicts are final.** There is no dispute process.
- **Trust scores can be gamed** by a provider paying itself. Treat them as a rough signal.
