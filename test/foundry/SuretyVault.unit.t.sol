// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {SuretyVault} from "../../contracts/SuretyVault.sol";
import {MockUSDC} from "../../contracts/test/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Every way the vault says no, one case each, plus the read-only helpers.
contract SuretyVaultUnit is Base {
    SuretyVault internal vault;
    MockUSDC internal usdc;

    address internal constant PROVIDER = address(0x9001);
    address internal constant BACKER = address(0xB001);
    address internal constant NOBODY = address(0xDEAD1);

    function setUp() public {
        (vault, usdc) = deployVault(1 * USDC, 7 days, 500);
        fund(usdc, vault, PROVIDER, 1_000 * USDC);
        fund(usdc, vault, BACKER, 1_000 * USDC);
        vm.prank(PROVIDER);
        vault.register("ipfs://sla");
        vm.warp(1_800_000_000);
    }

    // ---------------------------------------------------------- construction

    function test_constructor_refusesZeroAddresses() public {
        vm.expectRevert(SuretyVault.ZeroAddress.selector);
        new SuretyVault(IERC20(address(0)), OWNER, ARBITER, TREASURY, 1, 7 days, 500);
        vm.expectRevert(SuretyVault.ZeroAddress.selector);
        new SuretyVault(usdc, OWNER, address(0), TREASURY, 1, 7 days, 500);
        vm.expectRevert(SuretyVault.ZeroAddress.selector);
        new SuretyVault(usdc, OWNER, ARBITER, address(0), 1, 7 days, 500);
    }

    function test_constructor_refusesOutOfRangeSettings() public {
        vm.expectRevert(SuretyVault.FeeTooHigh.selector);
        new SuretyVault(usdc, OWNER, ARBITER, TREASURY, 1, 7 days, 1_001);
        vm.expectRevert(SuretyVault.DelayOutOfRange.selector);
        new SuretyVault(usdc, OWNER, ARBITER, TREASURY, 1, 1 days - 1, 500);
        vm.expectRevert(SuretyVault.DelayOutOfRange.selector);
        new SuretyVault(usdc, OWNER, ARBITER, TREASURY, 1, 30 days + 1, 500);
    }

    function test_constructor_setsConservativeLimits() public view {
        check(vault.maxClaimPayout() == (1 * USDC * 500) / BPS, "one claim should start at 5% of the minimum bond");
        check(vault.maxDailySlashBps() == 2_000, "the daily limit should start at 20%");
        check(vault.owner() == OWNER && vault.arbiter() == ARBITER && vault.treasury() == TREASURY, "roles");
    }

    // -------------------------------------------------------------- providers

    function test_register_onceOnly() public {
        vm.prank(PROVIDER);
        vm.expectRevert(SuretyVault.AlreadyRegistered.selector);
        vault.register("again");
    }

    function test_setMetadata_onlyForRegistered() public {
        vm.prank(PROVIDER);
        vault.setMetadata("https://example.com/sla.json");
        check(keccak256(bytes(read(vault, PROVIDER).metadataURI)) == keccak256("https://example.com/sla.json"), "metadata not stored");
        vm.prank(NOBODY);
        vm.expectRevert(SuretyVault.NotRegistered.selector);
        vault.setMetadata("x");
    }

    function test_bond_refusesZeroUnregisteredAndTooMuch() public {
        vm.startPrank(PROVIDER);
        vm.expectRevert(SuretyVault.ZeroAmount.selector);
        vault.depositBond(0);
        vault.depositBond(5 * USDC);
        vm.expectRevert(SuretyVault.ZeroAmount.selector);
        vault.requestBondWithdraw(0);
        vm.expectRevert(SuretyVault.InsufficientBond.selector);
        vault.requestBondWithdraw(5 * USDC + 1);
        vm.expectRevert(SuretyVault.NothingPending.selector);
        vault.cancelBondWithdraw();
        vm.expectRevert(SuretyVault.NothingPending.selector);
        vault.completeBondWithdraw();
        vm.stopPrank();
        vm.startPrank(NOBODY);
        vm.expectRevert(SuretyVault.NotRegistered.selector);
        vault.depositBond(1);
        vm.expectRevert(SuretyVault.NotRegistered.selector);
        vault.requestBondWithdraw(1);
        vm.stopPrank();
    }

    function test_activeStatus_followsUnqueuedBond() public {
        check(!vault.isActive(PROVIDER), "active with no bond");
        vm.startPrank(PROVIDER);
        vault.depositBond(1 * USDC);
        check(vault.isActive(PROVIDER) && vault.isCovered(PROVIDER), "not active at the minimum bond");
        vault.requestBondWithdraw(1);
        check(!vault.isActive(PROVIDER) && !vault.isCovered(PROVIDER), "still active with bond queued below the minimum");
        check(vault.committedCoverOf(PROVIDER) == 1 * USDC - 1, "committed cover should leave out queued bond");
        check(vault.coverOf(PROVIDER) == 1 * USDC, "queued bond should still count as cover");
        vault.cancelBondWithdraw();
        check(vault.isActive(PROVIDER), "cancelling the exit should restore active status");
        vm.stopPrank();
        check(!vault.isActive(NOBODY), "an unregistered address is active");
    }

    // ---------------------------------------------------------------- backers

    function test_back_refusesZeroDustAndUnregistered() public {
        vm.startPrank(BACKER);
        vm.expectRevert(SuretyVault.ZeroAmount.selector);
        vault.back(PROVIDER, 0);
        vm.expectRevert(SuretyVault.NotRegistered.selector);
        vault.back(NOBODY, 1 * USDC);
        vm.stopPrank();
        // Push the share price up until one unit buys no share at all.
        // That deposit must be refused outright, not taken and credited as nothing.
        usdc.mint(BACKER, 2_000_000 * USDC);
        vm.startPrank(BACKER);
        vault.back(PROVIDER, 1 * USDC);
        vault.fundRewards(PROVIDER, 1_500_000 * USDC);
        check(vault.previewBack(PROVIDER, 1) == 0, "one unit should buy no share at this price");
        uint256 before = usdc.balanceOf(BACKER);
        vm.expectRevert(SuretyVault.ZeroAmount.selector);
        vault.back(PROVIDER, 1);
        check(usdc.balanceOf(BACKER) == before, "a deposit that bought nothing was still taken");
        vm.stopPrank();
    }

    function test_unstake_refusesZeroTooMuchAndNothingPending() public {
        vm.startPrank(BACKER);
        vault.back(PROVIDER, 10 * USDC);
        uint256 shares = vault.backerShares(PROVIDER, BACKER);
        check(vault.previewBack(PROVIDER, 0) == 0, "previewing a deposit of nothing should give no shares");
        check(vault.backerAssets(PROVIDER, BACKER) <= 10 * USDC && vault.backerAssets(PROVIDER, BACKER) + 1 >= 10 * USDC, "a fresh stake should be worth what was put in");
        vm.expectRevert(SuretyVault.ZeroAmount.selector);
        vault.requestUnstake(PROVIDER, 0);
        vm.expectRevert(SuretyVault.InsufficientShares.selector);
        vault.requestUnstake(PROVIDER, shares + 1);
        vm.expectRevert(SuretyVault.NothingPending.selector);
        vault.cancelUnstake(PROVIDER);
        vm.expectRevert(SuretyVault.NothingPending.selector);
        vault.completeUnstake(PROVIDER);
        vault.requestUnstake(PROVIDER, shares / 2);
        check(vault.committedCoverOf(PROVIDER) < vault.coverOf(PROVIDER), "queued shares still counted as committed");
        vault.cancelUnstake(PROVIDER);
        check(vault.committedCoverOf(PROVIDER) == vault.coverOf(PROVIDER), "cancelling should restore committed cover");
        vm.stopPrank();
        vm.prank(BACKER);
        vm.expectRevert(SuretyVault.NotRegistered.selector);
        vault.requestUnstake(NOBODY, 1);
    }

    function test_rewards_needRealBackingAndANonZeroAmount() public {
        vm.startPrank(BACKER);
        vm.expectRevert(SuretyVault.ZeroAmount.selector);
        vault.fundRewards(PROVIDER, 0);
        vm.expectRevert(SuretyVault.NoBackers.selector);
        vault.fundRewards(PROVIDER, 1 * USDC); // nobody to receive them
        vault.back(PROVIDER, 1 * USDC - 1);
        vm.expectRevert(SuretyVault.NoBackers.selector);
        vault.fundRewards(PROVIDER, 1 * USDC); // dust backing only
        vm.expectRevert(SuretyVault.NotRegistered.selector);
        vault.fundRewards(NOBODY, 1 * USDC);
        vm.stopPrank();
    }

    // ----------------------------------------------------------------- claims

    function test_payClaim_refusesEveryBadInput() public {
        vm.prank(PROVIDER);
        vault.depositBond(10 * USDC);
        vm.startPrank(ARBITER);
        vm.expectRevert(SuretyVault.ZeroAmount.selector);
        vault.payClaim(keccak256("a"), PROVIDER, AGENT, 0, bytes32(0));
        vm.expectRevert(SuretyVault.ZeroAddress.selector);
        vault.payClaim(keccak256("a"), PROVIDER, address(0), 1, bytes32(0));
        vm.expectRevert(SuretyVault.NotRegistered.selector);
        vault.payClaim(keccak256("a"), NOBODY, AGENT, 1, bytes32(0));
        uint256 tooMuch = vault.maxClaimPayout() + 1;
        vm.expectRevert(abi.encodeWithSelector(SuretyVault.PayoutTooLarge.selector, tooMuch, vault.maxClaimPayout()));
        vault.payClaim(keccak256("a"), PROVIDER, AGENT, tooMuch, bytes32(0));
        vault.payClaim(keccak256("a"), PROVIDER, AGENT, 1_000, bytes32(0));
        vm.expectRevert(SuretyVault.ClaimAlreadyPaid.selector);
        vault.payClaim(keccak256("a"), PROVIDER, AGENT, 1_000, bytes32(0));
        vm.stopPrank();
        vm.prank(NOBODY);
        vm.expectRevert(SuretyVault.NotArbiter.selector);
        vault.payClaim(keccak256("b"), PROVIDER, NOBODY, 1, bytes32(0));
    }

    function test_payClaim_noCoverMeansNoPayment() public {
        vm.prank(ARBITER);
        vm.expectRevert(SuretyVault.NoCover.selector);
        vault.payClaim(keccak256("c"), PROVIDER, AGENT, 1, bytes32(0));
    }

    function test_pause_stopsMoneyInAndClaimsOut_butNeverTrapsAnExit() public {
        vm.startPrank(PROVIDER);
        vault.depositBond(5 * USDC);
        vault.requestBondWithdraw(5 * USDC);
        vm.stopPrank();
        vm.prank(OWNER);
        vault.pause();
        vm.prank(PROVIDER);
        vm.expectRevert();
        vault.depositBond(1);
        vm.prank(BACKER);
        vm.expectRevert();
        vault.back(PROVIDER, 1 * USDC);
        vm.prank(ARBITER);
        vm.expectRevert();
        vault.payClaim(keccak256("p"), PROVIDER, AGENT, 1, bytes32(0));
        // A paused vault must still let people take their own money out.
        vm.warp(block.timestamp + 7 days);
        vm.prank(PROVIDER);
        vault.completeBondWithdraw();
        check(usdc.balanceOf(PROVIDER) == 1_000 * USDC, "a paused vault trapped a provider's bond");
    }

    // ------------------------------------------------------------------ owner

    function test_owner_canReplaceArbiterAndTreasury_notWithZero() public {
        vm.startPrank(OWNER);
        vm.expectRevert(SuretyVault.ZeroAddress.selector);
        vault.setArbiter(address(0));
        vm.expectRevert(SuretyVault.ZeroAddress.selector);
        vault.setTreasury(address(0));
        vault.setArbiter(NOBODY);
        vault.setTreasury(BACKER);
        vm.stopPrank();
        check(vault.arbiter() == NOBODY && vault.treasury() == BACKER, "roles not replaced");
        // The old arbiter is locked out the moment it is replaced.
        vm.prank(PROVIDER);
        vault.depositBond(5 * USDC);
        vm.prank(ARBITER);
        vm.expectRevert(SuretyVault.NotArbiter.selector);
        vault.payClaim(keccak256("old"), PROVIDER, AGENT, 1, bytes32(0));
        vm.prank(NOBODY);
        vault.payClaim(keccak256("new"), PROVIDER, AGENT, 1, bytes32(0));
    }

    function test_ownership_movesInTwoSteps() public {
        vm.prank(OWNER);
        vault.transferOwnership(NOBODY);
        check(vault.owner() == OWNER, "ownership moved before it was accepted");
        vm.prank(BACKER);
        vm.expectRevert();
        vault.acceptOwnership();
        vm.prank(NOBODY);
        vault.acceptOwnership();
        check(vault.owner() == NOBODY, "ownership not accepted");
    }
}
