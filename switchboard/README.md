# Switchboard

**One endpoint for every Surety-bonded x402 API on Monad.**

An agent asks for a capability (`price.mon`). Switchboard answers with the best covered provider that is up right now: cheapest first, then highest trust score, then fastest. The SDK calls it through the Surety relay. If the call misses its promise, Surety refunds it on-chain from the provider's bond and the SDK tries the next provider.

> **Beta.** Built on the Surety vault, which is not audited. Keep amounts small.

## Why it's safe to run

Switchboard **holds no key and never touches the agent's call or money.** It only answers "who should I call". The agent pays the provider directly, through Surety. Switchboard earns a small x402 fee per lookup (`ROUTE_PRICE`, default $0.0001), and the SDK caches a lookup for 30 seconds, so a busy agent pays once per window, not once per call.

## Where the index comes from

1. **Surety's `/providers.json`**: which providers exist, whether they are covered, trust score, cover.
2. **The vault on-chain**: each provider's SLA link.
3. **Each SLA document**: the endpoints. An endpoint's capability is its own `"capability"` field if it has one, otherwise a match in `capabilities.json` (e.g. `/v1/price/mon` → `price.mon`).
4. **An unpaid probe** of each endpoint: is it up, how fast, and its real price, read from its own 402 answer. Nobody is charged.

5. **Tally's `/scores.json`** (optional, `TALLY_URL`): a trust score rebuilt from chain data alone. When set, it replaces the relay's score, and a provider Tally flags as a demo is never routed to. Each candidate says which it got in `scoreSource`. If Tally is unreachable or its scores are older than 24 hours, the relay's scores are used instead.

Refreshed every 60 seconds. Only covered, reachable, priced endpoints are routable.

## Endpoints

| | |
| --- | --- |
| `GET /` | Dashboard (browsers) or a JSON description (agents) |
| `GET /v1/capabilities` | Free. Each capability, covered providers, best price |
| `GET /v1/route?capability=price.mon&maxPrice=0.01&minTrust=30` | **Paid per lookup.** Ranked candidates with call URLs |
| `GET /v1/stats` | Free. Lookups served since this instance started |

Bad input and "no provider for that" are answered **before** the paywall, so nobody pays for a typo or an empty answer.

## For agents

```js
const { createSwitchboard } = require("./sdk");
const sb = createSwitchboard({ url: "https://<switchboard-host>", fetch: payingFetch });

const r = await sb.call("price.mon", { maxPrice: "0.01", minTrust: 30 });
r.provider; r.verdict; r.attempts;           // attempts[i].claim has any refund tx
await r.response.json();

await sb.call("pool.v3", { params: { address: "0xPool..." } });
```

`payingFetch` is any x402-paying fetch. Put a Surety guard under it to cap spend (`createGuard` in Surety's SDK).

Try it: `AGENT_KEY=0x... node examples/call.js https://<switchboard-host> price.mon`

## For providers

Bond on Surety as usual. To be routed under a capability that isn't in `capabilities.json`, add a `"capability"` field to the endpoint in your SLA document:

```json
{ "method": "GET", "path": "/quote", "maxLatencyMs": 800, "capability": "price.eth" }
```

## Run it

```bash
npm install
npm test             # local end-to-end tests, no network
npm start            # http://localhost:8403
```

**Vercel:** new project, root directory `switchboard`. Settings: `SWITCHBOARD_PAY_TO` (an address), optionally `ROUTE_PRICE`. That's it: no key.

## Known limits

- GET endpoints only, for now.
- Stats are kept in memory and reset when a serverless instance restarts.
- `/v1/capabilities` is free and shows best prices; the paid lookup is the ranked, ready-to-call list.
- Price is what the provider's 402 says at probe time; the agent's own x402 client still enforces its cap on every payment.
- Without `TALLY_URL`, ranking trusts Surety's relay for trust scores. With it, only for whether a provider is covered right now.

MIT
