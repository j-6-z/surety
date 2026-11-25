# Surety threat model

What is worth stealing, who could try, what stops them, and what does not. Written for the vault deployed on Monad mainnet at `0x8b8d4a18D9abB59Cc499c62DC46032A1AbB95415`. No independent auditor has reviewed this contract.

## What is at stake

- **USDC held by the vault.** Provider bonds and backer stakes. This is the only money in the system.
- **Correct refunds.** An agent that paid for a failed call gets its payment back; a provider is slashed only for calls that really failed.
- **Trust scores.** Agents use them to choose providers.

## Who is involved

| Role | Can do | Trusted to |
| --- | --- | --- |
| Owner | Pause, replace the arbiter and treasury, change the minimum bond, fee, unbonding delay and both refund caps | Act honestly. A malicious owner can take everything (see T2) |
| Arbiter (the relay's key) | Pay claims from any provider's cover, within the caps | Report verdicts honestly. Bounded if stolen (see T1) |
| Provider | Post, queue and withdraw its own bond; publish its SLA | Nothing |
| Backer | Stake behind a provider; queue and withdraw | Nothing |
| Agent | Call providers through the relay; receive refunds | Nothing |
| Anyone | Read state; fund rewards | Nothing |

## Threats

Each row says how far the control goes, and what is left over.

| # | Attack | What stops it | What is left |
| --- | --- | --- | --- |
| T1 | **The arbiter key is stolen** from the server and used to pay fake claims to the attacker | One claim is capped at `maxClaimPayout` (5% of the minimum bond on deploy). Claims against one provider stop for the UTC day at `maxDailySlashBps` of its cover (20% on deploy), plus the one claim that crosses the line. The owner can pause and replace the arbiter. | Up to about a fifth of each provider's cover per day until the owner reacts. Days are fixed UTC buckets, so two days' allowance can be taken in the minutes either side of midnight. Nothing alerts the owner automatically. |
| T2 | **The owner is malicious or its key is stolen** | Ownership moves in two steps (`Ownable2Step`). The fee is capped at 10% and the delay at 1 to 30 days in code. | The owner can lift both refund caps and appoint its own arbiter, then drain every bond through claims. The owner is fully trusted. It is a single key today; it should be a multisig with a timelock. |
| T3 | **The relay reports a false failure** and slashes an honest provider | A claim needs a confirmed on-chain USDC transfer to the provider's `payTo`, less than 10 minutes old. Checks are mechanical: status, latency, JSON shape. The evidence hash is written to the claim event. Loss per provider is bounded by T1's caps. | One relay, run by the project. Its verdict is final. There is no dispute window, and the evidence itself is kept only by the relay. |
| T4 | **The relay reports a false pass**, so an agent is not refunded | Nothing on-chain. | The agent's only protection is the relay's honesty and public code. |
| T5 | **A provider pays itself** through the relay to raise its trust score | Only paid calls count toward the score. | **Open.** Payments on passing calls are not verified on-chain, so a provider can also forge them. The score should not be relied on for anything but a rough signal. |
| T6 | **An agent tries to profit from refunds** | A refund equals the amount the on-chain transfer actually moved, to the address that paid. The best outcome is getting your own money back. A claim id is derived from the payment transaction and pays once. | An agent that can make a provider slow (for example by flooding it) can make it lose bond, at no gain to itself beyond free calls. |
| T7 | **A provider withdraws its bond before a claim lands** | Withdrawals wait out the unbonding delay (7 days), stay slashable throughout, and must complete inside a 3-day window. A queued withdrawal ends active status at once, so agents see the exit before it happens. | A failure discovered after the delay has passed cannot be claimed. |
| T8 | **A backer exits ahead of a slash** it sees coming | Same delay, and queued shares are slashed pro rata like any others. | None known. |
| T9 | **The same payment is refunded twice** | `claimId = keccak(chainId, paymentTx)`; `claimPaid` is set before any transfer. | None known. |
| T10 | **Share-price manipulation** against later backers (first-depositor inflation, donations) | One million virtual shares per provider. The books use internal accounting, so tokens sent straight to the vault change nothing. Rewards are refused until 1 USDC is staked. Rounding always favours the vault. | A raw transfer to the vault is stuck there for good; there is no sweep function. |
| T11 | **Reentrancy** through a token callback | State changes come before transfers, every function that moves money is `nonReentrant`, and USDC has no transfer hooks. | A future settlement token with hooks would need re-review. |
| T12 | **A pause traps users' money** | Pausing blocks deposits, new stakes and claims only. Exits are never pausable. | A paused vault pays no refunds, so agents are unprotected while it lasts. |
| T13 | **The token itself.** USDC can freeze addresses and can be upgraded | None. | If the treasury address were frozen, the fee transfer would revert and block every claim until the owner sets a new treasury. A frozen agent cannot be refunded. |
| T14 | **A day with many real failures** reaches the daily limit | The relay then reports the provider as not covered, and the spending guard refuses to pay it, so agents are warned before they pay. A refused claim can still be paid on a later day. | The relay does not retry refused claims by itself. Agents that ignore the verdict on the unpaid first request can pay and not be refunded that day. |
| T15 | **An expensive call fails.** A call priced above `maxClaimPayout` | The claim reverts; it is not paid in part. | Such a call cannot be refunded until the owner raises the cap, which also widens T1. |
| T16 | **The relay is used to reach internal addresses** (SSRF) | SLA and provider URLs must be https and resolve to public addresses; redirects are refused. | DNS could change between the check and the request. |
| T17 | **Block timestamp is nudged** by a validator | Delays and windows are measured in days. | A claim within seconds of midnight UTC can land in either day's bucket. |

## Cross-chain: the beacon and the mirror

`SuretyBeacon` (Monad) and `SuretyMirror` (Base) carry "is this provider bonded?" to another chain over LayerZero V2. They are described in [CROSSCHAIN.md](../CROSSCHAIN.md). Neither holds funds and neither has any role on the vault, so nothing here can move USDC. What is at stake is the **truth of what the mirror says**: a contract or agent on Base may decide whether to pay a provider on the strength of it. They are live on mainnet: beacon `0xf25b3F37a50fd9f938C836A8926ECC7786F958fe` on Monad, mirror `0x0593c77e43704C2a3f8512f3a4645ce57860FBED` on Base.

| # | Attack | What stops it | What is left |
| --- | --- | --- | --- |
| X1 | **A forged report** is delivered to the mirror | `lzReceive` accepts calls only from the LayerZero endpoint, only for messages whose sender is the beacon set as peer, and only from the Monad endpoint id fixed at deploy. | The route's DVNs are trusted. If the required DVNs collude or are compromised they can deliver anything. The set is named by the pair itself at deploy (LayerZero's default for this route is a placeholder), so only the owner can change it. |
| X2 | **The caller of `broadcast` lies** about a provider | The caller supplies only addresses. Every value is read from the vault inside the call. | None for content. The caller does choose which providers and when, so a provider can avoid refreshing bad news about itself (see X4). |
| X3 | **An old report arrives after a newer one** (LayerZero V2 does not order delivery) and overwrites it | Each provider's record keeps the report with the highest (time read on Monad, nonce). Fuzzed over arbitrary delivery orders. | Two beacons live at once, sending in the same second, would tie-break on unrelated nonces. Only one beacon is ever the peer. |
| X4 | **A provider loses cover and nobody tells the mirror** | A report stops counting after `maxAge` (1 hour by default). Anyone can broadcast, including an agent about to pay. | Up to `maxAge` of false "covered". A queued bond stays slashable on Monad for the 7-day unbonding period, so a claim in that window is still paid. A provider whose daily refund limit is used up can read as covered until refreshed. |
| X5 | **A message is sent with too little gas** to execute, so the mirror never updates | The beacon computes the destination gas from the batch size; the caller cannot lower it. Defaults are measured and held to a 15% margin by a test. | A chain that prices storage higher than assumed needs the owner to raise the setting. A delivery that runs out of gas changes nothing and can be retried by anyone through the endpoint. |
| X6 | **A malformed or future-format message** | The mirror checks the length and the version byte and reverts on either. A revert leaves the message unexecuted; it does not block later ones. | An undeliverable message stays in the endpoint until the owner clears it. |
| X7 | **The mirror's owner key is stolen** | Ownership moves in two steps. The Monad-only check cannot be changed after deploy. | The owner can name a different beacon on Monad as peer, and that beacon can report anything. The owner is the deploying wallet today, a single key. |
| X8 | **Griefing by broadcasting** many reports | Each broadcast costs the caller a LayerZero fee. Batches are capped at 20. A delivery only writes storage. | None that costs anyone but the caller. |
| X9 | **Replay** of a delivered message | The endpoint delivers each message once. If one were repeated, the mirror ignores a report that is not newer than what it holds. | None. |

## What has and has not been done

Done:

- 100% line, statement, branch and function coverage of `SuretyVault.sol` and the three cross-chain contracts from the Foundry suite.
- Seven invariants checked over 25,600 random calls each, eight fuzz properties over 1,000 inputs each, fifteen unit tests for refusal paths.
- For the cross-chain contracts: twenty-five unit tests and five fuzz properties, including delivery in arbitrary order.
- A mutation check: 43 deliberate bugs planted one at a time (18 in the vault, 25 in the cross-chain contracts), all 43 caught (`npm run test:mutants`).
- Static analysis with Slither: no high-severity findings (see [SLITHER.md](SLITHER.md)).

Not done:

- No independent audit. No formal verification.
- The owner is a single key, with no timelock.
- One relay, with no dispute process.
- No monitoring or alerting on claims.
- The cross-chain contracts are tested against a mock LayerZero endpoint. On mainnet they have delivered only a handful of reports.
