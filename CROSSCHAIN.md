# Surety across chains

Surety's bonds live in a vault on Monad. Most x402 payments happen on other chains, Base first among them, and a contract or agent there cannot see Monad. This part of Surety carries one fact across: **is this provider bonded right now, and for how much?**

It is built on LayerZero V2 as two small contracts.

```
        Monad                                        Base
  ┌──────────────┐  reads   ┌──────────────┐   LayerZero   ┌──────────────┐
  │ SuretyVault  │◄─────────│ SuretyBeacon │──────────────►│ SuretyMirror │◄── isCovered(provider)?
  └──────────────┘          └──────────────┘    message    └──────────────┘
                              ▲ anyone calls broadcast(), pays the fee
```

- **`SuretyBeacon`** (Monad) reads the vault for a list of providers and sends what it found.
- **`SuretyMirror`** (Base) stores the newest report per provider and answers `isCovered(provider)`.

Status: live on mainnet since 25 November 2026. Not audited. Refunds are still paid on Monad; delivering them on the payer's chain is the next stage (see the end).

| | Chain | Address |
| --- | --- | --- |
| `SuretyBeacon` | Monad (endpoint id 30390) | [`0xf25b3F37a50fd9f938C836A8926ECC7786F958fe`](https://monadvision.com/address/0xf25b3F37a50fd9f938C836A8926ECC7786F958fe) |
| `SuretyMirror` | Base (endpoint id 30184) | [`0x0593c77e43704C2a3f8512f3a4645ce57860FBED`](https://basescan.org/address/0x0593c77e43704C2a3f8512f3a4645ce57860FBED) |

Verifiers on both sides: LayerZero Labs and Nethermind, 4 confirmations. The [first report](https://layerzeroscan.com/tx/0x833eaa31d91dd7b5f00b73ba7605ed5a462f405183e8146c8308c292c1a7ac9e) was delivered and the mirror matched the vault.

## Using it from Base

```solidity
interface ISuretyMirror {
    function isCovered(address provider) external view returns (bool);
}

// Before paying a provider:
require(ISuretyMirror(MIRROR).isCovered(provider), "provider is not bonded on Surety");
```

`isCovered` is true only if the vault said the provider was covered **and** that report is younger than `maxAge` (one hour by default). A provider nobody has reported, or whose report has gone stale, reads as not covered. `coverageOf(provider)` returns the full record: cover, committed cover, today's remaining refund allowance, when it was read on Monad, and whether it is still fresh.

## Decisions, and why

| Decision | Reason |
| --- | --- |
| The beacon can only send; the mirror can only receive | Each contract has half the attack surface. No message from another chain can reach the beacon, and the mirror cannot be made to send anything. Neither holds funds or has any role on the vault. |
| Anyone can call `broadcast`, and pays the fee | No keeper to trust or to go down. A provider can refresh itself; so can an agent that wants a current answer. |
| The caller picks which providers and when, never what is said | Every number is read from the vault inside the same call. Fuzzed: for any caller, the mirror ends up with exactly what the vault says. |
| Reports are ordered by (time read on Monad, LayerZero nonce) | LayerZero V2 does not promise delivery in the order sent. A late-arriving older report must not overwrite a newer one. Time comes first so a replacement beacon, whose nonces restart at 1, is not locked out; the nonce breaks ties inside one second, where Monad produces more than one block. |
| A report expires after `maxAge` | The mirror is a copy, and a copy with no expiry is a claim about the past presented as the present. Bounded 1 minute to 7 days, owner-set. |
| Destination gas is computed by the beacon: base + per-provider × count | The gas the mirror needs depends on the batch. Letting the caller supply options would let them send a message too under-gassed to deliver. Defaults come from measurement (about 50,000 gas per first-seen provider) and a test holds them to a 15% margin. The owner can set them per chain, within bounds. |
| At most 20 providers per message | Keeps the worst-case delivery near 1.4M gas. |
| A packed wire format, versioned | 69 bytes per provider instead of 160 with `abi.encode`; LayerZero fees grow with size. The first byte is a version, and the mirror refuses versions it does not know. |
| The mirror only accepts the Monad endpoint id, fixed at deploy | LayerZero's peer check already limits who can send. This adds a second lock that the owner cannot open by setting a peer on the wrong chain. |
| Two-step ownership on both | Same as the vault: a mistyped new owner cannot take the contract. |

## What it trusts

- **LayerZero's verifiers (DVNs) for the Monad to Base route.** If the DVNs securing the route collude or are compromised, they can deliver a false report. LayerZero's default for this route is a placeholder DVN that delivers nothing, so the pair names its own: `deploy` ends by running `pin`, which sets LayerZero Labs plus Nethermind on mainnet (whichever of the listed DVNs quote a fee for the route).
- **The owner of each contract.** The mirror's owner can point it at a different beacon, which would let it say anything. Today the owner is the deploying wallet, a single key.
- **Clocks.** Freshness compares Base's block time with the time Monad stamped the report. A few seconds of drift do not matter against a window of an hour.

## Limits

- **It lags.** A provider that queues its exit on Monad still reads as covered on Base until someone broadcasts again or `maxAge` passes. The exposure is small in practice: a queued bond stays slashable for the 7-day unbonding period, far longer than the window.
- **It is a snapshot, not a guarantee.** `isCovered` says the vault held cover and the day's refund limit was not used up when the report was read. Other claims may have used the allowance since.
- **Someone has to pay to broadcast.** Nothing updates on its own. A one-provider report cost about 22.8 MON in LayerZero fees on the day it went live, plus gas.
- **It does not move money.** A refund for a failed call is still paid by the vault on Monad, to the payer's address there.
- **Not audited.** The tests use a mock that stands in for LayerZero's endpoint. On mainnet it has delivered real reports, but only a handful.

## Running it

Needs `PRIVATE_KEY` in `.env`: a wallet with a little gas on both chains (MON and ETH on mainnet, test MON and Base Sepolia ETH on testnet). `SURETY_NETWORK` picks the pair. On testnet the vault must be the current build; the older testnet vault has no `isCovered`.

```
node scripts/crosschain.js status     # read-only. Checks endpoints, the route, the vault and balances
node scripts/crosschain.js deploy     # beacon on Monad, mirror on Base, pointed at each other, verifiers named
node scripts/crosschain.js send       # report PROVIDER_ADDRESS (or addresses you name) to the mirror
node scripts/crosschain.js read       # what the mirror holds, next to what the vault says now
node scripts/crosschain.js pin        # name the DVNs again (deploy already does this once)
```

`status` asks each endpoint on-chain for its id and stops if it does not match `crosschain.config.js`. `deploy` can be run again after a failure; it picks up where it stopped. Addresses are written to `crosschain.deployments.json`.

LayerZero addresses come from LayerZero's own deployment package (`@layerzerolabs/lz-evm-sdk-v2`), recorded in `crosschain.config.js` with the version they were taken from.

## Tests

| Check | Result | Run it |
| --- | --- | --- |
| Unit tests | 25: the happy path, every refusal, out-of-order and repeated delivery, staleness, a replacement beacon, gas headroom | `npm run test:sol` |
| Fuzz properties | 5, each over 1,000 inputs: codec round trip, any delivery order ends on the last report sent, covered exactly while fresh, any batch size is delivered in full, the caller cannot change the content | `npm run test:sol` |
| Coverage | 100% of lines, statements, branches and functions of all three contracts | `npm run coverage:sol:check` |
| Mutation check | 25 bugs planted one at a time, 25 caught | `npm run test:mutants` |
| Scripts | 9 JavaScript tests: deploy, re-run, resume after a half-finished deploy, send, read, DVN config encoding | `npm test` |
| Static analysis | Slither: 0 high, 0 medium | `slither .` |

## Next stage: refunds on the payer's chain

Today an agent that pays on Base for a call that fails would be refunded on Monad. The plan for stage two:

1. A router contract on Monad becomes the vault's arbiter (the vault already allows the owner to change it, so the vault itself does not change). The relay calls the router instead of the vault.
2. For a payer on another chain, the router takes the refund from the vault and sends a LayerZero message to an outpost contract on that chain.
3. The outpost pays the payer from a float it holds, and the float is topped up from what the router collected.

That design adds a float to manage and a contract with authority over the vault, so it gets its own threat model and tests before any of it is deployed.
