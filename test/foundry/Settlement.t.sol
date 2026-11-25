// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SettlementBase} from "./SettlementBase.sol";
import {SuretyVault} from "../../contracts/SuretyVault.sol";
import {BlockableUSDC} from "../../contracts/test/BlockableUSDC.sol";
import {MockEndpoint} from "../../contracts/test/MockEndpoint.sol";
import {SuretyRouter} from "../../contracts/crosschain/SuretyRouter.sol";
import {SuretyOutpost} from "../../contracts/crosschain/SuretyOutpost.sol";
import {RefundCodec} from "../../contracts/crosschain/RefundCodec.sol";
import {Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract RefundCodecHarness {
    function count(bytes calldata m) external pure returns (uint256) {
        return RefundCodec.count(m);
    }

    function refund(bytes calldata m, uint256 i) external pure returns (bytes32, address, uint128) {
        return RefundCodec.decodeRefund(m, i);
    }
}

/// @dev A vault that accepts a claim and pays nothing. The real vault never does this; the
///      router still must not queue a refund it holds no money for.
contract EmptyHandedVault {
    IERC20 public immutable usdc;

    constructor(IERC20 _usdc) {
        usdc = _usdc;
    }

    function payClaim(bytes32, address, address, uint256, bytes32) external {}
}

/// @notice Refunds for payers on another chain: settled on Monad, delivered on Base.
contract SettlementTest is SettlementBase {
    SuretyVault internal vault;
    BlockableUSDC internal usdc;
    BlockableUSDC internal usdcBase;
    MockEndpoint internal base;
    SuretyRouter internal router;
    SuretyOutpost internal outpost;
    RefundCodecHarness internal codec;
    World internal world;

    address internal constant ALICE = address(0xA11CE5);
    address internal constant BOB = address(0xB0B);
    uint256 internal nextId;

    receive() external payable {}

    function setUp() public {
        vm.warp(T0);
        world = deployWorld();
        (vault, usdc, usdcBase, base, router, outpost) =
            (world.vault, world.usdc, world.usdcBase, world.base, world.router, world.outpost);
        codec = new RefundCodecHarness();
    }

    // ---------------------------------------------------------------- helpers

    function _claim(address agent, uint256 amount) internal returns (uint256 received) {
        vm.prank(RELAY);
        received = router.payClaimRemote(bytes32(++nextId), PROVIDER, agent, amount, bytes32("evidence"), BASE_CHAIN);
    }

    /// @dev Send the next batch and leave it waiting on the Base side. Returns its inbox index.
    function _flush() internal returns (uint256 index) {
        index = base.inboxLength();
        router.flush{value: router.quoteFlush(BASE_CHAIN)}(BASE_CHAIN);
    }

    function _float(uint256 amount) internal {
        usdcBase.mint(address(outpost), amount);
    }

    function _one(bytes32 id, address agent, uint128 amount) internal pure returns (bytes memory) {
        return bytes.concat(RefundCodec.encodeHeader(), RefundCodec.encodeRefund(id, agent, amount));
    }

    // -------------------------------------------------------- settle on Monad

    function test_local_refundGoesStraightThroughTheVault() public {
        vm.prank(RELAY);
        router.payClaim(bytes32("c"), PROVIDER, ALICE, 2 * USDC, bytes32(0));
        check(usdc.balanceOf(ALICE) == 2 * USDC, "agent not paid on Monad");
        check(usdc.balanceOf(address(router)) == 0 && router.pendingTotal() == 0, "router kept something");
    }

    function test_remote_vaultPaysTheRouterAndTheRefundIsQueued() public {
        uint256 coverBefore = vault.coverOf(PROVIDER);
        uint256 received = _claim(ALICE, 2 * USDC);

        check(received == 2 * USDC, "received");
        check(vault.coverOf(PROVIDER) == coverBefore - 2 * USDC - 100_000, "bond not slashed by payout plus 5% fee");
        check(usdc.balanceOf(TREASURY) == 100_000, "fee");
        check(usdc.balanceOf(address(router)) == 2 * USDC, "router does not hold the refund");
        check(usdc.balanceOf(ALICE) == 0 && usdcBase.balanceOf(ALICE) == 0, "agent paid before delivery");
        (uint256 n, uint256 amount) = router.pending(BASE_CHAIN);
        check(n == 1 && amount == 2 * USDC && router.pendingTotal() == 2 * USDC, "queue");
        check(router.reimbursable() == 0, "reimbursable before sending");
    }

    function test_remote_queuesWhatTheVaultReallyPaidWhenCoverIsShort() public {
        vm.prank(PROVIDER);
        vault.requestBondWithdraw(100_000 * USDC);
        vm.warp(T0 + 7 days);
        vm.prank(PROVIDER);
        vault.completeBondWithdraw();
        vm.prank(PROVIDER);
        vault.depositBond(3 * USDC); // all the cover there is

        uint256 received = _claim(ALICE, 5 * USDC);
        check(received == 3 * USDC, "queued more than the vault paid");
        (, uint256 amount) = router.pending(BASE_CHAIN);
        check(amount == 3 * USDC && usdc.balanceOf(address(router)) == 3 * USDC, "queue differs from balance");
    }

    function test_remote_refusals() public {
        vm.expectRevert(SuretyRouter.NotRelay.selector);
        router.payClaimRemote(bytes32("x"), PROVIDER, ALICE, 1 * USDC, bytes32(0), BASE_CHAIN);
        vm.expectRevert(SuretyRouter.NotRelay.selector);
        router.payClaim(bytes32("x"), PROVIDER, ALICE, 1 * USDC, bytes32(0));

        vm.startPrank(RELAY);
        vm.expectRevert(SuretyRouter.ZeroAddress.selector);
        router.payClaimRemote(bytes32("x"), PROVIDER, address(0), 1 * USDC, bytes32(0), BASE_CHAIN);
        vm.expectRevert(abi.encodeWithSignature("NoPeer(uint32)", OTHER));
        router.payClaimRemote(bytes32("x"), PROVIDER, ALICE, 1 * USDC, bytes32(0), OTHER);
        vm.stopPrank();
        check(router.pendingTotal() == 0 && usdc.balanceOf(address(router)) == 0, "a refused claim left something");
    }

    function test_remote_nothingIsQueuedIfTheVaultPaidNothing() public {
        EmptyHandedVault empty = new EmptyHandedVault(usdc);
        SuretyRouter r = new SuretyRouter(address(world.monad), OWNER, address(empty), RELAY);
        vm.prank(OWNER);
        r.setPeer(BASE_CHAIN, b32(address(outpost)));
        vm.prank(RELAY);
        vm.expectRevert(SuretyRouter.NothingReceived.selector);
        r.payClaimRemote(bytes32("c"), PROVIDER, ALICE, 1 * USDC, bytes32(0), BASE_CHAIN);
    }

    function test_remote_theVaultsOwnRulesStillApply() public {
        _claim(ALICE, 1 * USDC);
        vm.startPrank(RELAY);
        vm.expectRevert(SuretyVault.ClaimAlreadyPaid.selector);
        router.payClaimRemote(bytes32(nextId), PROVIDER, ALICE, 1 * USDC, bytes32(0), BASE_CHAIN);
        vm.expectRevert(abi.encodeWithSelector(SuretyVault.PayoutTooLarge.selector, 101 * USDC, 100 * USDC));
        router.payClaimRemote(bytes32("big"), PROVIDER, ALICE, 101 * USDC, bytes32(0), BASE_CHAIN);
        vm.stopPrank();

        // The daily limit, set back to 20% of a 100,000 USDC bond, stops remote claims too.
        vm.prank(OWNER);
        vault.setMaxDailySlashBps(1);
        uint256 allowance = vault.dailyAllowance(PROVIDER);
        _claim(BOB, 100 * USDC);
        check(vault.dailyAllowance(PROVIDER) <= allowance, "allowance grew");
        vm.expectRevert();
        _claim(BOB, 1 * USDC);
        (uint256 n,) = router.pending(BASE_CHAIN);
        check(n == 2, "a refused claim was queued");
    }

    function test_remote_pauseStopsNewClaimsButNotDelivery() public {
        _claim(ALICE, 1 * USDC);
        vm.prank(OWNER);
        vault.pause();
        vm.expectRevert();
        _claim(ALICE, 1 * USDC);

        _float(10 * USDC);
        base.deliver(_flush());
        check(usdcBase.balanceOf(ALICE) == 1 * USDC, "a settled refund was held up by the pause");
    }

    // ------------------------------------------------------- deliver on Base

    function test_flush_sendsTheQueueAndTheOutpostPays() public {
        _claim(ALICE, 2 * USDC);
        _claim(BOB, 3 * USDC);
        _float(10 * USDC);
        uint256 index = _flush();

        (uint256 n, uint256 amount) = router.pending(BASE_CHAIN);
        check(n == 0 && amount == 0 && router.pendingTotal() == 0, "queue not emptied");
        check(router.reimbursable() == 5 * USDC, "reimbursable");
        check(usdcBase.balanceOf(ALICE) == 0, "paid before the message arrived");

        base.deliver(index);
        check(usdcBase.balanceOf(ALICE) == 2 * USDC && usdcBase.balanceOf(BOB) == 3 * USDC, "agents not paid on Base");
        check(outpost.totalPaid() == 5 * USDC && outpost.totalCredit() == 0, "outpost books");
        check(usdcBase.balanceOf(address(outpost)) == 5 * USDC && outpost.spareFloat() == 5 * USDC, "float");
    }

    function test_flush_anyoneCanPayForIt_andGetsTheChangeBack() public {
        _claim(ALICE, 1 * USDC);
        uint256 fee = router.quoteFlush(BASE_CHAIN);
        vm.deal(NOBODY, fee + 1 ether);
        vm.prank(NOBODY);
        router.flush{value: fee + 1 ether}(BASE_CHAIN);
        check(NOBODY.balance == 1 ether, "kept more than the fee");
        check(address(router).balance == 0, "router holds native funds");

        _claim(ALICE, 1 * USDC);
        vm.expectRevert();
        router.flush{value: fee - 1}(BASE_CHAIN);
        (uint256 n,) = router.pending(BASE_CHAIN);
        check(n == 1 && router.reimbursable() == 1 * USDC, "a failed send still moved the queue");
    }

    function test_flush_nothingToSend() public {
        vm.expectRevert(SuretyRouter.NothingPending.selector);
        router.flush(BASE_CHAIN);
        vm.expectRevert(SuretyRouter.NothingPending.selector);
        router.quoteFlush(BASE_CHAIN);
        vm.expectRevert(SuretyRouter.NothingPending.selector);
        router.flush(OTHER);
    }

    function test_flush_sendsAtMostTwentyAtATime() public {
        for (uint256 i = 0; i < 25; ++i) _claim(address(uint160(0x500000 + i)), 1 * USDC);
        _float(100 * USDC);
        uint256 first = _flush();
        (uint256 n, uint256 amount) = router.pending(BASE_CHAIN);
        check(n == 5 && amount == 5 * USDC && router.reimbursable() == 20 * USDC, "first batch was not 20");
        uint256 second = _flush();
        (n,) = router.pending(BASE_CHAIN);
        check(n == 0 && router.reimbursable() == 25 * USDC, "second batch");

        base.deliver(second); // the order the batches arrive in does not matter
        base.deliver(first);
        for (uint256 i = 0; i < 25; ++i) check(usdcBase.balanceOf(address(uint160(0x500000 + i))) == 1 * USDC, "missed one");
    }

    function test_outpost_anEmptyFloatBecomesACredit_thenAnyoneCanCollect() public {
        _claim(ALICE, 4 * USDC);
        base.deliver(_flush());
        check(usdcBase.balanceOf(ALICE) == 0 && outpost.credit(ALICE) == 4 * USDC, "no credit recorded");
        check(outpost.totalCredit() == 4 * USDC && outpost.totalPaid() == 0, "books");

        vm.expectRevert(SuretyOutpost.FloatEmpty.selector);
        outpost.collect(ALICE);
        vm.expectRevert(SuretyOutpost.NothingOwed.selector);
        outpost.collect(BOB);

        _float(1 * USDC);
        vm.prank(NOBODY);
        check(outpost.collect(ALICE) == 1 * USDC, "partial collect");
        check(usdcBase.balanceOf(ALICE) == 1 * USDC && outpost.credit(ALICE) == 3 * USDC, "partial books");
        check(usdcBase.balanceOf(NOBODY) == 0, "the caller got paid");

        _float(10 * USDC);
        outpost.collect(ALICE);
        check(usdcBase.balanceOf(ALICE) == 4 * USDC && outpost.credit(ALICE) == 0, "not paid in full");
        check(outpost.totalCredit() == 0 && outpost.totalPaid() == 4 * USDC && outpost.spareFloat() == 7 * USDC, "end books");
    }

    function test_outpost_aNewRefundDoesNotJumpAnEarlierCredit() public {
        _claim(ALICE, 4 * USDC);
        base.deliver(_flush()); // Alice is owed 4, float is empty
        _float(4 * USDC); // exactly what Alice is owed
        check(outpost.spareFloat() == 0, "credited float counted as spare");

        _claim(BOB, 1 * USDC);
        base.deliver(_flush());
        check(usdcBase.balanceOf(BOB) == 0 && outpost.credit(BOB) == 1 * USDC, "Bob was paid with Alice's money");
        outpost.collect(ALICE);
        check(usdcBase.balanceOf(ALICE) == 4 * USDC, "Alice short");
    }

    function test_outpost_oneRefusedTransferDoesNotStopTheBatch() public {
        usdcBase.setBlocked(ALICE, true);
        _claim(ALICE, 2 * USDC);
        _claim(BOB, 3 * USDC);
        _float(10 * USDC);
        base.deliver(_flush());

        check(usdcBase.balanceOf(BOB) == 3 * USDC, "Bob held up by Alice");
        check(outpost.credit(ALICE) == 2 * USDC && outpost.totalPaid() == 3 * USDC, "Alice not credited");
        vm.expectRevert();
        outpost.collect(ALICE);
        usdcBase.setBlocked(ALICE, false);
        outpost.collect(ALICE);
        check(usdcBase.balanceOf(ALICE) == 2 * USDC, "Alice not paid once unblocked");
    }

    function test_outpost_ownerCanTakeSpareFloatOnly() public {
        _claim(ALICE, 4 * USDC);
        base.deliver(_flush());
        _float(10 * USDC); // 4 owed to Alice, 6 spare

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        outpost.withdrawFloat(NOBODY, 1);
        vm.startPrank(OWNER);
        vm.expectRevert(SuretyOutpost.ZeroAddress.selector);
        outpost.withdrawFloat(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(SuretyOutpost.MoreThanSpareFloat.selector, 6 * USDC + 1, 6 * USDC));
        outpost.withdrawFloat(NOBODY, 6 * USDC + 1);
        outpost.withdrawFloat(NOBODY, 6 * USDC);
        vm.stopPrank();
        check(usdcBase.balanceOf(NOBODY) == 6 * USDC && outpost.spareFloat() == 0, "spare float");
        outpost.collect(ALICE);
        check(usdcBase.balanceOf(ALICE) == 4 * USDC, "the owner took money owed to an agent");
    }

    function test_outpost_refusesEverythingButTheRoutersMessages() public {
        bytes memory m = _one(bytes32("c"), ALICE, 1);
        vm.expectRevert(abi.encodeWithSignature("OnlyEndpoint(address)", address(this)));
        outpost.lzReceive(Origin(MONAD, b32(address(router)), 1), bytes32(0), m, address(0), "");
        vm.expectRevert(abi.encodeWithSignature("OnlyPeer(uint32,bytes32)", MONAD, b32(NOBODY)));
        base.deliverRaw(address(outpost), Origin(MONAD, b32(NOBODY), 1), m);

        vm.prank(OWNER);
        outpost.setPeer(OTHER, b32(NOBODY));
        vm.expectRevert(abi.encodeWithSelector(SuretyOutpost.NotFromHub.selector, OTHER));
        base.deliverRaw(address(outpost), Origin(OTHER, b32(NOBODY), 1), m);

        Origin memory o = Origin(MONAD, b32(address(router)), 1);
        vm.expectRevert(abi.encodeWithSelector(RefundCodec.BadLength.selector, 1));
        base.deliverRaw(address(outpost), o, RefundCodec.encodeHeader());
        vm.expectRevert(abi.encodeWithSelector(RefundCodec.BadLength.selector, 70));
        base.deliverRaw(address(outpost), o, bytes.concat(m, hex"00"));
        m[0] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(RefundCodec.UnsupportedVersion.selector, 2));
        base.deliverRaw(address(outpost), o, m);
        check(outpost.totalCredit() == 0 && outpost.totalPaid() == 0, "a refused message changed the books");
    }

    // ------------------------------------------------------------- the owner

    function test_sweep_takesOnlyWhatHasBeenSent() public {
        _claim(ALICE, 2 * USDC);
        _flush(); // 2 sent
        _claim(BOB, 3 * USDC); // 3 still queued

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        router.sweep(NOBODY, 1);
        vm.startPrank(OWNER);
        vm.expectRevert(SuretyRouter.ZeroAddress.selector);
        router.sweep(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(SuretyRouter.MoreThanReimbursable.selector, 2 * USDC + 1, 2 * USDC));
        router.sweep(NOBODY, 2 * USDC + 1);
        router.sweep(NOBODY, 2 * USDC);
        vm.stopPrank();

        check(usdc.balanceOf(NOBODY) == 2 * USDC && router.reimbursable() == 0, "sweep");
        check(usdc.balanceOf(address(router)) == 3 * USDC && router.pendingTotal() == 3 * USDC, "queued money was touched");
    }

    function test_owner_relayAndGasSettings() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        router.setRelay(NOBODY);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        router.setReceiveGas(BASE_CHAIN, 100_000, 100_000);

        vm.startPrank(OWNER);
        vm.expectRevert(SuretyRouter.ZeroAddress.selector);
        router.setRelay(address(0));
        router.setRelay(NOBODY);
        vm.expectRevert(SuretyRouter.GasOutOfRange.selector);
        router.setReceiveGas(BASE_CHAIN, 0, 1);
        vm.expectRevert(SuretyRouter.GasOutOfRange.selector);
        router.setReceiveGas(BASE_CHAIN, 1_000_001, 1);
        vm.expectRevert(SuretyRouter.GasOutOfRange.selector);
        router.setReceiveGas(BASE_CHAIN, 1, 0);
        vm.expectRevert(SuretyRouter.GasOutOfRange.selector);
        router.setReceiveGas(BASE_CHAIN, 1, 300_001);
        bytes memory byDefault = router.optionsFor(BASE_CHAIN, 3);
        router.setReceiveGas(BASE_CHAIN, 200_000, 50_000);
        vm.stopPrank();

        check(keccak256(byDefault) == keccak256(_type3(100_000 + 3 * 100_000)), "default options");
        check(keccak256(router.optionsFor(BASE_CHAIN, 3)) == keccak256(_type3(350_000)), "configured options");
        check(keccak256(router.optionsFor(OTHER, 3)) == keccak256(byDefault), "setting leaked to another chain");

        vm.prank(RELAY);
        vm.expectRevert(SuretyRouter.NotRelay.selector);
        router.payClaim(bytes32("c"), PROVIDER, ALICE, 1 * USDC, bytes32(0));
        vm.prank(NOBODY);
        router.payClaim(bytes32("c"), PROVIDER, ALICE, 1 * USDC, bytes32(0));
        check(usdc.balanceOf(ALICE) == 1 * USDC, "the new relay cannot file claims");
    }

    function _type3(uint128 gas) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), gas);
    }

    function test_constructors_refuseZeroAddresses_andSetWhatTheyAreGiven() public {
        vm.expectRevert(SuretyRouter.ZeroAddress.selector);
        new SuretyRouter(address(world.monad), OWNER, address(0), RELAY);
        vm.expectRevert(SuretyRouter.ZeroAddress.selector);
        new SuretyRouter(address(world.monad), OWNER, address(vault), address(0));
        vm.expectRevert(SuretyOutpost.ZeroAddress.selector);
        new SuretyOutpost(address(base), OWNER, IERC20(address(0)), MONAD);

        check(address(router.vault()) == address(vault) && address(router.usdc()) == address(usdc), "router wiring");
        check(router.relay() == RELAY && outpost.hubEid() == MONAD && address(outpost.usdc()) == address(usdcBase), "wiring");
        (uint64 s, uint64 r) = router.oAppVersion();
        check(s == 1 && r == 0, "router claims it can receive");
    }

    function test_ownership_isTwoStepOnBoth() public {
        vm.startPrank(OWNER);
        router.transferOwnership(NOBODY);
        outpost.transferOwnership(NOBODY);
        vm.stopPrank();
        check(router.owner() == OWNER && outpost.owner() == OWNER, "ownership moved without acceptance");
        vm.startPrank(NOBODY);
        router.acceptOwnership();
        outpost.acceptOwnership();
        vm.stopPrank();
        check(router.owner() == NOBODY && outpost.owner() == NOBODY, "ownership not accepted");
    }

    // ------------------------------------------------------------------- gas

    /// @dev Worst case for the default gas: every agent is new to the token, so every transfer
    ///      writes a fresh balance. 40,000 is set aside for the real endpoint's own work, and the
    ///      total must still leave 15% unused.
    function test_gas_aFullBatchFitsWithRoomToSpare() public {
        _float(1_000 * USDC);
        _checkGas(1, 0x600000);
        _checkGas(20, 0x700000);
    }

    function _checkGas(uint256 n, uint160 from) internal {
        for (uint256 i = 0; i < n; ++i) _claim(address(from + uint160(i)), 1 * USDC);
        base.deliver(_flush());
        uint256 given = base.lastGasGiven();
        check(given == 100_000 + 100_000 * n, "unexpected gas bought");
        check((base.lastGasUsed() + 40_000) * 100 <= given * 85, "less than 15% gas headroom");
        check(usdcBase.balanceOf(address(from + uint160(n - 1))) == 1 * USDC, "batch not paid");
    }

    function test_gas_aCreditCostsNoMoreThanAPayment() public {
        for (uint256 i = 0; i < 20; ++i) _claim(address(uint160(0x800000 + i)), 1 * USDC);
        base.deliver(_flush()); // no float: all 20 become credits
        check((base.lastGasUsed() + 40_000) * 100 <= base.lastGasGiven() * 85, "credits do not fit the gas bought");
        check(outpost.totalCredit() == 20 * USDC, "credits");
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_codecRoundTrip(bytes32 id, address agent, uint128 amount, uint8 extra) public view {
        uint256 n = 1 + (extra % 5);
        bytes memory m = RefundCodec.encodeHeader();
        for (uint256 i = 0; i < n; ++i) m = bytes.concat(m, RefundCodec.encodeRefund(id, agent, amount));
        check(m.length == 1 + 68 * n && codec.count(m) == n, "size or count");
        (bytes32 a, address b, uint128 c) = codec.refund(m, n - 1);
        check(a == id && b == agent && c == amount, "fields");
    }

    /// @dev Any number of refunds to a handful of agents, any float, batches delivered in a
    ///      shuffled order, then the float topped up and everyone collected. Each agent must end
    ///      with exactly the sum of its refunds, and the router must hold exactly what was sent.
    function testFuzz_everyAgentEndsWithExactlyItsRefunds(uint256 seed, uint8 count, uint64 float) public {
        uint256 n = bound(count, 1, 45);
        address[4] memory agents = [ALICE, BOB, address(0xCA401), address(0xDA7E)];
        uint256[4] memory owed;
        uint256 total;
        for (uint256 i = 0; i < n; ++i) {
            uint256 who = uint256(keccak256(abi.encode(seed, i))) % 4;
            uint256 amount = 1 + uint256(keccak256(abi.encode(seed, i, "amt"))) % (5 * USDC);
            owed[who] += _claim(agents[who], amount);
            total += amount;
        }
        _float(bound(float, 0, total));

        uint256 batches = (n + 19) / 20;
        uint256[] memory index = new uint256[](batches);
        for (uint256 i = 0; i < batches; ++i) index[i] = _flush();
        for (uint256 i = batches; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, "shuffle", i))) % i;
            (index[i - 1], index[j]) = (index[j], index[i - 1]);
        }
        for (uint256 i = 0; i < batches; ++i) base.deliver(index[i]);

        check(outpost.totalPaid() + outpost.totalCredit() == total, "paid plus owed != refunds sent");
        check(router.reimbursable() == total && router.pendingTotal() == 0, "router books");
        check(usdc.balanceOf(address(router)) == total, "router balance");

        _float(total);
        for (uint256 i = 0; i < 4; ++i) {
            if (outpost.credit(agents[i]) != 0) outpost.collect(agents[i]);
            check(usdcBase.balanceOf(agents[i]) == owed[i], "an agent did not end with its refunds");
        }
        check(outpost.totalCredit() == 0 && outpost.totalPaid() == total, "end books");
    }

    function testFuzz_onlyTheRelayFilesClaims_onlyTheOwnerMovesMoney(address caller) public {
        vm.assume(caller != RELAY && caller != OWNER);
        _claim(ALICE, 1 * USDC);
        _flush();
        vm.startPrank(caller);
        vm.expectRevert(SuretyRouter.NotRelay.selector);
        router.payClaimRemote(bytes32("z"), PROVIDER, caller, 1 * USDC, bytes32(0), BASE_CHAIN);
        vm.expectRevert(SuretyRouter.NotRelay.selector);
        router.payClaim(bytes32("z"), PROVIDER, caller, 1 * USDC, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        router.sweep(caller, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        router.setRelay(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        outpost.withdrawFloat(caller, 1);
        vm.stopPrank();
    }
}
