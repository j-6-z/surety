---
title: Provider kit
description: Launch your own paid x402 API on Monad with a bond behind it. One file for your endpoints, one command to post the bond. Testnet, about ten minutes.
nav: kit
order: 4
---

The kit is a small starter project. You describe your endpoints in one file. It handles the x402 paywall, publishes the promise Surety checks your calls against, and one command posts your bond. Everything runs on Monad testnet with test USDC.

## What you need

- [Node.js](https://nodejs.org) 18 or newer
- A testnet-only wallet with a little MON for fees and a few test USDC for the bond
- Somewhere to host a Node app. The kit runs on Vercel as it is

## 1. Get the kit

```
npx degit j-6-z/surety/kit my-api
cd my-api
npm install
```

No `degit`? Download the [repository](https://github.com/j-6-z/surety) and copy the `kit` folder out. It does not depend on anything else in there.

## 2. Describe your endpoints

Open `app.js`. Each endpoint has a promise and a handler:

```js
{
  method: "GET",
  path: "/v1/block",
  description: "Latest Monad block number and time",
  maxLatencyMs: 4000,              // the promise: answer within this
  responseSchema: { /* JSON Schema: the shape you promise */ },
  handler: async (req) => ({ block: 123, timestamp: "…" }),  // the work
}
```

Three things to know:

- **The clock includes payment.** Settling an x402 payment takes about 1.5 seconds on Monad testnet, and `maxLatencyMs` covers the whole call. Promise what you can keep.
- **The kit gives up before you pay for being late.** If a handler is still running with 2 seconds of its promise left, the kit answers with an error instead. The caller is not charged, so nothing comes out of your bond.
- **Throwing is free for the caller.** If your handler throws, the call answers with an error and nobody is charged.
- **`validate` runs before payment.** Use it to reject bad input so nobody pays for a typo.

## 3. Run it locally

```
copy .env.example .env
```

Set `PAY_TO_ADDRESS` in `.env` to the wallet your payments should land in, then:

```
npm start
```

Open `http://127.0.0.1:4021/.well-known/surety.json`. That document is your promise, generated from `app.js`.

Then find out whether you can keep it:

```
npm run check
```

This runs every handler a few times, with no payment involved, and compares the slowest run and the shape of the answer with what you promised. Fix anything marked `FAIL` before you bond. An endpoint with a `:parameter` in its path needs an `example` so the check has a real call to try.

## 4. Host it

Push the folder to GitHub and import it into Vercel, or use any Node host. Set two settings on the host:

| Setting | Value |
| --- | --- |
| `PAY_TO_ADDRESS` | The wallet your payments land in |
| `PUBLIC_URL` | Your final https address, with no slash at the end |

Your wallet key does not go on the host. The hosted API never needs it.

## 5. Post your bond

On your own computer, put the wallet key in `.env` as `PRIVATE_KEY`, then:

```
npm run bond -- https://your-api.example
```

This checks your API is reachable, has Surety confirm it can read your promise, lists you on the vault, and deposits the minimum bond. It approves exactly the amount it deposits. To bond more, add the total you want in USDC: `npm run bond -- https://your-api.example 5`.

Run it again whenever your address changes. It only sends the transactions that are needed.

## 6. Prove it

```
npm run try -- https://your-api.example/v1/block
```

That makes one real paid call through the relay and prints the verdict. You are now in the [provider directory](/providers/), and agents call you at:

```
https://www.surety.buzz/call/<your wallet address>/v1/block
```

## Getting your bond back

Withdrawals are queued, then released after the vault's waiting period. Your calls stop being covered as soon as a queued withdrawal takes you under the minimum. Use the [bond page](/bond/) with the same wallet to withdraw.

## What this is today

Testnet only, unaudited, and one relay run by Surety decides whether a call met its promise. Checks are objective: status code, response time, and response shape. Whether your answer was *good* is not something Surety judges. Use a wallet that holds nothing you care about.
