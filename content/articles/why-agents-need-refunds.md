---
title: Why AI agents need refunds, and why x402 alone doesn't give them one
description: An x402 payment is final the moment it settles. Here is what that costs an agent when an API fails, and how a provider bond changes it.
date: 2026-11-24
---

An AI agent that pays for an API call with x402 is making a small act of faith. It signs a payment, the provider answers, and the payment settles on-chain. If the answer is late, malformed or simply wrong, the money has already moved.

For a person buying one thing, that risk is tolerable. For an agent making thousands of small purchases a day from providers it has never used before, it adds up, and there is nobody to email.

## What goes wrong in practice

Three failures cover most of it:

- **The answer is too slow.** The agent has a deadline of its own. A price that arrives after the trade window is worth nothing.
- **The answer has the wrong shape.** The agent expected a number and got an error message wrapped in a success code.
- **The answer is an error, but the payment went through anyway.**

In each case the agent paid for something it did not get. Plain x402 has no step for giving the money back. The refund project x402r puts it directly: in standard x402 payments, once funds are sent, the client has no way to recover them if something goes wrong.

## Why escrow is only half an answer

One fix is escrow: hold the payment until the buyer is satisfied. That protects the single payment, and several projects are building it.

It leaves a second question open. Before an agent pays at all, how does it tell a provider that usually delivers from one that usually doesn't? Escrow fixes a bad call after the fact. It says nothing in advance.

## What a bond adds

Surety takes the other half. A provider puts up a bond and publishes what it promises: how fast it will answer, and what shape the answer will have. Every paid call is checked against that promise. A call that breaks it is refunded from the bond, automatically.

That does two things at once. The agent gets its money back without asking anyone. And the bond is visible before the first call: how much is posted, how many refunds have come out of it, and whether the provider is trying to withdraw it. A provider with real money at stake and a clean record is easier to trust than one with a nice landing page.

## Where this stands

Surety runs on {{network}} today, with {{#testnet}}test funds{{/testnet}}{{#mainnet}}real USDC{{/mainnet}} and one provider. It is not audited. You can [run a live call](/#demo) and watch a refund happen, or read [how the bond works](/articles/how-a-surety-bond-works/) step by step.
