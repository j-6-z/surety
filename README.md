# Surety

**Bond-backed refunds for x402 AI agent payments, on Monad.**

An API provider posts a USDC bond. Agents call the provider through the Surety relay and pay with x402 as usual. If a paid call comes back too slow, with an error status or with the wrong response shape, the agent is refunded on-chain from the provider's bond, automatically.

> **Status: experimental.** Live on Monad testnet, unaudited, and run by a single trusted relay. Do not use it with real funds. See [Known limits](#known-limits).

| | |
| --- | --- |
| Network | Monad Testnet (chain ID 10143) |
| SuretyVault | `0xf3F9e32De47a143149F7398f25f264b98a01273C` |
| Settlement asset | Testnet USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3` |

## How it works

1. A provider registers on the vault with a link to its SLA document and posts a bond. Backers can stake behind providers they trust.
2. An agent calls `<relay>/call/<providerAddress>/<path>` with its normal x402-paying fetch. The relay forwards the request untouched, payment headers included.
3. The relay times the response and checks status, latency and JSON shape against the SLA. These are objective checks only. It never judges whether an answer was good.
4. If the call failed **and** the response carries an x402 settlement receipt, the relay confirms on-chain that USDC really moved from the agent to the provider, then calls `payClaim`. The refund equals what the agent paid, taken from the bond first and then from backers.
5. The agent gets the provider's response back, plus `x-surety-*` headers with the verdict and the refund transaction.

The claim id is derived from the payment transaction, so one payment can only be refunded once. No receipt means no refund: a call that was never paid for has nothing to pay back.

## Try it locally

Needs Node 18 or newer. Everything runs on a local chain, with no wallet or network needed.

```bash
npm install
npm test          # 56 tests
npm run demo      # one healthy call, two refunded ones
```

`npm run gas` prints gas per vault operation. `npm run bench` measures how much time the relay adds to a call.

## What's in here

| Path | What it does |
| --- | --- |
| `contracts/SuretyVault.sol` | Bonds, backer staking, exit queue, claim payouts, protocol fee, pause |
| `verifier/relay.js` | The relay: forwards calls, checks them against the SLA, proves the payment on-chain, files claims, serves trust scores |
| `verifier/sla.js` | SLA document format and the checks |
| `verifier/payment.js` | Reads the x402 settlement receipt and confirms the USDC transfer on-chain |
| `verifier/netguard.js` | Refuses provider URLs that aren't https or that resolve to internal addresses |
| `sdk/index.js` | Agent client: `call()` and `trust()` |
| `api/` | Surety Market Data API: the first bonded provider (see below) |
| `examples/` | A real x402-paid API and paying client (official x402 SDK), plus mocks for tests |
| `scripts/` | Deploy, local demo, testnet check, gas and latency measurements |
| `test/` | Contract tests, a randomised invariant test, and end-to-end tests through the relay |

## For providers: the SLA document

Host this JSON at an https URL and pass that URL to `register()`:

```json
{
  "version": 1,
  "baseUrl": "https://api.example.com",
  "payTo": "0xYourPaymentWallet",
  "endpoints": [
    { "method": "GET", "path": "/quote", "maxLatencyMs": 800,
      "responseSchema": { "type": "object", "required": ["price"] } }
  ]
}
```

## For agents: the SDK

```js
const { createSuretyClient } = require("./sdk");
const surety = createSuretyClient({ relayUrl, fetch: yourX402Fetch });

const t = await surety.trust(provider);          // score, committed cover, pass rate
const r = await surety.call(provider, "/quote"); // r.response, r.verdict, r.claim
```

**Trust score v0 (0 to 100).** 0 if the provider is inactive. Otherwise 60 points for pass rate over paid calls (counted as 50% until the relay has seen 20) plus 40 points for committed cover, meaning bond and backing not queued for exit, with full marks at 10x the minimum bond.

## Vault rules

- A provider is active only while its bond, not counting any amount queued for exit, is at or above the minimum. Inactive providers are not covered.
- Bond and backing wait out an unbonding delay (7 days by default, always between 1 and 30) and stay slashable while they wait.
- A matured exit must be completed within 3 days or requested again, so nobody can hold an instant exit open.
- A single claim is capped at `maxClaimPayout`. If cover runs short, the agent gets what is there and the protocol fee shrinks first.
- The protocol fee (5% by default, capped at 10%) is taken on top of each payout, from the slashed funds.

## Run it on Monad testnet

1. Create a **fresh** wallet for testnet and fund it with MON from https://faucet.monad.xyz
2. `cp .env.example .env` and set `PRIVATE_KEY=`
3. `npm run deploy:testnet`, then put the printed address in `.env` as `VAULT_ADDRESS=`
4. Get 1 testnet USDC at https://faucet.circle.com (USDC, Monad Testnet)
5. `npm run check:testnet`

The check runs a real x402-paid API locally, bonds it, puts the relay in front of it and makes three paid calls through Monad's x402 facilitator. Expect `RESULT: 3/3`. It lowers the vault's minimum bond to 0.5 USDC, because the faucet only gives 1.

`npm run relay` starts the relay on its own, on port 8402.

## The first provider: Surety Market Data API

`api/` is a small paid API, built to be bonded on Surety itself. It reads Monad prices straight from Uniswap-V3-style pools on-chain, so there is no third-party data feed behind it, and sells each call over x402.

| Endpoint | Returns |
| --- | --- |
| `GET /v1/price/mon` | MON price in USD from the deepest WMON/USDC pool, with the pool address, its USDC depth and the block |
| `GET /v1/pool/:address` | Price both ways and token reserves for any V3-style pool |
| `GET /`, `/health`, `/.well-known/surety.json` | Free: description, health, and the SLA |

It refuses to quote from a pool holding under 1,000 USDC (`MIN_POOL_USDC`), and a call that ends in an error is never charged, because x402 only settles on success.

`npm run check:api` runs it locally with real Monad mainnet prices, bonds it on your testnet vault and buys two calls through the relay. `npm run api` starts it by itself; set `PAY_TO_ADDRESS` in `.env`.

Limits: it reads Uniswap V3 pools only, so liquidity that sits on other venues is not seen, and a spot pool price can be moved by a large trade. It is a demo provider, not a price oracle.

## Hosting it

`npm start` runs the relay and the Market Data API together on one port. On boot it points your on-chain provider record at the server's public address.

`render.yaml` is a ready blueprint for Render: build `npm ci --omit=dev`, start `node start.js`. Set two environment variables in the host's dashboard, never in a file: `VAULT_ADDRESS` and `PRIVATE_KEY` (a testnet-only wallet that is the vault's arbiter and the provider). The public address is picked up from the host, or set `PUBLIC_URL` yourself.

Use an always-on plan. A host that sleeps when idle answers its first call slowly, and a slow paid call is refunded from your bond. Evidence files and call history are kept on local disk, so they reset on redeploy unless you attach a persistent disk and set `DATA_DIR`.

Once it is up, anyone can try it with their own wallet and a little testnet USDC:

```bash
AGENT_KEY=0x... node examples/call-api.js https://<your-host> <providerAddress>
```

## Known limits

- **Unaudited.** No real money until an audit passes.
- **The relay is trusted and central.** It is the arbiter, it sees every call, and latency is measured from where it runs. The plan is to publish its rules and evidence and move to open challenges.
- **Self-dealing is cheap.** A provider can pay itself through a second wallet. Failing on purpose only costs it the protocol fee, since its own bond flows back to its own wallet, and passing on purpose inflates its pass rate. Coverage stops once the bond drops under the minimum, which keeps backers out of reach in the normal case, but several calls in flight at once can still overshoot into backing. A per-claim penalty paid to backers, or reserving bond per in-flight call, is the likely fix.
- **Exact-scheme payments only.** A settlement transaction that batches many agents' payments isn't handled.
- **A provider can edit its SLA document.** The relay re-reads it (cached 60 seconds). Pinning the SLA by hash on-chain is planned.
- **Provider URLs are checked when the SLA loads**, so a host that later re-points its DNS at an internal address isn't caught. Add rate limits before exposing a relay publicly.
- **The whole response is buffered** to check the schema, so streaming endpoints aren't supported.
- **Compiler setup:** `hardhat.config.js` uses the npm `solc` package so it builds offline. Delete that block at the bottom of the file for faster native compiles.

## Related work

Surety is the underwriting layer, not a payment rail or an escrow. It builds on [x402](https://www.x402.org/) and is meant to sit alongside refund schemes such as [x402r](https://www.x402r.org/). The bond-and-underwriting idea follows the direction of the Agentic Risk Standard research.

## License

MIT. See [LICENSE](LICENSE).
