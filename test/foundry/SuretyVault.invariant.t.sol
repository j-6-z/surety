// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {Handler} from "./Handler.sol";
import {SuretyVault} from "../../contracts/SuretyVault.sol";
import {MockUSDC} from "../../contracts/test/MockUSDC.sol";

/// @notice Properties that must hold after ANY sequence of actions by providers, backers,
///         the arbiter, the owner and strangers. Foundry runs thousands of random sequences
///         through Handler and checks every property after every step.
contract SuretyVaultInvariants is Base {
    SuretyVault internal vault;
    MockUSDC internal usdc;
    Handler internal handler;

    function setUp() public {
        (vault, usdc) = deployVault(1 * USDC, 7 days, 500);
        handler = new Handler(vault, usdc);
        vm.warp(1_800_000_000);
    }

    /// @dev Tells Foundry to fuzz the handler only (never the vault or the token directly).
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function _provider(uint256 i) private view returns (address p, P memory r) {
        p = handler.providers(i);
        r = read(vault, p);
    }

    /// The vault holds exactly what its books say it owes. Not a unit more, not a unit less.
    function invariant_solvent_booksMatchBalance() public view {
        uint256 owed;
        for (uint256 i = 0; i < 3; i++) {
            (, P memory r) = _provider(i);
            owed += uint256(r.bond) + r.backingAssets;
        }
        check(usdc.balanceOf(address(vault)) == owed, "vault balance != sum of bonds and backing");
    }

    /// The same balance, reached a second way: everything that came in minus everything that left.
    function invariant_conservation_inMinusOut() public view {
        check(usdc.balanceOf(address(vault)) == handler.totalIn() - handler.totalOut(), "vault balance != in - out");
        check(usdc.balanceOf(AGENT) == handler.paidToAgents(), "agent holds something other than its refunds");
        check(usdc.balanceOf(TREASURY) == handler.paidInFees(), "treasury holds something other than fees");
    }

    /// It can never pay out more than it holds: the claims of everyone combined fit inside the balance.
    function invariant_cannotOwePastItsBalance() public view {
        for (uint256 i = 0; i < 3; i++) {
            (address p, P memory r) = _provider(i);
            uint256 claimable;
            for (uint256 j = 0; j < 4; j++) claimable += vault.backerAssets(p, handler.backers(j));
            check(claimable <= r.backingAssets, "backers could withdraw more than the provider's backing holds");
        }
    }

    /// Share bookkeeping adds up, and nothing is queued for exit that is not there.
    function invariant_sharesAndQueuesAddUp() public view {
        for (uint256 i = 0; i < 3; i++) {
            (address p, P memory r) = _provider(i);
            check(r.bondPendingWithdraw <= r.bond, "more bond queued for exit than exists");
            uint256 held;
            uint256 queued;
            for (uint256 j = 0; j < 4; j++) {
                address b = handler.backers(j);
                uint256 mine = vault.backerShares(p, b);
                (uint256 q,) = vault.pendingUnstake(p, b);
                check(q <= mine, "a backer queued more shares than they hold");
                held += mine;
                queued += q;
            }
            check(held == r.backingShares, "sum of backer shares != total shares");
            check(queued == r.backingSharesPending, "sum of queued shares != total queued");
        }
    }

    /// The daily refund limit cannot be bypassed, a claim cannot be paid twice, only the arbiter
    /// can pay, and exits respect the delay and the window. (Each is checked as it happens.)
    function invariant_noRuleBrokenAlongTheWay() public view {
        check(bytes(handler.broken()).length == 0, handler.broken());
    }

    /// The contract's own running total for today never disagrees with the fuzzer's.
    function invariant_dailyTotalMatchesIndependentTally() public view {
        uint256 day = block.timestamp / DAY;
        uint256 bps = vault.maxDailySlashBps();
        for (uint256 i = 0; i < 3; i++) {
            address p = handler.providers(i);
            (uint32 d, uint112 slashed, uint112 startCover) = vault.dailySlash(p);
            uint256 limit = (uint256(startCover) * bps) / BPS;
            if (bps != BPS && d == day && handler.seenOn(p, day) && slashed != 0) {
                check(slashed == handler.slashedOn(p, day), "the vault's count of today's refunds is wrong");
                // Today's total can pass the limit only by the single claim that crossed it.
                check(slashed <= limit + handler.largestSingleTake(), "today's refunds exceed the limit by more than one claim");
            }
            // What the vault reports as still payable today is never more than the limit itself.
            uint256 ceiling = (bps != BPS && d == day) ? limit : (vault.coverOf(p) * bps) / BPS;
            check(vault.dailyAllowance(p) <= ceiling, "dailyAllowance exceeds the daily limit");
            if (vault.isCovered(p)) check(vault.isActive(p), "isCovered without isActive");
        }
    }

    /// Lifetime counters only ever describe refunds that were really paid.
    function invariant_claimCountersAreHonest() public view {
        uint256 count;
        uint256 sum;
        for (uint256 i = 0; i < 3; i++) {
            (, P memory r) = _provider(i);
            count += r.claimCount;
            sum += r.claimsPaid;
        }
        check(count == handler.paidCount(), "claimCount != number of refunds paid");
        check(sum == handler.paidToAgents(), "claimsPaid != USDC refunded to agents");
    }
}
