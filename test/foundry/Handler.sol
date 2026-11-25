// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {SuretyVault} from "../../contracts/SuretyVault.sol";
import {MockUSDC} from "../../contracts/test/MockUSDC.sol";

/// @notice Everything anyone can do to the vault, driven with random inputs by the fuzzer.
///         After each action it records what happened ("ghost" state), so the invariants can
///         compare the vault's own books with an independent tally.
///         A rule that is checked at the moment of an action sets `broken` if it fails,
///         because a revert here would only be counted as a discarded call.
contract Handler is Base {
    SuretyVault public immutable vault;
    MockUSDC public immutable usdc;

    address[3] public providers;
    address[4] public backers;

    // ---- independent tallies
    uint256 public totalIn; // USDC that entered the vault: bonds, backing, rewards
    uint256 public totalOut; // USDC that left: withdrawals, refunds, fees
    uint256 public paidToAgents;
    uint256 public paidInFees;
    mapping(bytes32 => bool) public paid;
    bytes32[] public paidIds;
    uint256 public nextClaim;
    uint256 public largestSingleTake; // the most one claim ever removed (payout + fee)
    uint256 public limitHits; // claims refused because the day's limit was reached

    // what the fuzzer independently believes about today's refunds, per provider
    mapping(address => mapping(uint256 => uint256)) public slashedOn; // provider => day => payout + fee
    mapping(address => mapping(uint256 => uint256)) public startCoverOn; // provider => day => cover at first claim
    mapping(address => mapping(uint256 => bool)) public seenOn;

    // ---- the first broken rule, if any
    string public broken;

    // ---- how often each action really ran (so we know the run exercised the contract)
    mapping(bytes32 => uint256) public calls;

    constructor(SuretyVault _vault, MockUSDC _usdc) {
        vault = _vault;
        usdc = _usdc;
        for (uint256 i = 0; i < 3; i++) {
            address p = address(uint160(0x9000 + i));
            providers[i] = p;
            fund(usdc, vault, p, 1_000_000 * USDC);
            vm.prank(p);
            vault.register("ipfs://sla");
        }
        for (uint256 i = 0; i < 4; i++) {
            address b = address(uint160(0xB000 + i));
            backers[i] = b;
            fund(usdc, vault, b, 1_000_000 * USDC);
        }
    }

    function _fail(string memory what) private {
        if (bytes(broken).length == 0) broken = what;
    }

    function _p(uint256 seed) private view returns (address) {
        return providers[seed % 3];
    }

    function _b(uint256 seed) private view returns (address) {
        return backers[seed % 4];
    }

    function _bond(address p) private view returns (uint128 bond, uint128 pending, uint64 readyAt) {
        P memory r = read(vault, p);
        return (r.bond, r.bondPendingWithdraw, r.bondReadyAt);
    }

    function _cover(address p) private view returns (uint256) {
        return vault.coverOf(p);
    }

    // ------------------------------------------------------------- providers

    function depositBond(uint256 who, uint256 amount) external {
        address p = _p(who);
        amount = bound(amount, 1, 500 * USDC);
        vm.prank(p);
        vault.depositBond(amount);
        totalIn += amount;
        calls["depositBond"]++;
    }

    function requestBondWithdraw(uint256 who, uint256 amount) external {
        address p = _p(who);
        (uint128 bond,,) = _bond(p);
        if (bond == 0) return;
        amount = bound(amount, 1, bond);
        vm.prank(p);
        vault.requestBondWithdraw(amount);
        calls["requestBondWithdraw"]++;
    }

    function cancelBondWithdraw(uint256 who) external {
        address p = _p(who);
        (, uint128 pending,) = _bond(p);
        if (pending == 0) return;
        vm.prank(p);
        vault.cancelBondWithdraw();
        calls["cancelBondWithdraw"]++;
    }

    function completeBondWithdraw(uint256 who) external {
        address p = _p(who);
        (, uint128 pending, uint64 readyAt) = _bond(p);
        uint256 before = usdc.balanceOf(p);
        vm.prank(p);
        try vault.completeBondWithdraw() {
            // An exit may only complete after the wait, inside the window, and for exactly what was queued.
            if (block.timestamp < readyAt) _fail("bond left before the unbonding delay was over");
            if (block.timestamp > uint256(readyAt) + vault.EXIT_WINDOW()) _fail("bond left after the exit window closed");
            if (usdc.balanceOf(p) - before != pending) _fail("bond exit paid a different amount than was queued");
            totalOut += pending;
            calls["completeBondWithdraw"]++;
        } catch {}
    }

    // --------------------------------------------------------------- backers

    function back(uint256 who, uint256 forWhom, uint256 amount) external {
        address b = _b(who);
        address p = _p(forWhom);
        amount = bound(amount, 1, 500 * USDC);
        vm.prank(b);
        try vault.back(p, amount) {
            totalIn += amount;
            calls["back"]++;
        } catch {}
    }

    function requestUnstake(uint256 who, uint256 forWhom, uint256 shares) external {
        address b = _b(who);
        address p = _p(forWhom);
        uint256 held = vault.backerShares(p, b);
        if (held == 0) return;
        shares = bound(shares, 1, held);
        vm.prank(b);
        vault.requestUnstake(p, shares);
        calls["requestUnstake"]++;
    }

    function cancelUnstake(uint256 who, uint256 forWhom) external {
        address b = _b(who);
        address p = _p(forWhom);
        (uint256 shares,) = vault.pendingUnstake(p, b);
        if (shares == 0) return;
        vm.prank(b);
        vault.cancelUnstake(p);
        calls["cancelUnstake"]++;
    }

    function completeUnstake(uint256 who, uint256 forWhom) external {
        address b = _b(who);
        address p = _p(forWhom);
        (, uint64 readyAt) = vault.pendingUnstake(p, b);
        uint256 before = usdc.balanceOf(b);
        vm.prank(b);
        try vault.completeUnstake(p) returns (uint256 assets) {
            if (block.timestamp < readyAt) _fail("stake left before the unbonding delay was over");
            if (block.timestamp > uint256(readyAt) + vault.EXIT_WINDOW()) _fail("stake left after the exit window closed");
            if (usdc.balanceOf(b) - before != assets) _fail("unstake paid a different amount than it reported");
            totalOut += assets;
            calls["completeUnstake"]++;
        } catch {}
    }

    function fundRewards(uint256 who, uint256 forWhom, uint256 amount) external {
        address b = _b(who);
        address p = _p(forWhom);
        amount = bound(amount, 1, 50 * USDC);
        vm.prank(b);
        try vault.fundRewards(p, amount) {
            totalIn += amount;
            calls["fundRewards"]++;
        } catch {}
    }

    // ---------------------------------------------------------------- claims

    function payClaim(uint256 forWhom, uint256 payout) external {
        address p = _p(forWhom);
        payout = bound(payout, 1, vault.maxClaimPayout());
        bytes32 id = keccak256(abi.encode("claim", nextClaim++));

        uint256 cover = _cover(p);
        uint256 day = block.timestamp / DAY;
        uint256 bps = vault.maxDailySlashBps();
        // The fuzzer's own copy of the day's running total, kept the way the rule is written down.
        uint256 start = seenOn[p][day] ? startCoverOn[p][day] : cover;
        uint256 used = slashedOn[p][day];
        uint256 limit = (start * bps) / BPS;

        uint256 agentBefore = usdc.balanceOf(AGENT);
        uint256 feeBefore = usdc.balanceOf(TREASURY);
        vm.prank(ARBITER);
        try vault.payClaim(id, p, AGENT, payout, bytes32(0)) {
            uint256 toAgent = usdc.balanceOf(AGENT) - agentBefore;
            uint256 toFee = usdc.balanceOf(TREASURY) - feeBefore;
            if (bps != BPS && used >= limit) _fail("a claim was paid after the day's refund limit was reached");
            if (toAgent > payout) _fail("the agent was paid more than the claim");
            if (toAgent > vault.maxClaimPayout()) _fail("one claim paid more than maxClaimPayout");
            if (toAgent + toFee > cover) _fail("a claim took more than the provider's cover");
            if (toFee > (payout * vault.slashFeeBps()) / BPS) _fail("the fee was larger than slashFeeBps of the claim");
            if (_cover(p) != cover - toAgent - toFee) _fail("cover did not fall by exactly what was paid out");
            if (!seenOn[p][day]) {
                seenOn[p][day] = true;
                startCoverOn[p][day] = cover;
            }
            // While the limit is switched off the contract does not keep the day's total, so neither do we.
            if (bps != BPS) slashedOn[p][day] = used + toAgent + toFee;
            if (toAgent + toFee > largestSingleTake) largestSingleTake = toAgent + toFee;
            paid[id] = true;
            paidIds.push(id);
            paidToAgents += toAgent;
            paidInFees += toFee;
            totalOut += toAgent + toFee;
            calls["payClaim"]++;
        } catch (bytes memory why) {
            calls["payClaim.refused"]++;
            if (why.length >= 4 && bytes4(why) == SuretyVault.DailyLimitReached.selector) {
                limitHits++;
                // The limit may only refuse a claim once the day's total has really reached it.
                if (bps == BPS || used < limit) _fail("the daily limit refused a claim before the limit was reached");
            }
        }
    }

    /// @dev One claim can never be larger than maxClaimPayout, whatever the provider's cover.
    function oversizedClaim(uint256 forWhom, uint256 extra) external {
        uint256 max = vault.maxClaimPayout();
        uint256 payout = max + bound(extra, 1, 1_000 * USDC);
        vm.prank(ARBITER);
        try vault.payClaim(keccak256(abi.encode("oversized", nextClaim++)), _p(forWhom), AGENT, payout, bytes32(0)) {
            _fail("a claim larger than maxClaimPayout was paid");
        } catch {
            calls["oversizedClaim.refused"]++;
        }
    }

    /// @dev A claim id can only ever be paid once.
    function replayClaim(uint256 which, uint256 forWhom) external {
        if (paidIds.length == 0) return;
        bytes32 id = paidIds[which % paidIds.length];
        vm.prank(ARBITER);
        try vault.payClaim(id, _p(forWhom), AGENT, 1, bytes32(0)) {
            _fail("the same claim id was paid twice");
        } catch {
            calls["replayClaim.refused"]++;
        }
    }

    /// @dev Nobody but the arbiter can pay a claim, whoever they are.
    function strangerClaim(uint256 who, uint256 forWhom) external {
        address s = who % 2 == 0 ? _b(who) : _p(who);
        vm.prank(s);
        try vault.payClaim(keccak256(abi.encode("stranger", nextClaim++)), _p(forWhom), s, 1, bytes32(0)) {
            _fail("someone other than the arbiter paid a claim");
        } catch {
            calls["strangerClaim.refused"]++;
        }
    }

    // ----------------------------------------------------------------- owner

    function ownerSetLimits(uint256 maxClaim, uint256 dailyBps) external {
        // Changing the daily share mid-day changes what "the limit" means for that day, so the
        // independent tally only stays comparable if the owner changes it on a day with no claims yet.
        maxClaim = bound(maxClaim, 1, 20 * USDC);
        vm.prank(OWNER);
        vault.setMaxClaimPayout(maxClaim);
        uint256 day = block.timestamp / DAY;
        bool quiet = !seenOn[providers[0]][day] && !seenOn[providers[1]][day] && !seenOn[providers[2]][day];
        if (quiet) {
            uint256[4] memory choices = [uint256(100), 2_000, 5_000, 10_000];
            vm.prank(OWNER);
            vault.setMaxDailySlashBps(uint16(choices[dailyBps % 4]));
        }
        calls["ownerSetLimits"]++;
    }

    function ownerSetParams(uint256 minBond, uint256 delay, uint256 feeBps) external {
        vm.prank(OWNER);
        vault.setParams(bound(minBond, 0, 200 * USDC), uint64(bound(delay, 1 days, 30 days)), uint16(bound(feeBps, 0, 1_000)));
        calls["ownerSetParams"]++;
    }

    function ownerPause(bool on) external {
        vm.prank(OWNER);
        if (on) {
            try vault.pause() {} catch {}
        } else {
            try vault.unpause() {} catch {}
        }
        calls["ownerPause"]++;
    }

    // ------------------------------------------------------------------ time

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 12 days));
        calls["warp"]++;
    }

    function paidCount() external view returns (uint256) {
        return paidIds.length;
    }
}
