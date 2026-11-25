# Surety

**Bond-backed refunds for x402 AI agent payments, on Monad.**

An API provider posts a USDC bond. Agents call the provider through the Surety relay and pay with x402 as usual. If a paid call comes back too slow, with an error status or with the wrong response shape, the agent is refunded on-chain from the provider's bond, automatically.

> **Status: beta, not audited.** Live on Monad mainnet with real USDC, and run by a single trusted relay. Bond only what you can afford to lose. See the [threat model](audit/THREAT_MODEL.md) and [Known limits](#known-limits).

[![tests](https://github.com/j-6-z/surety/actions/workflows/test.yml/badge.svg)](https://github.com/j-6-z/surety/actions/workflows/test.yml) ![contract coverage](https://img.shields.io/badge/contract%20coverage-100%25-brightgreen) ![invariants](https://img.shields.io/badge/invariants-7%20passing-brightgreen) ![mutation check](https://img.shields.io/badge/planted%20bugs%20caught-43%2F43-brightgreen) ![slither](https://img.shields.io/badge/slither-0%20high-brightgreen)

| | Mainnet | Testnet |
| --- | --- | --- |
| Network | Monad (chain ID 143) | Monad Testnet (chain ID 10143) |
| SuretyVault | `0x8b8d4a18D9abB59Cc499c62DC46032A1AbB95415` | `0xf3F9e32De47a143149F7398f25f264b98a01273C` |
| Settlement asset | USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | Test USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| Site | https://www.surety.buzz | |

The testnet vault is an earlier build without the per-day refund limit.

## Security and testing

The contract has not been independently audited. This is what has been done instead, and how to check each claim yourself.

| Check | Result | Run it |
| --- | --- | --- |
| Coverage of `SuretyVault.sol` | 100% of lines, statements, branches and functions | `npm run coverage:sol:check` |
| Invariants | 7 properties, each held over 256 random sequences of 100 calls | `npm run test:sol` |
| Fuzz properties | 8, each over 1,000 random inputs | `npm run test:sol` |
| Unit tests | 15, one for every way the vault refuses a call | `npm run test:sol` |
| Mutation check | 43 bugs planted one at a time (18 in the vault, 25 cross-chain), 43 caught | `npm run test:mutants` |
| Cross-chain contracts | 30 more tests, 100% coverage, delivery in any order fuzzed ([details](CROSSCHAIN.md)) | `npm run test:sol` |
| Static analysis | Slither: 0 high, 1 medium (false positive), 4 low (accepted) | `slither .` |
| Relay, x402, kit, guard, site and scripts | 131 JavaScript tests | `npm test` |

The invariants, in plain words:

1. The vault's USDC balance always equals the sum of every bond and every backer's stake. It can never owe more than it holds.
2. That balance also equals everything that came in minus everything that went out, counted independently.
3. All backers together can never withdraw more than their provider's backing holds.
4. Share totals add up, and nothing is queued for exit that is not there.
5. No rule is broken along the way: the daily refund limit is never bypassed, a claim is never paid twice or by anyone but the arbiter, one claim never exceeds its cap, and exits respect the delay and the window.
6. The contract's running total of a day's refunds always matches an independent count.
7. The lifetime claim counters match the refunds really paid.

Read next: [threat model](audit/THREAT_MODEL.md) (17 attacks on the vault and 9 on the cross-chain contracts, what stops each, what is left over) and [static analysis notes](audit/SLITHER.md) (every finding and why it stands).

The Solidity tests are in `test/foundry`. The first run downloads Foundry by itself (`scripts/forge.js`), so nothing needs installing by hand. Every push runs all of it in [GitHub Actions](https://github.com/j-6-z/surety/actions): the JavaScript tests, the Solidity tests, a gate that fails if contract coverage drops below 100%, Slither, and the mutation check. The first badge above is live; the other four show the figures those checks enforce.

## Try it in two minutes

You need Node 18+ and any wallet holding a little Monad testnet USDC (free from https://faucet.circle.com). The call costs $0.001 and needs no gas.

```bash
git clone https://github.com/j-6-z/surety.git && cd surety
npm install --omit=dev
AGENT_KEY=0xYourTestnetKey node examples/call-api.js https://www.surety.buzz 0xbef73fc59e4FF99cB3395Ab0afe8CBD35C598292
```

On Windows PowerShell, set the key first with `$env:AGENT_KEY="0xYourTestnetKey"`.

You get the live MON price, read on-chain, with a verdict from the relay. If the call had come back slow or malformed, the provider's bond would have refunded you. No key at hand? These are free:

- https://www.surety.buzz/ describes the API
- https://www.surety.buzz/.well-known/surety.json is the SLA the provider is bonded against
- https://www.surety.buzz/trust/0xbef73fc59e4FF99cB3395Ab0afe8CBD35C598292 is its trust score

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
npm test          # 62 tests
npm run demo      # one healthy call, two refunded ones
```

`npm run gas` prints gas per vault operation. `npm run bench` measures how much time the relay adds to a call.

## What's in here

| Path | What it does |
| --- | --- |
| `contracts/SuretyVault.sol` | Bonds, backer staking, exit queue, claim payouts, protocol fee, pause |
| `contracts/crosschain/` | `SuretyBeacon` and `SuretyMirror`: a provider's bond status carried from Monad to Base over LayerZero V2 ([CROSSCHAIN.md](CROSSCHAIN.md)) |
| `verifier/relay.js` | The relay: forwards calls, checks them against the SLA, proves the payment on-chain, files claims, serves trust scores |
| `verifier/sla.js` | SLA document format and the checks |
| `verifier/payment.js` | Reads the x402 settlement receipt and confirms the USDC transfer on-chain |
| `verifier/netguard.js` | Refuses provider URLs that aren't https or that resolve to internal addresses |
| `sdk/index.js` | Agent client: `call()` and `trust()` |
| `marketdata/` | Surety Market Data API: the first bonded provider (see below) |
| `examples/` | A real x402-paid API and paying client (official x402 SDK), plus mocks for tests |
| `app.js`, `start.js` | Hosting entry points: Vercel, and an always-on server |
| `site/`, `content/`, `public/` | Shared nav, footer and theme; article sources; generated pages |
| `scripts/` | Deploy, local demo, testnet and API checks, host registration, gas and latency measurements |
| `test/` | Contract tests, a randomised invariant test, and end-to-end tests through the relay |

## For providers: the kit

The fastest way to become a bonded provider is the starter in [`kit/`](kit/): one file for your endpoints, one command to post the bond. It stands alone, so you can copy the folder out.

```
npx degit j-6-z/surety/kit my-api
cd my-api && npm install
npm start                                   # run it locally
npm run bond -- https://your-api.example    # list it and post the bond
npm run try -- https://your-api.example/v1/block
```

Walkthrough: [surety.buzz/kit](https://www.surety.buzz/kit/).

The same library is packaged for npm as `surety-provider` in [`packages/provider`](packages/provider), with a command line (`init`, `check`, `bond`, `try`) and TypeScript types. `kit/` carries a copy of its four library files so the starter works on its own; `npm run sync:kit` keeps them identical and a test fails if they drift.

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

**Spending limits.** `createGuard` caps what an agent can spend: per call, per day, and by provider (allowlist, bonded only, minimum trust score). It sits under your x402 client and refuses to send a payment that breaks a rule. See [`sdk/guard.js`](sdk/guard.js) and `examples/guarded-agent.js`.

```js
const guard = createGuard({ relayUrl, maxPerCall: "0.01", dailyBudget: "1", minTrustScore: 30 });
const payingFetch = wrapFetchWithPayment(guard.fetch, x402client);
```

It is a guardrail inside the agent's process, not a vault: it does not protect against a stolen key.

**Trust score v0 (0 to 100).** 0 if the provider is inactive. Otherwise 60 points for pass rate over paid calls (counted as 50% until the relay has seen 20) plus 40 points for committed cover, meaning bond and backing not queued for exit, with full marks at 10x the minimum bond.

## Vault rules

- A provider is active only while its bond, not counting any amount queued for exit, is at or above the minimum. Inactive providers are not covered.
- Bond and backing wait out an unbonding delay (7 days by default, always between 1 and 30) and stay slashable while they wait.
- A matured exit must be completed within 3 days or requested again, so nobody can hold an instant exit open.
- A single claim is capped at `maxClaimPayout` (5% of the minimum bond on a new vault). If cover runs short, the agent gets what is there and the protocol fee shrinks first.
- Claims against one provider stop for the UTC day once they reach `maxDailySlashBps` of its cover (20% on a new vault). The claim that crosses the line is still paid. `isCovered` turns false until the next day, and the relay reports the provider as uncovered. This bounds what a stolen arbiter key can take while the owner pauses the vault and replaces it. The testnet vault predates this limit.
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

`marketdata/` is a small paid API, built to be bonded on Surety itself. It reads Monad prices straight from Uniswap-V3-style pools on-chain, so there is no third-party data feed behind it, and sells each call over x402.

| Endpoint | Returns |
| --- | --- |
| `GET /v1/price/mon` | MON price in USD from the deepest WMON/USDC pool, with the pool address, its USDC depth and the block |
| `GET /v1/pool/:address` | Price both ways and token reserves for any V3-style pool |
| `GET /`, `/health`, `/.well-known/surety.json` | Free: description, health, and the SLA |

It refuses to quote from a pool holding under 1,000 USDC (`MIN_POOL_USDC`), and a call that ends in an error is never charged, because x402 only settles on success.

`npm run check:api` runs it locally with real Monad mainnet prices, bonds it on your testnet vault and buys two calls through the relay. `npm run api` starts it by itself; set `PAY_TO_ADDRESS` in `.env`.

Limits: it reads Uniswap V3 pools only, so liquidity that sits on other venues is not seen, and a spot pool price can be moved by a large trade. It is a demo provider, not a price oracle.

## Hosting it

The relay and the Market Data API run together behind one address. Two ways to host them:

**Vercel.** `app.js` exports the combined Express app, which Vercel deploys with no extra config. In the project settings add `PRIVATE_KEY`, `VAULT_ADDRESS` and `PUBLIC_URL` (the production https address, no trailing slash). After the first deploy, run once from your own machine:

```bash
node scripts/set-host.js https://<your-domain>
```

That checks the deployment and points your on-chain provider record at it.

**An always-on server** (Render, Railway, a VPS). `npm start` listens on `PORT` and registers itself at boot. `render.yaml` is a ready blueprint; set `VAULT_ADDRESS` and `PRIVATE_KEY` in the host's dashboard.

Either way, `PRIVATE_KEY` is a testnet-only wallet that is the vault's arbiter and the provider. Set it in the host's dashboard, never in a file.

**The homepage and its demo.** A browser opening the address gets a homepage whose main feature is a live demo: two buttons that each run a real paid call through the relay, paid by the server's own wallet. One buys the price and passes. The other calls `/v1/demo/slow`, an endpoint built to miss its promise, so visitors watch the bond refund it on-chain. (`demo.js`, `marketdata/landing.js`.)

Each demo run spends real testnet funds from the server wallet: $0.001 per call, plus a 5% fee from the bond on each refund. To keep that in check, fresh runs are spaced out (8 seconds for the good call, 45 for the slow one), capped per day, and the slow demo stops before the bond gets within 0.01 USDC of its minimum. When a limit is hit, the page shows the most recent run and says so. Top up the wallet's test USDC and the bond now and then.

**Articles and search.** `npm run build` (`scripts/generate.js`) turns the Markdown files in `content/articles/` into pages under `public/articles/`, and writes `sitemap.xml`, `rss.xml` and `robots.txt`. Every page gets a canonical link, link-preview tags and schema.org data. Vercel runs it on each deploy. To publish, add a `.md` file with a `title`, `description` and `date` header and push. `draft: true` keeps a file out.

An article dated in the future is held back until that day. A daily job (`/cron/publish`, set up in `vercel.json`) triggers a rebuild when one comes due. It needs two settings on the host: `CRON_SECRET` (any long random string) and `DEPLOY_HOOK_URL` (a Vercel Deploy Hook). Without them the job does nothing.

**Self-serve bonding.** `/bond/` lets a provider list an API and post its bond from the browser with their own wallet: check the SLA document, connect, list, bond, and later queue a withdrawal. The page loads no crypto library. The server validates the SLA, reads the account from the chain and builds each transaction (`site/bond-api.js`); the wallet only signs. The homepage also has a provider lookup that shows any provider's record and the address agents should call.

Standing pages (How it works, Docs, FAQ) are Markdown files in `content/pages/` and build the same way; the FAQ also emits question-and-answer data for search engines. The provider directory at `/providers/` is live: it lists this server's own provider, any address in the `DIRECTORY_PROVIDERS` setting (comma-separated), and any provider the relay has served, each with its record read from the vault.

The shared navigation (with a collapsing menu on phones), footer and page head live in `site/`.

Things to know:

- **Cold starts count against you.** A host that has gone idle answers its first call slowly, and a slow paid call is refunded from your bond.
- **Call history is kept on local disk.** On serverless hosts that disk is temporary, so pass rates in the trust score reset whenever the function restarts. On-chain numbers (bond, claims paid) are unaffected.
- **One relay instance at a time.** Claims are sent in order within one process. Several instances sharing one arbiter key can collide.

Once it is up, anyone can try it with their own wallet and a little testnet USDC:

```bash
AGENT_KEY=0x... node examples/call-api.js https://<your-host> <providerAddress>
```

## Across chains

Bonds live on Monad; most x402 payments happen elsewhere. `SuretyBeacon` reads the vault and sends a provider's status over LayerZero V2 to `SuretyMirror` on Base, where a contract or agent can call `isCovered(provider)` before paying. Anyone can trigger a report; nobody can change what it says. Live on mainnet: beacon `0xf25b3F37a50fd9f938C836A8926ECC7786F958fe` on Monad, mirror `0x0593c77e43704C2a3f8512f3a4645ce57860FBED` on Base. Design, trust assumptions, limits and commands are in [CROSSCHAIN.md](CROSSCHAIN.md).

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
