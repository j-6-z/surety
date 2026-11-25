// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {SuretyVault} from "../../contracts/SuretyVault.sol";
import {MockUSDC} from "../../contracts/test/MockUSDC.sol";
import {MockEndpoint} from "../../contracts/test/MockEndpoint.sol";
import {SuretyBeacon} from "../../contracts/crosschain/SuretyBeacon.sol";
import {SuretyMirror} from "../../contracts/crosschain/SuretyMirror.sol";
import {CoverageCodec} from "../../contracts/crosschain/CoverageCodec.sol";
import {Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Exposes the codec's calldata decoders so a test can call them.
contract CodecHarness {
    function header(bytes calldata m) external pure returns (uint64, uint128, uint256) {
        return CoverageCodec.decodeHeader(m);
    }

    function report(bytes calldata m, uint256 i) external pure returns (CoverageCodec.Report memory) {
        return CoverageCodec.decodeReport(m, i);
    }
}

/// @notice The vault on "Monad", a beacon beside it, a mirror on "Base", and a mock LayerZero
///         endpoint on each side that lets a test deliver messages in any order.
contract CrosschainTest is Base {
    uint32 internal constant MONAD = 30390;
    uint32 internal constant BASE_CHAIN = 30184;
    uint32 internal constant OTHER = 30101;
    uint64 internal constant MAX_AGE = 1 hours;
    uint256 internal constant T0 = 1_800_000_000;

    SuretyVault internal vault;
    MockUSDC internal usdc;
    MockEndpoint internal monad;
    MockEndpoint internal base;
    SuretyBeacon internal beacon;
    SuretyMirror internal mirror;
    CodecHarness internal codec;

    address internal constant PROVIDER = address(0x9001);
    address internal constant OTHER_PROVIDER = address(0x9002);
    address internal constant NOBODY = address(0xDEAD1);

    receive() external payable {}

    function setUp() public {
        vm.warp(T0);
        (vault, usdc) = deployVault(1 * USDC, 7 days, 500);
        monad = new MockEndpoint(MONAD);
        base = new MockEndpoint(BASE_CHAIN);
        monad.setRemote(BASE_CHAIN, base);
        beacon = new SuretyBeacon(address(monad), OWNER, address(vault));
        mirror = new SuretyMirror(address(base), OWNER, MONAD, MAX_AGE);
        vm.startPrank(OWNER);
        beacon.setPeer(BASE_CHAIN, _b32(address(mirror)));
        mirror.setPeer(MONAD, _b32(address(beacon)));
        vm.stopPrank();
        codec = new CodecHarness();
        _bond(PROVIDER, 10 * USDC);
    }

    // ---------------------------------------------------------------- helpers

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _bond(address provider, uint256 amount) internal {
        fund(usdc, vault, provider, amount);
        vm.startPrank(provider);
        if (!read(vault, provider).registered) vault.register("ipfs://sla");
        vault.depositBond(amount);
        vm.stopPrank();
    }

    function _one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    function _many(uint256 n) internal pure returns (address[] memory list) {
        list = new address[](n);
        for (uint256 i = 0; i < n; ++i) list[i] = address(uint160(0x100000 + i));
    }

    /// @dev Broadcast and leave the packet waiting on the Base side. Returns its inbox index.
    function _send(address[] memory providers) internal returns (uint256 index) {
        index = base.inboxLength();
        beacon.broadcast{value: beacon.quote(BASE_CHAIN, providers)}(BASE_CHAIN, providers);
    }

    function _sync(address provider) internal {
        base.deliver(_send(_one(provider)));
    }

    function _stored(address provider) internal view returns (SuretyMirror.Coverage memory c) {
        (c,) = mirror.coverageOf(provider);
    }

    function _msg(uint64 observedAt, uint128 ceiling, address provider, bool covered, uint128 cover)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(
            CoverageCodec.encodeHeader(observedAt, ceiling),
            CoverageCodec.encodeReport(CoverageCodec.Report(provider, covered, cover, cover, cover))
        );
    }

    // ------------------------------------------------------------ happy path

    function test_broadcast_copiesTheVaultToTheMirror() public {
        check(!mirror.isCovered(PROVIDER), "covered before any report");
        _sync(PROVIDER);

        (SuretyMirror.Coverage memory c, bool fresh) = mirror.coverageOf(PROVIDER);
        check(fresh && mirror.isCovered(PROVIDER), "not covered after report");
        check(c.covered == vault.isCovered(PROVIDER), "covered");
        check(c.cover == vault.coverOf(PROVIDER) && c.cover == 10 * USDC, "cover");
        check(c.committedCover == vault.committedCoverOf(PROVIDER), "committed cover");
        check(c.dailyAllowance == vault.dailyAllowance(PROVIDER) && c.dailyAllowance == 2 * USDC, "allowance");
        check(c.observedAt == T0 && c.nonce == 1, "stamp");
        check(mirror.maxClaimPayout() == vault.maxClaimPayout(), "claim ceiling");
        check(mirror.lastObservedAt() == T0 && mirror.lastNonce() == 1, "last seen");
    }

    function test_broadcast_reportsAnUnknownProviderAsNotCovered() public {
        _sync(NOBODY);
        (SuretyMirror.Coverage memory c, bool fresh) = mirror.coverageOf(NOBODY);
        check(fresh && !c.covered && c.cover == 0 && c.dailyAllowance == 0, "unknown provider");
        check(!mirror.isCovered(NOBODY), "unknown provider covered");
    }

    function test_broadcast_carriesLossOfCover() public {
        _sync(PROVIDER);
        vm.prank(PROVIDER);
        vault.requestBondWithdraw(10 * USDC);
        vm.warp(T0 + 5);
        _sync(PROVIDER);

        SuretyMirror.Coverage memory c = _stored(PROVIDER);
        check(!mirror.isCovered(PROVIDER) && !c.covered, "still covered after exit was queued");
        check(c.cover == 10 * USDC && c.committedCover == 0, "queued bond is still slashable but not committed");
    }

    function test_broadcast_carriesADailyLimitThatIsUsedUp() public {
        vm.prank(OWNER);
        vault.setMaxClaimPayout(3 * USDC);
        vm.prank(ARBITER);
        vault.payClaim(keccak256("c1"), PROVIDER, AGENT, 2 * USDC, bytes32(0));
        _sync(PROVIDER);
        check(vault.isActive(PROVIDER) && !mirror.isCovered(PROVIDER), "limit used up but mirror says covered");
        check(_stored(PROVIDER).dailyAllowance == 0, "allowance");
    }

    function test_broadcast_chargesTheQuoteAndReturnsTheRest() public {
        address[] memory list = _one(PROVIDER);
        uint256 fee = beacon.quote(BASE_CHAIN, list);
        check(fee != 0, "free");
        uint256 before = address(this).balance;
        beacon.broadcast{value: fee + 1 ether}(BASE_CHAIN, list);
        check(before - address(this).balance == fee, "kept more than the fee");
        check(address(beacon).balance == 0, "beacon holds funds");

        vm.expectRevert();
        beacon.broadcast{value: fee - 1}(BASE_CHAIN, list);
    }

    function test_quote_growsWithTheBatch() public view {
        check(beacon.quote(BASE_CHAIN, _many(10)) > beacon.quote(BASE_CHAIN, _many(1)), "flat fee");
    }

    // ---------------------------------------------------------- beacon refusals

    function test_beacon_refusesEmptyAndOversizedBatches() public {
        address[] memory none = new address[](0);
        vm.expectRevert(SuretyBeacon.EmptyBatch.selector);
        beacon.broadcast(BASE_CHAIN, none);
        vm.expectRevert(SuretyBeacon.EmptyBatch.selector);
        beacon.quote(BASE_CHAIN, none);

        address[] memory tooMany = _many(21);
        vm.expectRevert(abi.encodeWithSelector(SuretyBeacon.BatchTooLarge.selector, 21, 20));
        beacon.broadcast(BASE_CHAIN, tooMany);
        vm.expectRevert(abi.encodeWithSelector(SuretyBeacon.BatchTooLarge.selector, 21, 20));
        beacon.quote(BASE_CHAIN, tooMany);
        beacon.quote(BASE_CHAIN, _many(20));
    }

    function test_beacon_refusesAChainWithNoPeer() public {
        address[] memory list = _one(PROVIDER);
        vm.expectRevert(abi.encodeWithSignature("NoPeer(uint32)", OTHER));
        beacon.quote(OTHER, list);
        vm.expectRevert(abi.encodeWithSignature("NoPeer(uint32)", OTHER));
        beacon.broadcast{value: 1 ether}(OTHER, list);
    }

    function test_beacon_refusesAZeroVault() public {
        vm.expectRevert(SuretyBeacon.ZeroAddress.selector);
        new SuretyBeacon(address(monad), OWNER, address(0));
    }

    function test_beacon_isSendOnly() public view {
        (uint64 sender, uint64 receiver) = beacon.oAppVersion();
        check(sender == 1 && receiver == 0, "beacon claims it can receive");
    }

    function test_beacon_gasSettings() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        beacon.setReceiveGas(BASE_CHAIN, 100_000, 50_000);

        vm.startPrank(OWNER);
        vm.expectRevert(SuretyBeacon.GasOutOfRange.selector);
        beacon.setReceiveGas(BASE_CHAIN, 0, 50_000);
        vm.expectRevert(SuretyBeacon.GasOutOfRange.selector);
        beacon.setReceiveGas(BASE_CHAIN, 1_000_001, 50_000);
        vm.expectRevert(SuretyBeacon.GasOutOfRange.selector);
        beacon.setReceiveGas(BASE_CHAIN, 100_000, 0);
        vm.expectRevert(SuretyBeacon.GasOutOfRange.selector);
        beacon.setReceiveGas(BASE_CHAIN, 100_000, 200_001);

        bytes memory byDefault = beacon.optionsFor(BASE_CHAIN, 3);
        check(keccak256(byDefault) == keccak256(_type3(100_000 + 3 * 65_000)), "default options");
        beacon.setReceiveGas(BASE_CHAIN, 100_000, 50_000);
        vm.stopPrank();
        check(keccak256(beacon.optionsFor(BASE_CHAIN, 3)) == keccak256(_type3(250_000)), "configured options");
        check(keccak256(beacon.optionsFor(OTHER, 3)) == keccak256(byDefault), "setting leaked to another chain");
    }

    /// @dev LayerZero type-3 options with a single executor lzReceive option, written out by hand:
    ///      type | worker id | option size | option type | gas
    function _type3(uint128 gas) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), gas);
    }

    // ---------------------------------------------------------- mirror refusals

    function test_mirror_onlyTheEndpointCanDeliver() public {
        bytes memory m = _msg(uint64(T0), 1, PROVIDER, true, 1);
        vm.expectRevert(abi.encodeWithSignature("OnlyEndpoint(address)", address(this)));
        mirror.lzReceive(Origin(MONAD, _b32(address(beacon)), 1), bytes32(0), m, address(0), "");
    }

    function test_mirror_onlyTheBeaconCanSend() public {
        bytes memory m = _msg(uint64(T0), 1, PROVIDER, true, 1);
        vm.expectRevert(abi.encodeWithSignature("OnlyPeer(uint32,bytes32)", MONAD, _b32(NOBODY)));
        base.deliverRaw(address(mirror), Origin(MONAD, _b32(NOBODY), 1), m);
        vm.expectRevert(abi.encodeWithSignature("NoPeer(uint32)", OTHER));
        base.deliverRaw(address(mirror), Origin(OTHER, _b32(address(beacon)), 1), m);
    }

    function test_mirror_refusesAnotherChainEvenWithAPeerSet() public {
        vm.prank(OWNER);
        mirror.setPeer(OTHER, _b32(NOBODY));
        vm.expectRevert(abi.encodeWithSelector(SuretyMirror.NotFromHub.selector, OTHER));
        base.deliverRaw(address(mirror), Origin(OTHER, _b32(NOBODY), 1), _msg(uint64(T0), 1, PROVIDER, true, 1));
        check(!mirror.isCovered(PROVIDER), "accepted a report from another chain");
    }

    function test_mirror_refusesMalformedMessages() public {
        Origin memory o = Origin(MONAD, _b32(address(beacon)), 1);
        bytes memory good = _msg(uint64(T0), 1, PROVIDER, true, 1);

        bytes memory headerOnly = CoverageCodec.encodeHeader(uint64(T0), 1);
        vm.expectRevert(abi.encodeWithSelector(CoverageCodec.BadLength.selector, 25));
        base.deliverRaw(address(mirror), o, headerOnly);

        bytes memory ragged = bytes.concat(good, hex"00");
        vm.expectRevert(abi.encodeWithSelector(CoverageCodec.BadLength.selector, 95));
        base.deliverRaw(address(mirror), o, ragged);

        vm.expectRevert(abi.encodeWithSelector(CoverageCodec.BadLength.selector, 0));
        base.deliverRaw(address(mirror), o, "");

        good[0] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(CoverageCodec.UnsupportedVersion.selector, 2));
        base.deliverRaw(address(mirror), o, good);
    }

    function test_mirror_maxAgeSettings() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        mirror.setMaxAge(2 hours);

        vm.startPrank(OWNER);
        vm.expectRevert(SuretyMirror.MaxAgeOutOfRange.selector);
        mirror.setMaxAge(59);
        vm.expectRevert(SuretyMirror.MaxAgeOutOfRange.selector);
        mirror.setMaxAge(7 days + 1);
        mirror.setMaxAge(2 hours);
        vm.stopPrank();
        check(mirror.maxAge() == 2 hours, "maxAge");

        vm.expectRevert(SuretyMirror.MaxAgeOutOfRange.selector);
        new SuretyMirror(address(base), OWNER, MONAD, 0);
    }

    function test_ownership_isTwoStepOnBoth() public {
        vm.startPrank(OWNER);
        beacon.transferOwnership(NOBODY);
        mirror.transferOwnership(NOBODY);
        vm.stopPrank();
        check(beacon.owner() == OWNER && mirror.owner() == OWNER, "ownership moved without acceptance");
        check(beacon.pendingOwner() == NOBODY && mirror.pendingOwner() == NOBODY, "no pending owner");

        vm.startPrank(NOBODY);
        beacon.acceptOwnership();
        mirror.acceptOwnership();
        vm.stopPrank();
        check(beacon.owner() == NOBODY && mirror.owner() == NOBODY, "ownership not accepted");
    }

    // ------------------------------------------------------- order and age

    function test_mirror_keepsTheNewestWhenMessagesArriveBackwards() public {
        uint256 first = _send(_one(PROVIDER)); // says: covered, 10 USDC
        vm.prank(PROVIDER);
        vault.requestBondWithdraw(10 * USDC);
        vm.warp(T0 + 10);
        uint256 second = _send(_one(PROVIDER)); // says: not covered

        base.deliver(second);
        base.deliver(first);
        SuretyMirror.Coverage memory c = _stored(PROVIDER);
        check(!c.covered && c.observedAt == T0 + 10 && c.nonce == 2, "an older report overwrote a newer one");
        check(mirror.lastObservedAt() == T0 + 10 && mirror.lastNonce() == 2, "last seen went backwards");
    }

    function test_mirror_ordersSameSecondMessagesByNonce() public {
        uint256 first = _send(_one(PROVIDER));
        vm.prank(PROVIDER);
        vault.requestBondWithdraw(10 * USDC);
        vm.prank(OWNER);
        vault.setMaxClaimPayout(7);
        uint256 second = _send(_one(PROVIDER)); // same block time, later nonce

        base.deliver(second);
        base.deliver(first);
        check(!_stored(PROVIDER).covered && _stored(PROVIDER).nonce == 2, "same-second report out of order");
        check(mirror.maxClaimPayout() == 7, "claim ceiling went backwards");
    }

    function test_mirror_ignoresARepeatedMessage() public {
        _sync(PROVIDER);
        Origin memory o = Origin(MONAD, _b32(address(beacon)), 1);
        base.deliverRaw(address(mirror), o, _msg(uint64(T0), 99, PROVIDER, false, 0));
        check(mirror.isCovered(PROVIDER) && mirror.maxClaimPayout() == vault.maxClaimPayout(), "repeat was applied");
    }

    function test_mirror_updatesOnlyTheProvidersThatAreNewer() public {
        _bond(OTHER_PROVIDER, 4 * USDC);
        address[] memory both = new address[](2);
        both[0] = PROVIDER;
        both[1] = OTHER_PROVIDER;
        uint256 batch = _send(both);
        vm.warp(T0 + 30);
        _bond(PROVIDER, 5 * USDC);
        _sync(PROVIDER); // newer report for PROVIDER only

        base.deliver(batch); // older batch arrives late
        check(_stored(PROVIDER).cover == 15 * USDC && _stored(PROVIDER).observedAt == T0 + 30, "newer report lost");
        check(_stored(OTHER_PROVIDER).cover == 4 * USDC && _stored(OTHER_PROVIDER).observedAt == T0, "other provider skipped");
    }

    function test_mirror_stopsTrustingAnOldReport() public {
        _sync(PROVIDER);
        vm.warp(T0 + MAX_AGE);
        check(mirror.isCovered(PROVIDER), "stale one second early");
        vm.warp(T0 + MAX_AGE + 1);
        (SuretyMirror.Coverage memory c, bool fresh) = mirror.coverageOf(PROVIDER);
        check(!mirror.isCovered(PROVIDER) && !fresh && c.covered, "old report still trusted");

        _sync(PROVIDER);
        check(mirror.isCovered(PROVIDER), "refresh did not restore cover");
    }

    function test_mirror_acceptsAReplacementBeacon() public {
        _sync(PROVIDER);
        _sync(PROVIDER);
        _sync(PROVIDER); // nonce is now 3
        SuretyBeacon next = new SuretyBeacon(address(monad), OWNER, address(vault));
        vm.startPrank(OWNER);
        next.setPeer(BASE_CHAIN, _b32(address(mirror)));
        mirror.setPeer(MONAD, _b32(address(next)));
        vm.stopPrank();

        vm.warp(T0 + 60);
        address[] memory list = _one(PROVIDER);
        uint256 index = base.inboxLength();
        next.broadcast{value: next.quote(BASE_CHAIN, list)}(BASE_CHAIN, list);
        base.deliver(index);
        check(_stored(PROVIDER).observedAt == T0 + 60 && _stored(PROVIDER).nonce == 1, "new beacon locked out");

        // The old beacon is no longer the peer, so anything it sends now is refused.
        uint256 late = _send(list);
        vm.expectRevert();
        base.deliver(late);
    }

    // ------------------------------------------------------------------- gas

    /// @dev Worst case for the gas the beacon buys by default: every provider is bonded and new to
    ///      the mirror, so every report writes two fresh storage slots. On a real chain the
    ///      endpoint's own bookkeeping runs inside the same limit, so 40,000 is set aside for it,
    ///      and the total must still leave 15% unused.
    function test_gas_aFullBatchFitsWithRoomToSpare() public {
        _checkGas(1, 0x200000);
        _checkGas(20, 0x300000);
    }

    function _checkGas(uint256 n, uint160 from) internal {
        address[] memory list = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            list[i] = address(from + uint160(i));
            _bond(list[i], 3 * USDC);
        }
        base.deliver(_send(list));
        uint256 given = base.lastGasGiven();
        check(given == 100_000 + 65_000 * n, "unexpected gas bought");
        check((base.lastGasUsed() + 40_000) * 100 <= given * 85, "less than 15% gas headroom");
        check(_stored(list[n - 1]).cover == 3 * USDC, "batch not stored");
    }

    function test_gas_tooLittleGasFailsCleanlyAndCanBeRetried() public {
        vm.prank(OWNER);
        beacon.setReceiveGas(BASE_CHAIN, 1, 1);
        uint256 index = _send(_one(PROVIDER));
        vm.expectRevert();
        base.deliver(index);
        check(_stored(PROVIDER).observedAt == 0, "half-applied report");
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_codecRoundTrip(
        uint64 observedAt,
        uint128 ceiling,
        address provider,
        bool covered,
        uint128 cover,
        uint128 committed,
        uint128 allowance,
        uint8 extra
    ) public view {
        uint256 n = 1 + (extra % 5);
        bytes memory m = CoverageCodec.encodeHeader(observedAt, ceiling);
        CoverageCodec.Report memory r = CoverageCodec.Report(provider, covered, cover, committed, allowance);
        for (uint256 i = 0; i < n; ++i) m = bytes.concat(m, CoverageCodec.encodeReport(r));
        check(m.length == 25 + 69 * n, "size");

        (uint64 t, uint128 c, uint256 count) = codec.header(m);
        check(t == observedAt && c == ceiling && count == n, "header");
        CoverageCodec.Report memory out = codec.report(m, n - 1);
        check(out.provider == provider && out.covered == covered, "provider or flag");
        check(out.cover == cover && out.committedCover == committed && out.dailyAllowance == allowance, "amounts");
    }

    /// @dev Six reports sent one after another, each after a change to the vault, then delivered
    ///      in an arbitrary order. Whatever the order, the mirror must end on the last one sent,
    ///      and what it holds must never step back to an older report on the way.
    function testFuzz_anyDeliveryOrderEndsOnTheLastReport(uint256 seed, uint8 gaps) public {
        uint256 n = 6;
        uint256[] memory index = new uint256[](n);
        uint256 lastCover;
        uint256 lastTime;
        for (uint256 i = 0; i < n; ++i) {
            if ((gaps >> i) & 1 == 1) vm.warp(block.timestamp + 1 + (seed >> (i * 8)) % 600);
            _bond(PROVIDER, 1 * USDC);
            index[i] = _send(_one(PROVIDER));
            lastCover = vault.coverOf(PROVIDER);
            lastTime = block.timestamp;
        }
        for (uint256 i = n; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % i;
            (index[i - 1], index[j]) = (index[j], index[i - 1]);
        }
        uint256 seenTime;
        uint256 seenNonce;
        for (uint256 i = 0; i < n; ++i) {
            base.deliver(index[i]);
            SuretyMirror.Coverage memory c = _stored(PROVIDER);
            check(c.observedAt > seenTime || (c.observedAt == seenTime && c.nonce >= seenNonce), "stepped back");
            (seenTime, seenNonce) = (c.observedAt, c.nonce);
        }
        SuretyMirror.Coverage memory end = _stored(PROVIDER);
        check(end.cover == lastCover && end.observedAt == lastTime && end.nonce == n, "did not end on the last report");
    }

    function testFuzz_coveredExactlyWhileFresh(uint64 maxAge, uint64 wait) public {
        maxAge = uint64(bound(maxAge, 1 minutes, 7 days));
        wait = uint64(bound(wait, 0, 14 days));
        vm.prank(OWNER);
        mirror.setMaxAge(maxAge);
        _sync(PROVIDER);
        vm.warp(T0 + wait);
        check(mirror.isCovered(PROVIDER) == (wait <= maxAge), "freshness boundary");
    }

    function testFuzz_anyBatchSizeIsDeliveredInFull(uint8 size, uint64 salt) public {
        uint256 n = bound(size, 1, 20);
        address[] memory list = new address[](n);
        for (uint256 i = 0; i < n; ++i) list[i] = address(uint160(uint256(keccak256(abi.encode(salt, i)))));
        base.deliver(_send(list));
        for (uint256 i = 0; i < n; ++i) check(_stored(list[i]).observedAt == T0, "report missing");
    }

    /// @dev Whoever calls broadcast, and whatever they ask about, the mirror ends up holding
    ///      exactly what the vault says. The caller has no say in the content.
    function testFuzz_callerCannotChangeWhatIsSaid(address caller, uint96 bond) public {
        vm.assume(caller != address(0) && caller.code.length == 0 && uint160(caller) > 0xffff);
        vm.assume(caller != address(vm) && caller != 0x000000000000000000636F6e736F6c652e6c6f67);
        _bond(OTHER_PROVIDER, bound(bond, 1, 1_000_000 * USDC));
        address[] memory list = _one(OTHER_PROVIDER);
        uint256 fee = beacon.quote(BASE_CHAIN, list);
        vm.deal(caller, fee);
        uint256 index = base.inboxLength();
        vm.prank(caller);
        beacon.broadcast{value: fee}(BASE_CHAIN, list);
        base.deliver(index);

        SuretyMirror.Coverage memory c = _stored(OTHER_PROVIDER);
        check(c.covered == vault.isCovered(OTHER_PROVIDER) && c.cover == vault.coverOf(OTHER_PROVIDER), "content differs");
        check(c.dailyAllowance == vault.dailyAllowance(OTHER_PROVIDER), "allowance differs");
    }
}
