// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SettlementBase} from "./SettlementBase.sol";

/// @notice Everything anyone can do to the router and outpost, driven with random inputs.
///         It keeps its own queue of refunds, independent of the router's, so the invariants
///         can compare what the contracts say with what really should have happened.
contract SettlementHandler is SettlementBase {
    World public w;
    address[5] public agents;

    struct Item {
        address agent;
        uint256 amount;
    }

    // ---- independent tallies
    Item[] internal waiting; // settled on Monad, not yet sent (mirrors the router's queue)
    uint256 public waitingHead;
    mapping(uint256 packet => Item[]) internal carried; // what each sent batch carried
    uint256[] internal undelivered; // inbox indexes still to be delivered
    uint256 public settled; // USDC the vault paid the router, ever
    uint256 public inFlight; // sent, not yet delivered
    uint256 public swept;
    mapping(address => uint256) public delivered; // refunds that have reached Base, per agent
    uint256 public nextClaim;

    string public broken;
    mapping(bytes32 => uint256) public calls;

    constructor() {
        w = deployWorld();
        for (uint256 i = 0; i < 5; i++) agents[i] = address(uint160(0xA6E000 + i));
    }

    receive() external payable {}

    function world() external view returns (World memory) {
        return w;
    }

    function undeliveredCount() external view returns (uint256) {
        return undelivered.length;
    }

    function _fail(string memory what) private {
        if (bytes(broken).length == 0) broken = what;
    }

    // ---------------------------------------------------------------- actions

    function claimRemote(uint256 agentSeed, uint256 amount) external {
        address agent = agents[agentSeed % 5];
        amount = bound(amount, 1, 50 * USDC);
        vm.prank(RELAY);
        uint256 received = w.router.payClaimRemote(bytes32(++nextClaim), PROVIDER, agent, amount, bytes32(0), BASE_CHAIN);
        if (received != amount) _fail("a fully covered claim was paid short");
        waiting.push(Item(agent, received));
        settled += received;
        calls["claimRemote"]++;
    }

    function flush() external {
        uint256 n = waiting.length - waitingHead;
        if (n == 0) return;
        if (n > 20) n = 20;
        uint256 packet = w.base.inboxLength();
        w.router.flush{value: w.router.quoteFlush(BASE_CHAIN)}(BASE_CHAIN);
        for (uint256 i = 0; i < n; i++) {
            Item memory item = waiting[waitingHead + i];
            carried[packet].push(item);
            inFlight += item.amount;
        }
        waitingHead += n;
        undelivered.push(packet);
        calls["flush"]++;
    }

    function deliver(uint256 seed) external {
        if (undelivered.length == 0) return;
        uint256 at = seed % undelivered.length;
        uint256 packet = undelivered[at];
        undelivered[at] = undelivered[undelivered.length - 1];
        undelivered.pop();
        w.base.deliver(packet);
        Item[] storage items = carried[packet];
        for (uint256 i = 0; i < items.length; i++) {
            delivered[items[i].agent] += items[i].amount;
            inFlight -= items[i].amount;
        }
        calls["deliver"]++;
    }

    function fundFloat(uint256 amount) external {
        w.usdcBase.mint(address(w.outpost), bound(amount, 0, 200 * USDC));
        calls["fundFloat"]++;
    }

    /// The owner asks for anything up to twice the spare float. More than spare must be refused.
    function withdrawFloat(uint256 amount) external {
        uint256 spare = w.outpost.spareFloat();
        amount = bound(amount, 0, spare * 2 + 1);
        vm.prank(OWNER);
        (bool ok,) = address(w.outpost).call(abi.encodeCall(w.outpost.withdrawFloat, (NOBODY, amount)));
        if (ok != (amount <= spare)) _fail("float withdrawal did not follow the spare-float rule");
        calls["withdrawFloat"]++;
    }

    function collect(uint256 agentSeed) external {
        address agent = agents[agentSeed % 5];
        if (w.outpost.credit(agent) == 0 || w.usdcBase.balanceOf(address(w.outpost)) == 0) return;
        if (w.usdcBase.blocked(agent)) return;
        vm.prank(NOBODY);
        w.outpost.collect(agent);
        calls["collect"]++;
    }

    /// The owner asks for anything up to twice what is reimbursable. More must be refused.
    function sweep(uint256 amount) external {
        uint256 limit = w.router.reimbursable();
        amount = bound(amount, 0, limit * 2 + 1);
        vm.prank(OWNER);
        (bool ok,) = address(w.router).call(abi.encodeCall(w.router.sweep, (NOBODY, amount)));
        if (ok != (amount <= limit)) _fail("sweep did not follow the reimbursable rule");
        if (ok) swept += amount;
        calls["sweep"]++;
    }

    function toggleBlocked(uint256 agentSeed) external {
        address agent = agents[agentSeed % 5];
        w.usdcBase.setBlocked(agent, !w.usdcBase.blocked(agent));
        calls["toggleBlocked"]++;
    }

    function strangerTries(address stranger, uint256 amount) external {
        if (stranger == RELAY || stranger == OWNER) return;
        vm.startPrank(stranger);
        (bool a,) = address(w.router).call(
            abi.encodeCall(w.router.payClaimRemote, (bytes32("s"), PROVIDER, stranger, 1, bytes32(0), BASE_CHAIN))
        );
        (bool b,) = address(w.router).call(abi.encodeCall(w.router.sweep, (stranger, amount)));
        (bool c,) = address(w.outpost).call(abi.encodeCall(w.outpost.withdrawFloat, (stranger, amount)));
        vm.stopPrank();
        if (a || b || c) _fail("a stranger filed a claim or moved money");
        calls["strangerTries"]++;
    }
}
