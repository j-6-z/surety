# Surety under Monad's parallel execution

Monad runs the transactions of a block at the same time. This is a measurement of how well Surety's contracts fit that, what stops them, and what a version that fits would look like.

Short version: **in a block of Surety transactions, every one after the first has to be run twice**, and the cause is not Surety's own storage. It is two USDC balances that every transaction touches. A design with one escrow per provider removes it completely.

## The rule being measured

Monad executes optimistically. Each transaction runs against the state as it was at the start, and records every storage slot it read and the value it saw. Results are then committed in block order. If a transaction read a slot whose value an earlier transaction changed, its result is discarded and it runs again. The outcome is always the same as running the block in order; what changes is how much work is done twice. ([Monad docs: parallel execution](https://docs.monad.xyz/monad-arch/execution/parallel-execution))

Two things follow for a contract author:

- Two transactions that touch different slots cost nothing extra, however many there are.
- A slot that many transactions read and change turns that part of the block back into a queue.

## Method

`scripts/parallel.js`, on a local chain, with the real `SuretyVault`:

1. From one starting state, run each transaction of a would-be block on its own and trace every `SLOAD`: contract, slot, value seen. Those are its inputs.
2. Run the same transactions in order. Before each, compare its inputs with the state as it now stands. If any changed, Monad would have re-executed it.

Each block is ordinary traffic: every provider is already bonded and has been refunded against once, so nothing measured is a first-ever write.

```
npm run bench:parallel              # blocks of 10
BLOCK_SIZE=50 npm run bench:parallel
```

`test/parallel.test.js` pins the results below, so they cannot drift from the code.

## Results

Blocks of 10 transactions.

| Block | Run twice | Why |
| --- | --- | --- |
| 10 bond deposits, each from a different provider | 9 of 10 | USDC balance of the vault |
| 10 backers staking, each behind a different provider | 9 of 10 | USDC balance of the vault |
| 10 refunds, each against a different provider | 9 of 10 | USDC balance of the vault; USDC balance of the treasury |
| 10 refunds, all against one provider | 9 of 10 | The provider's record and daily count, plus the two balances above |
| Probe: pooled custody, a refund per provider | 9 of 10 | USDC balance of the pool; USDC balance of the treasury |
| Probe: one escrow per provider, a refund per provider | **0 of 10** | Nothing shared |

The figure is always "all but the first", at any block size.

## What this says

**The vault's own storage is already parallel.** Each provider's record, daily refund count and claim ids live in their own slots. Refunds against ten different providers share no vault storage at all.

**The token is the bottleneck.** The vault holds everyone's USDC in one address, so `balanceOf[vault]` inside the USDC contract is one slot that every deposit, stake and refund changes. Refunds also pay the fee to the treasury each time, which makes `balanceOf[treasury]` a second one. This is the cost of pooled custody, and any pool-shaped contract has it.

**The re-entrancy lock is not a problem.** It is written twice in every call, but it ends at the value it started with, and Monad compares values. It never shows up as a conflict.

**One relay key is a queue of its own.** Every refund is sent by the same arbiter address, so they are ordered by that account's nonce whatever the storage looks like. Fixing storage alone would not make refunds parallel.

**One escrow per provider fixes the storage side.** The second probe gives each provider its own small contract that holds its USDC and counts fees owed, to be collected later in one go. Ten refunds against ten providers then share nothing: 0 of 10 re-executed.

## What a parallel-friendly vault would change

1. **An escrow per provider** (a minimal clone), so each bond is its own balance in the token.
2. **Fees accrued, not transferred.** Count the fee inside the escrow and sweep to the treasury periodically.
3. **More than one relay key**, or claims that anyone can submit with the relay's signature, so refunds are not tied to one account's nonce.

None of this is done. The deployed vault is unchanged, and at today's volume, a handful of transactions a day, it would make no observable difference. It is the design note for a second version, written down while the measurement is fresh.

## Limits of this measurement

- **It models the rule; it does not time a Monad node.** Re-execution happens inside the node and is not visible from outside, so no wall-clock figure from a public network would show it. This counts how often it would happen and why.
- **Run twice is not twice as slow.** Monad's documentation says re-execution is usually cheap because the inputs are already in memory. How much it costs in practice depends on the node and the load.
- **Storage only.** Inputs here are `SLOAD`s. Account balances and nonces are also state: the same-sender point above is noted, not traced. The value an `SSTORE` overwrites is not counted as an input.
- **A test token.** Real USDC is a proxy with extra checks, which adds shared reads (the implementation address, pause and blocklist flags) but those do not change between transactions, so they do not conflict.
- **The probes are not products.** `contracts/test/ParallelProbes.sol` has no access control and exists only for this comparison.
