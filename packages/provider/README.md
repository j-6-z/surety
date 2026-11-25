# surety-provider

Launch a paid [x402](https://www.x402.org) API on Monad with a bond behind it. When one of your paid calls comes back slow or in the wrong shape, the caller is refunded on-chain from your bond. That is a reason for an AI agent to pick your API over one with nothing at stake.

```
npm install surety-provider
```

```js
const { serve } = require("surety-provider");

serve({
  payTo: "0xYourWallet",
  endpoints: [{ path: "/v1/hello", maxLatencyMs: 4000, handler: () => ({ hello: "world" }) }],
});
```

That is a working paid API. It charges $0.001 per call over x402, and publishes the promise it will be held to at `/.well-known/surety.json`.

**Status: beta.** Runs on Monad testnet by default and on Monad mainnet with one setting. The Surety vault contract has not been independently audited. Read the [threat model](https://github.com/j-6-z/surety/blob/main/audit/THREAT_MODEL.md) before bonding real money.

## From nothing to bonded

```
npx surety-provider init my-api
cd my-api
npm install
```

1. Copy `.env.example` to `.env` and set `PAY_TO_ADDRESS` to the wallet your payments should land in.
2. Edit the endpoints in `app.js`.
3. `npm start`, then `npm run check` to time every endpoint against its own promise. No payment involved.
4. Host it. It runs on Vercel as it is. Set `PAY_TO_ADDRESS` and `PUBLIC_URL` on the host.
5. Put a wallet key in `.env` as `PRIVATE_KEY`, then `npm run bond -- https://your-api.example`.
6. `npm run try -- https://your-api.example/v1/shout/hello` makes one real paid call through the relay.

Your wallet key stays on your own computer. The hosted API never needs it.

## An endpoint

```js
{
  method: "GET",                       // default
  path: "/v1/pool/:address",
  price: "$0.002",                     // default: the API's price
  maxLatencyMs: 4000,                  // THE PROMISE: answer within this
  responseSchema: { /* JSON Schema */ },// THE PROMISE: in this shape
  example: "/v1/pool/0xabc",           // a real call `check` can try
  validate: (req) => null,             // runs before payment; return a message to reject for free
  handler: async (req) => ({ /* … */ }),// THE WORK
}
```

Four rules that save you money:

- **The clock includes payment.** `maxLatencyMs` covers the whole call, and settling the payment takes a second or more. Promise what you can keep.
- **The library gives up before you pay for being late.** A handler still running with 2 seconds of its promise left is cut off with a 504. The caller is not charged, so nothing comes out of your bond. Change the margin with `settleReserveMs`, or set `guard: false` on an endpoint.
- **Throwing is free for the caller.** A handler that throws answers with an error and charges nobody.
- **`validate` runs before payment.** Reject bad input there so nobody pays for a typo.

## API

| Function | What it does |
| --- | --- |
| `serve(options, { port, host })` | `createBondedApi` and listen. Reads `PORT`, `PAY_TO_ADDRESS` and the public address from the environment |
| `createBondedApi(options)` | Builds the Express app and the SLA document. Returns `{ app, sla, listen, close, endpoints, run }` |
| `check(api)` / `report(api)` | Runs every handler a few times, unpaid, and compares it with its promise |
| `bond({ url, wallet, amount })` | Lists a hosted API on the vault and tops its bond up. Approves exactly what it deposits |
| `tryCall({ suretyUrl, provider, path, privateKey })` | One real paid call through the relay, with the verdict |
| `publicUrlFromEnv()`, `networkFromEnv()` | The settings below, resolved |

Options for `createBondedApi` and `serve`: `name`, `description`, `payTo`, `endpoints`, `price`, `publicUrl`, `settleReserveMs`, and `network`, `usdc`, `facilitatorUrl` if you need to override the network profile. Types are included.

## Command line

```
surety-provider init [folder]        start a new bonded API
surety-provider check [file]         time every endpoint against its promise (default file: ./app.js)
surety-provider bond <url> [usdc]    list your hosted API and post its bond (default: the minimum)
surety-provider try <endpoint-url>   one real paid call through the relay
```

`check` needs your file to export what `createBondedApi` returned: `module.exports.api = api`.

## Settings

| Variable | Where | What |
| --- | --- | --- |
| `PAY_TO_ADDRESS` | host and local | The wallet payments land in |
| `PUBLIC_URL` | host | Your https address, no slash at the end. Vercel, Render and Railway are detected if you leave it out |
| `SURETY_NETWORK` | host and local | Leave out for Monad testnet. `mainnet` for real USDC |
| `PRIVATE_KEY` | local only | The wallet that posts the bond. Never put it on the host |
| `SURETY_URL` | local | The relay to join. Default `https://www.surety.buzz` |

## What Surety checks, and what it does not

The relay checks three things about each paid call: the status code, the time taken, and the shape of the JSON. It does not judge whether your answer was *good*. One relay, run by the Surety project, makes that call today, and its verdict moves money out of your bond.

On the current mainnet vault, one refund is capped at 5% of the minimum bond, and refunds against one provider stop for the day at 20% of its cover. A call priced above the first cap cannot be refunded.

MIT licence. Source and issues: https://github.com/j-6-z/surety
