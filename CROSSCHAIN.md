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

## Stage two: refunds on the payer's chain

Status: contracts, relay support and commands are built and tested against a mock endpoint. **Not deployed.** Going live makes a new contract the vault's arbiter, so it waits for a testnet run first.

Today an agent that pays on Base for a call that fails would be refunded on Monad. Stage two pays it on Base, with two more contracts and no change to the vault.

```
        Monad                                             Base
  ┌─────────────┐ pays ┌──────────────┐   LayerZero   ┌───────────────┐ pays
  │ SuretyVault │─────►│ SuretyRouter │──────────────►│ SuretyOutpost │─────► agent
  └─────────────┘      └──────────────┘  batch of     └───────────────┘
        ▲ arbiter = router   ▲ relay files claims      holds a float of USDC
```

1. **Settle on Monad.** `SuretyRouter` becomes the vault's arbiter (the vault already lets its owner change the arbiter). For a payer on Base, the relay calls `payClaimRemote`. The vault pays the router instead of the agent: the provider's bond is slashed at once and the money is set aside in a queue.
2. **Deliver on Base.** `flush` sends up to 20 queued refunds in one LayerZero message. `SuretyOutpost` pays each agent from a float of USDC it holds.
3. **Reimburse.** Once a batch is sent, the USDC behind it in the router becomes reimbursable, and the owner moves it across to top the float back up.

A refund for a payer on Monad still goes straight through (`payClaim` on the router passes it to the vault unchanged).

### Decisions, and why

| Decision | Reason |
| --- | --- |
| Refunds are batched, not sent one by one | A LayerZero message cost about 22.8 MON on the day stage one went live, far more than a typical refund is worth. One message carries 20. |
| Anyone can call `flush` and pay the fee | An agent never has to wait on the operator to get its money moving. |
| The router queues what the vault really paid | The vault pays less than asked when a provider's cover is short. The router measures what arrived instead of trusting the figure it sent. |
| Queued money is out of everyone's reach | The owner can take out only what is behind batches already sent. Checked by an invariant over random sequences. |
| A refund the outpost cannot pay becomes a credit | An empty float, or a token that refuses one address, must not lose a refund or stop the other 19 in the batch. Anyone can call `collect(agent)` later; the money only ever goes to the agent. |
| New refunds are paid from spare float only | An agent already waiting on a credit is not jumped by a later arrival, and the owner cannot withdraw float that credits have a claim on. |
| The router adds no power over the vault | It can do exactly what the arbiter could: pay claims inside the vault's per-claim and per-day limits. The relay key moves from the vault to the router; the owner can replace it. |
| Order of arrival does not matter | Refunds are independent, so unlike stage one there is nothing to sequence. Fuzzed with batches delivered in shuffled order. |

### What it adds to the trust picture

- **The float is fronted by the operator.** If the owner takes reimbursement from the router and never refills the outpost, agents on Base hold credits that do not pay. The provider was still slashed, so the loss falls on agents. This is the main new trust assumption.
- **A delay.** A refund is settled on Monad immediately but reaches Base only when someone flushes.
- **The same DVNs as stage one** now carry instructions to pay, not just a status. A forged message could drain the float, which is why the float should stay small.

### Tests

| Check | Result | Run it |
| --- | --- | --- |
| Unit tests | 22: settle, deliver, credits, a refused transfer, limits, every refusal, gas headroom | `npm run test:sol` |
| Fuzz properties | 3, each over 1,000 inputs, including: every agent ends with exactly its refunds for any mix of claims, float and delivery order | `npm run test:sol` |
| Invariants | 4, each over 256 random sequences of 100 actions: the router holds exactly what it owes; every refund is in exactly one place; each agent gets exactly its refunds; no rule broken along the way | `npm run test:sol` |
| Coverage | 100% of lines, statements, branches and functions of all three contracts | `npm run coverage:sol:check` |
| Mutation check | 34 bugs planted one at a time, 34 caught | `npm run test:mutants` |
| Relay and commands | 9 JavaScript tests: a failed call paid on Base settled on Monad and paid back on Base, an empty float, a full queue sending itself, Monad payments unchanged, no double refund | `npm test` |
| Static analysis | Slither: 1 high reported and reviewed as a false positive, 3 medium accepted ([notes](audit/SLITHER.md)) | `slither .` |

### How the relay uses it

Set `ROUTER_ADDRESS` on the server and the relay files every claim through the router. When a failed call's x402 receipt says the payment settled on Base, the relay checks the USDC transfer on Base, files the claim with `payClaimRemote`, and tells the caller where the refund is going:

```
x-surety-claim: paid
x-surety-claim-settles-on: eip155:8453
x-surety-claim-delivery: queued        (or "sent" if that claim filled a batch)
```

A payment made on Monad is refunded on Monad at once, exactly as before. Without `ROUTER_ADDRESS` nothing changes. The claim id includes the chain the payment was made on, and the vault pays each id once, so one payment cannot be refunded on both chains.

### Commands

```
node scripts/crosschain.js deploy-refunds     # router on Monad, outpost on Base, wired, verifiers named
node scripts/crosschain.js refunds [0xAgent]  # queued, sent, spare float, credits, and who the vault's arbiter is
node scripts/crosschain.js float 5            # move 5 USDC from your wallet into the outpost's float
node scripts/crosschain.js flush              # send the next batch of queued refunds
node scripts/crosschain.js refund-test        # testnet only: one made-up claim, to watch the path end to end
```

`deploy-refunds` does not touch the vault. It prints the router's address and stops.

### Going live, in order

1. `deploy-refunds`, then `float` a small amount.
2. Set `ROUTER_ADDRESS` on the server and redeploy it.
3. From the vault's **owner** wallet, call `setArbiter(<router address>)` on the vault. This is the only step that changes the live system. Between steps 2 and 3 the relay cannot file claims, so do them back to back.
4. To undo it: the owner calls `setArbiter(<the relay's own address>)` and `ROUTER_ADDRESS` is removed from the server.

### Still to do

- A run on testnet against the real LayerZero endpoint, using `refund-test`.
- A provider that accepts payment on Base. The Market Data API and the provider kit charge on Monad only today, so until one does there is no Base payment to refund.
- A routine for refilling the float from the router's reimbursable balance.
