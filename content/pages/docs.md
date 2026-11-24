---
title: Surety docs
description: Reference for agents and API providers: the relay address format, the response headers, the trust record, the SLA document and the vault functions.
nav: docs
order: 2
---

Everything here is live on {{network}} (chain ID {{chainId}}) and uses {{usdcLabel}}. {{#mainnet}}That is real money, and the vault contract has not been audited. {{/mainnet}}To launch your own bonded API, start with the [provider kit](/kit/). For the manual route, read [how to bond your API](/articles/bond-your-x402-api/).

## For agents

### Calling a bonded provider

Take the provider's normal path and put the relay in front of it:

```
https://www.surety.buzz/call/<providerAddress>/<path>
```

Pay with x402 the way you already do. The relay forwards the `402` handshake and the payment headers untouched, so any x402 client works.

### What comes back

You get the provider's own response, plus these headers:

| Header | Meaning |
| --- | --- |
| `x-surety-verdict` | `pass`, `fail`, `unpaid` (the 402 handshake) or `uncovered` |
| `x-surety-reason` | Why. See the list below |
| `x-surety-latency-ms` | How long the provider took, measured by the relay |
| `x-surety-claim` | `paid` when a refund was sent. Otherwise `none:…` or `error:…` with the cause |
| `x-surety-claim-tx` | Transaction hash of the refund |
| `x-surety-claim-payout` | Amount refunded, in USDC base units (6 decimals) |

Reasons: `ok`, `bad_status`, `too_slow`, `invalid_json`, `schema_mismatch`, `no_response`, `provider_inactive`, `endpoint_not_in_sla`.

A call is only refunded if it was paid for. A response with no x402 settlement receipt gets `x-surety-claim: none:no_payment_receipt`.

### Checking a provider first

```
GET https://www.surety.buzz/trust/<providerAddress>
```

| Field | Meaning |
| --- | --- |
| `active` | Whether its calls are covered right now |
| `score` | 0 to 100. See below |
| `bond` | The provider's own bond, in base units |
| `committedCover` | Bond plus backing that is not queued for withdrawal |
| `claimCount`, `claimsPaid` | Refunds paid from this provider, ever |
| `calls`, `passRate` | Paid calls this relay has seen, and the share that passed |

The score is 0 for an inactive provider. Otherwise it is 60 points for pass rate (counted as 50% until the relay has seen 20 paid calls) plus 40 points for committed cover, with full marks at ten times the minimum bond.

### The JavaScript client

```js
const { createSuretyClient } = require("./sdk");
const surety = createSuretyClient({ relayUrl: "https://www.surety.buzz", fetch: yourX402Fetch });

const record = await surety.trust(provider);
const { response, verdict, claim } = await surety.call(provider, "/v1/price/mon");
```

### Spending limits

A guard sits underneath your x402 client and reads every payment it has signed before the request leaves your process. A payment that breaks a rule is never sent.

```js
const { createSuretyClient, createGuard } = require("./sdk");
const { wrapFetchWithPayment } = require("@x402/fetch");

const guard = createGuard({
  relayUrl: "https://www.surety.buzz",
  maxPerCall: "0.01",      // USDC
  dailyBudget: "1",        // USDC per UTC day, after refunds
  minTrustScore: 30,
  logFile: "./spend-log.jsonl",
});
const payingFetch = wrapFetchWithPayment(guard.fetch, yourX402Client);
const surety = createSuretyClient({ relayUrl: "https://www.surety.buzz", fetch: payingFetch });
```

| Setting | What it does |
| --- | --- |
| `maxPerCall` | Refuses any single call that costs more than this |
| `dailyBudget` | Refuses calls once the day's spending reaches this. A refunded call does not count |
| `providers` | If set, only these provider addresses can be paid |
| `bondedOnly` | Only pays providers whose calls are covered right now. On by default |
| `minTrustScore` | Only pays providers at or above this score |
| `logFile` | Keeps a line per payment and per blocked attempt, and makes the budget survive a restart |

A blocked call throws a `SuretyGuardError` with a `code`: `over_call_cap`, `over_daily_budget`, `provider_not_allowed`, `provider_not_bonded`, `trust_too_low`, `not_through_surety`, `wrong_token`, `unreadable_payment` or `trust_unavailable`. Read `guard.spentToday()`, `guard.remainingToday()` and `guard.log()` at any time.

The guard also refuses to pay a provider directly, around the relay, because that call could not be refunded.

**What it does not do.** The guard runs inside your agent's own process. It stops bugs, bad prompts and runaway loops. It does not stop someone who has the agent's key, because they can sign payments without it. Keep only small amounts in an agent wallet.

## For providers

### The SLA document

A JSON file at an https address you control:

| Field | Meaning |
| --- | --- |
| `version` | Always `1` |
| `baseUrl` | Where your API lives |
| `payTo` | The wallet your x402 payments settle to |
| `endpoints[].method`, `.path` | The route. Paths may use a parameter such as `/v1/pool/:address` |
| `endpoints[].maxLatencyMs` | The longest a full response may take, payment settlement included |
| `endpoints[].responseSchema` | Optional JSON Schema a success response must match |

### Vault functions

The vault is at `{{vault}}`.

| Function | What it does |
| --- | --- |
| `register(metadataURI)` | Lists you, pointing at your SLA document |
| `setMetadata(metadataURI)` | Changes the SLA address |
| `depositBond(amount)` | Adds USDC to your bond. Approve the vault first |
| `requestBondWithdraw(amount)` | Queues bond for exit. It stops counting toward active status at once |
| `cancelBondWithdraw()` | Cancels a queued exit |
| `completeBondWithdraw()` | Withdraws once the delay has passed, within the 3-day window |

Backers use `back(provider, amount)`, `requestUnstake`, `cancelUnstake` and `completeUnstake` in the same way.

### Limits to plan around

- Only the x402 `exact` payment scheme is handled.
- The relay reads the whole response to check it, so streaming endpoints are not supported.
- Your SLA document is re-read about once a minute.

The full source, with tests, is on [GitHub](https://github.com/j-6-z/surety).
