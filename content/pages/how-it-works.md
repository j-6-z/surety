---
title: How Surety works
description: Three roles, one promise, and a bond that pays out when the promise is broken. The whole system in about two minutes.
nav: how
order: 1
---

Surety sits between an AI agent and a paid API. It doesn't move the payment and it doesn't change the API. It watches the call, and when the provider breaks its own promise, it pays the agent back from money the provider locked up in advance.

## The three roles

**The provider** runs a paid API. It publishes what it promises (how fast, and in what shape) and locks up a bond in USDC as its guarantee.

**The agent** is any program paying for API calls with x402. It calls the provider through Surety and pays exactly as it does today.

**The backer** is anyone who adds their own money behind a provider they trust. Backing is optional, shows up in the provider's record, and is at risk if the provider fails badly enough to exhaust its own bond.

## One call, start to finish

1. **The agent calls the provider through Surety's relay.** The request and its x402 payment pass through untouched.
2. **The relay times the response.** It records the status code, how long the answer took, and what the answer looked like.
3. **The relay compares that with the provider's promise.** Was it a success status? Was it within the promised time? Did the answer have the promised shape?
4. **If the promise was kept, nothing else happens.** The provider keeps the payment.
5. **If the promise was broken, the relay checks the payment on-chain.** It confirms the agent's money really reached the provider.
6. **The vault refunds the agent from the provider's bond.** The agent gets back what it paid. Nobody files a claim or waits for a decision.

You can watch steps 1 to 6 happen for real in the [demo on the homepage](/#demo).

## What gets checked, and what doesn't

Surety only checks things a machine can settle without an argument:

- **Status:** did the API answer with a success code?
- **Speed:** did the full answer arrive within the promised time?
- **Shape:** is the answer valid JSON with the promised fields?

It never judges whether an answer was correct or useful. "The price was wrong" is not something a contract can rule on fairly, so it is out of scope.

## Why the bond can be trusted

A guarantee is worthless if the money can disappear the moment a claim is coming. Three rules prevent that:

- **Exits are slow.** Withdrawing a bond takes 7 days by default, and the money can still be used for refunds while it waits.
- **Exits are visible.** Money queued for withdrawal stops counting toward the provider's active status immediately, so agents see a provider leaving before it has left.
- **Exits expire.** A withdrawal that is ready must be completed within 3 days or requested again.

## What a refund costs the provider

The agent is refunded exactly what it paid. On top of that, a 5% protocol fee is taken from the bond. Once a provider's bond falls under the minimum, its calls stop being covered until it tops up.

## Where things stand

Surety runs on Monad testnet with test funds. One relay, run by one developer, does the checking. The contracts are tested but not audited. Read the [FAQ](/faq/) for the plain answers, the [docs](/docs/) if you want to build against it, or the [source](https://github.com/j-6-z/surety).
