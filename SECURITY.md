# Security

Surety is experimental, unaudited software running on testnet. Do not use it with real funds.

## Reporting a problem

If you find a vulnerability, please open a private security advisory on this repository (Security tab, "Report a vulnerability") instead of a public issue.

## Known trust assumptions

- The arbiter is a single key that can pay claims of up to `maxClaimPayout` each from any provider's bond and backing.
- The relay is run by one party and its verdicts are final.
- The owner can pause the vault and change its parameters.

The README's "Known limits" section lists the open design issues, including provider self-dealing.
