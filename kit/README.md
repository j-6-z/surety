# Surety provider kit

A paid x402 API on Monad with a bond behind it. You write the endpoints; the kit handles the paywall, publishes your promise, and posts your bond. Monad testnet by default, mainnet with one setting.

Full walkthrough: https://www.surety.buzz/kit/

## Quick start

```
npm install
copy .env.example .env        (macOS/Linux: cp .env.example .env)
```

1. Set `PAY_TO_ADDRESS` in `.env` to the wallet your payments should land in.
2. Edit the endpoints in `app.js`.
3. `npm start`, then open http://127.0.0.1:4021/.well-known/surety.json to see your promise.
   `npm run check` times every endpoint against its promise, with no payment involved.
4. Host it (Vercel works as is). Set `PAY_TO_ADDRESS` and `PUBLIC_URL` on the host.
5. Put a testnet wallet key in `.env` as `PRIVATE_KEY`, then `npm run bond -- https://your-api.example`
6. `npm run try -- https://your-api.example/v1/block` makes one real paid call through the relay.

## Files

| File | What it is |
| --- | --- |
| `app.js` | Your endpoints. The only file you need to edit |
| `surety.js` | The paywall and the SLA document. Leave it alone |
| `check.js` | Times every endpoint against its own promise, before any money is involved |
| `bond.js` | Lists your API on the vault and posts the bond |
| `try.js` | One paid call through the relay, with the verdict |

## Rules that will save you money

- `maxLatencyMs` covers the whole call, including about 1.5 seconds of payment settlement. A promise you miss is a refund out of your bond, plus a 5% fee.
- A handler still running with 2 seconds of its promise left is cut off with an error. The caller is not charged, so being slow costs you a sale and nothing from your bond. Change the margin with `settleReserveMs`, or set `guard: false` on an endpoint.
- A handler that throws answers with an error and charges nobody. Throw when you cannot answer properly.
- `validate` runs before payment. Reject bad input there.
- On mainnet one refund is capped at 5% of the vault's minimum bond. Price a call above that and it cannot be refunded, which agents can see.
- `PRIVATE_KEY` stays on your computer. Never put it on the host, never commit `.env`.

Runs on Monad testnet by default. Set `SURETY_NETWORK=mainnet` (in `.env` and on your host) for real USDC. The vault contract is unaudited, so use a wallet that holds nothing you can't afford to lose.
