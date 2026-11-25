// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {SuretyVault} from "../../contracts/SuretyVault.sol";
import {MockUSDC} from "../../contracts/test/MockUSDC.sol";

/// @notice Single-scenario properties, each run against a thousand random inputs.
contract SuretyVaultFuzz is Base {
    SuretyVault internal vault;
    MockUSDC internal usdc;

    address internal constant PROVIDER = address(0x9001);
    address internal constant ALICE = address(0xB001); // an honest backer
    address internal constant MALLORY = address(0xBAD); // an attacker

    function setUp() public {
        (vault, usdc) = deployVault(1 * USDC, 7 days, 500);
        for (uint160 i = 0; i < 3; i++) fund(usdc, vault, [PROVIDER, ALICE, MALLORY][i], 1e15);
        vm.prank(PROVIDER);
        vault.register("ipfs://sla");
        vm.warp(1_800_000_000);
    }

    function _open(uint256 maxClaim, uint16 dailyBps) private {
        vm.startPrank(OWNER);
        vault.setMaxClaimPayout(maxClaim);
        vault.setMaxDailySlashBps(dailyBps);
        vm.stopPrank();
    }

    /// A claim never takes more than the provider's cover, never pays the agent more than was
    /// asked, and the fee is the first thing to shrink when cover runs short.
    function testFuzz_claimNeverTakesMoreThanCover(uint256 bond, uint256 backing, uint256 payout, uint16 feeBps) public {
        bond = bound(bond, 0, 1e12);
        backing = bound(backing, 0, 1e12);
        payout = bound(payout, 1, 1e13);
        feeBps = uint16(bound(feeBps, 0, 1_000));
        vm.assume(bond + backing > 0);
        vm.prank(OWNER);
        vault.setParams(1 * USDC, 7 days, feeBps);
        _open(type(uint256).max, 10_000);
        if (bond > 0) {
            vm.prank(PROVIDER);
            vault.depositBond(bond);
        }
        if (backing > 0) {
            vm.prank(ALICE);
            vault.back(PROVIDER, backing);
        }
        uint256 cover = vault.coverOf(PROVIDER);
        vm.prank(ARBITER);
        vault.payClaim(keccak256("c"), PROVIDER, AGENT, payout, bytes32(0));

        uint256 toAgent = usdc.balanceOf(AGENT);
        uint256 toFee = usdc.balanceOf(TREASURY);
        uint256 fullFee = (payout * feeBps) / BPS;
        check(toAgent + toFee <= cover, "took more than cover");
        check(toAgent == (payout < cover ? payout : cover), "agent not paid the lesser of claim and cover");
        check(toFee == (payout + fullFee <= cover ? fullFee : cover - toAgent), "fee wrong when cover is short");
        check(vault.coverOf(PROVIDER) == cover - toAgent - toFee, "cover did not fall by what was paid");
        check(usdc.balanceOf(address(vault)) == vault.coverOf(PROVIDER), "books != balance");
        // The bond is always used up before any backer loses anything.
        if (toAgent + toFee <= bond) check(vault.backerAssets(PROVIDER, ALICE) + 1 >= backing, "backers slashed while bond remained");
    }

    /// In one day, refunds against a provider total at most the daily limit plus the one claim that crossed it.
    function testFuzz_dailyLimitHolds(uint256 bond, uint256 claim, uint16 dailyBps, uint8 attempts) public {
        bond = bound(bond, 1 * USDC, 1e11);
        dailyBps = uint16(bound(dailyBps, 1, 9_999));
        claim = bound(claim, 1, bond / 10 + 1);
        _open(claim, dailyBps);
        vm.prank(PROVIDER);
        vault.depositBond(bond);

        uint256 limit = (bond * dailyBps) / BPS;
        uint256 oneTake = claim + (claim * 500) / BPS;
        uint256 n = bound(attempts, 1, 60);
        bool refused;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(ARBITER);
            try vault.payClaim(keccak256(abi.encode(i)), PROVIDER, AGENT, claim, bytes32(0)) {
                check(!refused, "a claim was paid after one was refused the same day");
            } catch {
                refused = true;
                check(vault.dailyAllowance(PROVIDER) == 0, "refused while allowance remained");
                check(!vault.isCovered(PROVIDER), "still reported as covered after the limit");
            }
        }
        uint256 taken = bond - vault.coverOf(PROVIDER);
        check(taken <= limit + oneTake, "more than the limit plus one claim left in a day");
        // With room to spare in both the limit and the bond, every claim is paid in full.
        if (n * oneTake <= limit) check(!refused && taken == n * oneTake, "claims under the limit must be paid in full");

        // Next UTC day the limit starts again, measured from the smaller cover.
        vm.warp(block.timestamp + 1 days);
        uint256 cover = vault.coverOf(PROVIDER);
        check(vault.dailyAllowance(PROVIDER) == (cover * dailyBps) / BPS, "limit did not reset on the new day");
    }

    /// Topping up cover during the day does not raise that day's limit.
    function testFuzz_topUpCannotReopenTheDay(uint256 bond, uint256 topUp) public {
        bond = bound(bond, 1 * USDC, 1e10);
        topUp = bound(topUp, 1, 1e12);
        _open(bond, 1_000); // 10% a day, and one claim may be that large
        vm.prank(PROVIDER);
        vault.depositBond(bond);
        vm.prank(ARBITER);
        vault.payClaim(keccak256("a"), PROVIDER, AGENT, bond / 10, bytes32(0)); // reaches the limit
        check(vault.dailyAllowance(PROVIDER) == 0, "limit not reached");
        vm.prank(PROVIDER);
        vault.depositBond(topUp);
        vm.prank(ALICE);
        vault.back(PROVIDER, topUp);
        check(vault.dailyAllowance(PROVIDER) == 0, "a top-up reopened today's limit");
        vm.prank(ARBITER);
        vm.expectRevert();
        vault.payClaim(keccak256("b"), PROVIDER, AGENT, 1, bytes32(0));
    }

    /// The classic vault attack: an early backer tries to skew the share price so a later
    /// backer's deposit rounds down to almost nothing. The honest backer must get back what
    /// they put in, less at most a rounding sliver, and the attacker must not come out ahead.
    function testFuzz_shareInflationDoesNotPay(uint256 seed, uint256 donation, uint256 deposit) public {
        seed = bound(seed, 1, 1e9);
        donation = bound(donation, 0, 1e12);
        deposit = bound(deposit, 1 * USDC, 1e12);
        uint256 malloryStart = usdc.balanceOf(MALLORY);

        vm.startPrank(MALLORY);
        vault.back(PROVIDER, seed);
        if (donation > 0) {
            try vault.fundRewards(PROVIDER, donation) {} catch {} // refused while backing is dust
            usdc.transfer(address(vault), donation % 1e9); // a raw transfer: must not move the books
        }
        vm.stopPrank();

        vm.prank(ALICE);
        vault.back(PROVIDER, deposit);
        uint256 aliceNow = vault.backerAssets(PROVIDER, ALICE);
        // Alice's loss to rounding is bounded by the price of one share plus one unit.
        check(aliceNow + deposit / 1e6 + 2 >= deposit, "honest backer lost more than a rounding sliver");

        // Both leave. Mallory must not end up with more than she started with.
        vm.startPrank(MALLORY);
        vault.requestUnstake(PROVIDER, vault.backerShares(PROVIDER, MALLORY));
        vm.stopPrank();
        vm.startPrank(ALICE);
        vault.requestUnstake(PROVIDER, vault.backerShares(PROVIDER, ALICE));
        vm.stopPrank();
        vm.warp(block.timestamp + 7 days);
        vm.prank(MALLORY);
        vault.completeUnstake(PROVIDER);
        vm.prank(ALICE);
        vault.completeUnstake(PROVIDER);
        check(usdc.balanceOf(MALLORY) <= malloryStart, "the attacker profited");
    }

    /// Backing and leaving, with nothing else happening, never returns more than was put in.
    function testFuzz_roundTripNeverCreatesMoney(uint256 first, uint256 second) public {
        first = bound(first, 1, 1e12);
        second = bound(second, 1, 1e12);
        vm.prank(MALLORY);
        vault.back(PROVIDER, first);
        uint256 before = usdc.balanceOf(ALICE);
        vm.startPrank(ALICE);
        try vault.back(PROVIDER, second) {} catch {
            return; // too small to buy a share: nothing was taken
        }
        vault.requestUnstake(PROVIDER, vault.backerShares(PROVIDER, ALICE));
        vm.warp(block.timestamp + 7 days);
        vault.completeUnstake(PROVIDER);
        vm.stopPrank();
        check(usdc.balanceOf(ALICE) <= before, "a round trip created money");
        check(usdc.balanceOf(address(vault)) >= first, "the other backer's money was touched");
    }

    /// An exit completes only between the end of the delay and the end of the window.
    function testFuzz_exitOnlyInsideItsWindow(uint64 delay, uint256 waited) public {
        delay = uint64(bound(delay, 1 days, 30 days));
        waited = bound(waited, 0, 40 days);
        vm.prank(OWNER);
        vault.setParams(1 * USDC, delay, 500);
        vm.startPrank(PROVIDER);
        vault.depositBond(5 * USDC);
        vault.requestBondWithdraw(5 * USDC);
        check(!vault.isActive(PROVIDER), "queued bond still counted as active");
        vm.warp(block.timestamp + waited);
        bool inWindow = waited >= delay && waited <= uint256(delay) + vault.EXIT_WINDOW();
        try vault.completeBondWithdraw() {
            check(inWindow, "bond left outside its window");
        } catch {
            check(!inWindow, "bond refused inside its window");
        }
        vm.stopPrank();
    }

    /// Bond queued for exit is still on the hook: a claim during the wait is paid from it.
    function testFuzz_queuedBondIsStillSlashable(uint256 bond, uint256 claim) public {
        bond = bound(bond, 2 * USDC, 1e10);
        claim = bound(claim, 1, bond);
        _open(type(uint256).max, 10_000);
        vm.startPrank(PROVIDER);
        vault.depositBond(bond);
        vault.requestBondWithdraw(bond);
        vm.stopPrank();
        vm.prank(ARBITER);
        vault.payClaim(keccak256("q"), PROVIDER, AGENT, claim, bytes32(0));
        check(usdc.balanceOf(AGENT) == claim, "claim against queued bond not paid");
        vm.warp(block.timestamp + 7 days);
        vm.prank(PROVIDER);
        try vault.completeBondWithdraw() {} catch {}
        check(usdc.balanceOf(address(vault)) == vault.coverOf(PROVIDER), "books != balance after exit");
    }

    /// Only the owner can change settings, and only inside the allowed ranges.
    function testFuzz_onlyOwnerWithinRange(address who, uint64 delay, uint16 feeBps, uint16 dailyBps) public {
        vm.assume(who != OWNER);
        vm.startPrank(who);
        vm.expectRevert();
        vault.setParams(1, 7 days, 0);
        vm.expectRevert();
        vault.setMaxClaimPayout(type(uint256).max);
        vm.expectRevert();
        vault.setMaxDailySlashBps(10_000);
        vm.expectRevert();
        vault.setArbiter(who);
        vm.expectRevert();
        vault.pause();
        vm.stopPrank();

        bool paramsOk = feeBps <= 1_000 && delay >= 1 days && delay <= 30 days;
        vm.startPrank(OWNER);
        try vault.setParams(1, delay, feeBps) {
            check(paramsOk, "out-of-range params accepted");
        } catch {
            check(!paramsOk, "in-range params refused");
        }
        try vault.setMaxDailySlashBps(dailyBps) {
            check(dailyBps >= 1 && dailyBps <= 10_000, "out-of-range daily share accepted");
        } catch {
            check(dailyBps == 0 || dailyBps > 10_000, "in-range daily share refused");
        }
        vm.stopPrank();
    }
}
