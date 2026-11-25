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
| High | 0 |
| Medium | 1 |
| Low | 4 |
| Informational | 9 |

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
