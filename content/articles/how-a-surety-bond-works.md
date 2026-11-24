---
title: How a Surety bond works, step by step
description: What a provider posts, what gets checked on every call, when the bond pays out, and the rules that stop a provider from dodging a claim.
date: 2026-11-24
---

A Surety bond is money a provider locks in a contract as a guarantee that its paid API will do what it says. This is the whole life of one, from posting to payout.

## 1. The provider makes a promise

The provider publishes a small document, the SLA, listing each paid endpoint with two things: the longest it may take to answer, and the shape a good answer has. For example: "`GET /v1/price/mon` answers within 4 seconds with a JSON object containing a price and a block number."

Only things a machine can check go in the SLA. Speed, status and shape. Never "was the answer good", because no contract can settle that fairly.

## 2. The provider posts a bond

The provider registers on the vault contract with a link to its SLA, then deposits USDC as its bond. Once the bond is at or above the minimum, the provider is active and its calls are covered.

Other people can add their own money behind a provider they trust. That backing is at risk too, and it shows up in the provider's record.

## 3. Agents call through the relay

An agent calls the provider through Surety's relay and pays with x402 exactly as usual. The relay passes the request and the payment through untouched, times the response, and compares it with the SLA.

## 4. A good call changes nothing

If the answer was on time and well-formed, the provider keeps the payment. The call counts toward its pass rate.

## 5. A bad call is refunded from the bond

If the answer broke the promise, the relay first confirms on-chain that the agent really paid. Then it tells the vault to pay the agent back the amount it paid, out of the provider's bond. A small protocol fee, 5% by default, is taken from the bond on top.

Each payment can be refunded once and only once. A call that was never paid for is never refunded.

## The rules that stop dodging

A bond is only worth something if it can't vanish when a claim is coming. Three rules handle that:

- **Withdrawals wait.** A provider must queue a withdrawal and wait 7 days by default. The queued money can still be taken for refunds the whole time.
- **Queued money stops counting.** The moment a provider queues its bond for exit, that money no longer counts toward being active. Agents see the exit before it happens.
- **A ready withdrawal expires.** It must be completed within 3 days or requested again, so nobody can keep an instant exit in their pocket.

## What to check before you trust a provider

Its record is public: bond size, refunds paid out, pass rate over paid calls, and a single trust score that combines them. You can see the first provider's on the [homepage](/), under the demo.

Surety is on {{network}} with {{#testnet}}test funds{{/testnet}}{{#mainnet}}real USDC, as a beta{{/mainnet}}, run by a single relay, and not audited. The [source is public](https://github.com/j-6-z/surety).
