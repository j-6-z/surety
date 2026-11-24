---
title: Surety FAQ
description: Straight answers about Surety. Whether it uses real money, who decides a call failed, what gets refunded, what it costs, and whether there is a token.
nav: faq
type: faq
order: 3
---

## What is Surety?

A way for AI agents to get their money back when a paid API fails them. API providers lock up a bond. Calls go through Surety's relay, which checks each one against what the provider promised. A call that breaks the promise is refunded from the bond, on-chain and automatically.

## Is this real money?

{{#testnet}}
No. Surety runs on Monad testnet, and every bond, payment and refund uses test USDC that has no value. Do not send real funds to anything connected with it.
{{/testnet}}
{{#mainnet}}
Yes. Surety runs on Monad mainnet, and every bond, payment and refund is real USDC. It is a beta: the contract has not been audited, and you should bond only what you can afford to lose.
{{/mainnet}}

## Has it been audited?

No. The contracts have a test suite, including randomised tests that check the vault's books always match its balance, but nobody independent has reviewed them. {{#testnet}}That is one of the reasons it stays on testnet.{{/testnet}}{{#mainnet}}That is why the minimum bond is small ({{minBond}} USDC) and why a single refund can never take more than that.{{/mainnet}}

## Who decides whether a call failed?

A relay, currently a single one run by the developer of Surety. It only makes mechanical checks: the status code, how long the answer took, and whether the answer has the promised shape. It never judges whether an answer was good. The rules and the code are public, but you are trusting that one operator, and that is a known weakness.

## What exactly gets refunded?

The amount the agent paid for that call, and only if the payment really happened. The relay confirms the payment on-chain before any refund. A call that was never paid for is never refunded, and one payment can only be refunded once.

## What does it cost?

Agents pay nothing extra. Providers pay a 5% protocol fee on each refund, taken from their bond on top of the refund itself. A provider that keeps its promises pays nothing.

## Can a provider pull its bond right before a refund?

No. Withdrawing takes 7 days by default, the money stays available for refunds during the wait, and a provider that queues a withdrawal is marked as not covered straight away.

## Is there a Surety token?

No. There is no Surety token or coin today. Anything being sold under that name is not from this project.

## Which payments does it work with?

x402 payments using the `exact` scheme, in USDC, on {{network}}.

## How do I list my API?

Publish an SLA document, register on the vault and post a bond. The walkthrough is in [how to bond your x402 API](/articles/bond-your-x402-api/), and the reference is in the [docs](/docs/).

## Who is behind it?

One independent developer, building in the open. The source is on [GitHub](https://github.com/j-6-z/surety) under the MIT licence.
