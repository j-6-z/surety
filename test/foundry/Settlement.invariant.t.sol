// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SettlementBase} from "./SettlementBase.sol";
import {SettlementHandler} from "./SettlementHandler.sol";

/// @notice Properties that must hold after ANY sequence of remote claims, flushes, deliveries in
///         any order, float top-ups and withdrawals, collections, sweeps and blocked addresses.
contract SettlementInvariants is SettlementBase {
    SettlementHandler internal handler;
    World internal w;

    function setUp() public {
        vm.warp(T0);
        handler = new SettlementHandler();
        w = handler.world();
        vm.deal(address(handler), 1_000_000 ether);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// The router holds exactly the refunds waiting to be sent plus what the owner may take back.
    function invariant_routerHoldsExactlyWhatItOwes() public view {
        check(
            w.usdc.balanceOf(address(w.router)) == w.router.pendingTotal() + w.router.reimbursable(),
            "router balance != pending + reimbursable"
        );
        (, uint256 queued) = w.router.pending(BASE_CHAIN);
        check(queued == w.router.pendingTotal(), "queue total != pending total");
    }

    /// Every unit the vault paid out for a remote refund is in exactly one place: still queued on
    /// Monad, on its way, paid on Base, or owed on Base as a credit. None is created or lost.
    function invariant_everyRefundIsSomewhere() public view {
        check(
            handler.settled()
                == w.router.pendingTotal() + handler.inFlight() + w.outpost.totalPaid() + w.outpost.totalCredit(),
            "settled != queued + in flight + paid + credited"
        );
        check(handler.settled() == w.router.pendingTotal() + w.router.reimbursable() + handler.swept(), "sweep leaked");
    }

    /// Each agent has received, or is owed, exactly the refunds that reached Base for it.
    function invariant_eachAgentGetsExactlyItsRefunds() public view {
        uint256 credits;
        for (uint256 i = 0; i < 5; i++) {
            address agent = handler.agents(i);
            check(
                w.usdcBase.balanceOf(agent) + w.outpost.credit(agent) == handler.delivered(agent),
                "agent balance + credit != refunds delivered"
            );
            check(w.usdc.balanceOf(agent) == 0, "a remote refund was also paid on Monad");
            credits += w.outpost.credit(agent);
        }
        check(credits == w.outpost.totalCredit(), "credits do not add up");
    }

    /// No rule was broken at the moment of any action (strangers refused, limits respected).
    function invariant_noRuleBrokenAlongTheWay() public view {
        check(bytes(handler.broken()).length == 0, handler.broken());
    }
}
