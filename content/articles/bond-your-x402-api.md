---
title: How to bond your x402 API on Surety
description: A walkthrough for API providers: write the SLA document, register on the vault, post a bond, and let agents call you through the relay.
date: 2026-11-24
---

{{#testnet}}
If you run an API that takes x402 payments on Monad testnet, you can bond it on Surety in about fifteen minutes. This costs nothing real: everything uses test USDC.

You need a wallet with a little testnet MON for gas and about 1 testnet USDC for the bond. The [Monad faucet](https://faucet.monad.xyz) gives MON, and the [Circle faucet](https://faucet.circle.com) gives USDC (choose USDC, then Monad Testnet).
{{/testnet}}
{{#mainnet}}
If you run an API that takes x402 payments on Monad, you can bond it on Surety in about fifteen minutes. The bond is real USDC, and the vault contract has not been audited, so bond only what you can afford to lose.

You need a wallet with a little MON for gas and at least {{minBond}} USDC for the bond.
{{/mainnet}}

## 1. Write your SLA document

Create a JSON file describing what you promise, and host it at an https address you control:

```json
{
  "version": 1,
  "baseUrl": "https://api.example.com",
  "payTo": "0xYourPaymentWallet",
  "endpoints": [
    {
      "method": "GET",
      "path": "/v1/quote",
      "maxLatencyMs": 3000,
      "responseSchema": { "type": "object", "required": ["price"] }
    }
  ]
}
```

`payTo` must be the wallet your x402 payments settle to. `maxLatencyMs` is measured from the relay and includes the time the payment takes to settle, so leave room. Settlement alone has taken around a second.

Paths can include a parameter, such as `/v1/pool/:address`.

## 2. Register and post the bond

The vault is at `{{vault}}` on {{network}}. USDC is at `{{usdc}}`. With ethers:

```js
const vault = new ethers.Contract(VAULT, [
  "function register(string metadataURI)",
  "function depositBond(uint256 amount)",
], wallet);
const usdc = new ethers.Contract(USDC, ["function approve(address,uint256)"], wallet);

await (await vault.register("https://api.example.com/sla.json")).wait();
await (await usdc.approve(VAULT, 600000n)).wait();   // 0.6 USDC
await (await vault.depositBond(600000n)).wait();
```

The minimum bond on this vault is {{minBond}} USDC{{#testnet}}, set low because the faucet only gives 1{{/testnet}}. Stay a little above it: each refund comes out of your bond, and under the minimum your calls stop being covered.

## 3. Send agents through the relay

Agents now call you at:

```
https://www.surety.buzz/call/<yourProviderAddress>/v1/quote
```

Nothing changes on your server. The relay forwards the request and the x402 payment as they are.

## 4. Check your record

```
https://www.surety.buzz/trust/<yourProviderAddress>
```

This shows your bond, whether you are active, refunds paid, and your trust score.

## Know what you are agreeing to

Surety is an experiment. One relay, run by one person, decides whether a call passed, and its decision moves money out of your bond. The checks are mechanical and the code is public, but you are trusting that operator. {{#testnet}}That is acceptable for test funds and a reason not to use this with real ones yet.{{/testnet}}{{#mainnet}}That is the main reason to keep your bond small while this is a beta.{{/mainnet}}

To leave, call `requestBondWithdraw`, wait out the delay, then `completeBondWithdraw`.

If you bond an API, [open an issue on GitHub](https://github.com/j-6-z/surety/issues) and say how it went. That feedback decides what gets built next.
