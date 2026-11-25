# Static analysis

**Tool:** Slither 0.11.6, run on `contracts/SuretyVault.sol` and `contracts/crosschain/` compiled with solc 0.8.24, optimizer on, EVM version cancun.

```
pip install slither-analyzer
slither .
```

Settings are in `slither.config.json`: dependencies, test contracts and test files are left out, and a high-severity finding fails the run.

## Result

| Severity | Count |
| --- | --- |
| High | 0 (one reported in stage two, reviewed and suppressed; see below) |
| Medium | 4 (1 vault, 3 stage two) |
| Low | 11 |
| Informational | 13 |

The sections below go contract by contract. The vault's own figures are unchanged: 1 medium, 4 low, 9 informational.

No finding led to a code change. The deployed contract is left byte-for-byte as it is on mainnet, so each finding is recorded here with the reason it stands.

## Medium

**`incorrect-equality` in `cancelUnstake`: `u.shares == 0`.** Not a vulnerability. Slither warns about strict equality because a balance compared with `==` can be pushed off its expected value by someone sending tokens. This value is a share count in the vault's own storage, written only by `requestUnstake`, `cancelUnstake` and `completeUnstake`. Nobody outside the contract can change it, and the comparison only asks "is anything queued?".

## Low

**`timestamp`, four places.** `_checkExitTime`, `dailyAllowance`, `_countTowardDailyLimit`, and `cancelUnstake` (the last is a false positive: the comparison there does not involve time).

Accepted by design. The unbonding delay is at least one day and the exit window is three, so a validator shifting a timestamp by seconds changes nothing that matters. The daily refund limit uses fixed UTC days; a claim within seconds of midnight could be counted in either day. That is listed as T17 in the threat model.

## Informational

**`naming-convention`, seven places.** Setter and constructor parameters start with an underscore (`_arbiter`, `_treasury`, ...). Style only.

**`unindexed-event-address`, two places.** `ArbiterSet` and `TreasurySet` carry an address that is not indexed. These events fire only when the owner changes a role, which is rare, and the current values are readable from `arbiter()` and `treasury()`. Worth indexing in a future version.

## Cross-chain contracts

Slither reports nothing of high or medium severity in `SuretyBeacon`, `SuretyMirror` or `CoverageCodec`. Five lower findings, none of which led to a change:

**`calls-loop`, low, two places** (`quote` and `broadcast`, through `_message`). The beacon calls the vault once per value per provider inside a loop. Slither warns because one reverting call would fail the whole batch. Here the callee is the vault's own view functions, which do not revert for any address, and the batch is capped at 20.

**`timestamp`, low, two places** (`isCovered` and `_fresh` in the mirror). Freshness is a comparison against block time by design. The window is at least a minute and an hour by default, so seconds of drift or validator nudging change nothing that matters.

**`naming-convention`, informational, one place.** `setMaxAge(_maxAge)`. Style only.

## Stage two: router and outpost

**`reentrancy-balance`, high, one place, reviewed and suppressed inline** (`payClaimRemote` in the router). The router reads its USDC balance, calls the vault, and reads the balance again to learn what the vault really paid. Slither flags any balance read on both sides of an external call, because a re-entrant call could change it in between. Here it cannot: the function holds a re-entrancy lock, the callee is the vault, and the vault calls nothing but the token. Measuring the delta is deliberate, since the vault pays less than asked when cover is short. The line carries a `slither-disable-next-line` comment with this reason, which is why the tool's own count shows 0 high.

**`incorrect-equality`, medium, two places.** `received == 0` in the router and `balance == 0` in `collect`. Both ask "is there anything at all?" about an amount, and neither is a gate an attacker gains from pushing off zero: sending the router or outpost USDC only gives money away.

**`reentrancy-no-eth`, medium, one place** (the outpost's receive path). `totalPaid` is updated after the token transfer, because the update depends on whether the transfer succeeded. The path holds the re-entrancy lock, only the endpoint can enter it, and USDC has no transfer hooks.

**Low and informational.** `calls-loop` twice and `reentrancy-benign` once (paying a batch is a loop of token calls by design; a refused transfer is caught, so one cannot fail the rest). `low-level-calls` once (the caught transfer). One `naming-convention`, one `unindexed-event-address` (`RelaySet`).

## Narrowing casts

`forge lint` (`npm run lint:sol`) flags five casts to `uint128`, and the same three timestamp comparisons Slither does. None of the casts can truncate:

| Where | Why it is safe |
| --- | --- |
| `requestBondWithdraw`: `uint128(amount)` | Checked on the line above: `amount <= p.bond`, and `bond` is a `uint128` |
| `completeUnstake`: `uint128(assets)` | `_toAssets` returns at most `backingAssets`, a `uint128` |
| `payClaim`: `uint128(payout)` | `payout` is capped at the provider's cover, which is real USDC inside the vault. All the USDC in existence is many orders of magnitude below the `uint128` range |
| `_slash`: `uint128(bond - fromBond)`, `uint128(fromBackers)` | Both are parts of amounts already held as `uint128` |
| Every amount coming in from outside | Goes through OpenZeppelin `SafeCast`, which reverts on overflow |

The invariant suite backs this up: across every random sequence, the vault's token balance equals the sum of its books exactly.
