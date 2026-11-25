// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SuretyVault} from "../../contracts/SuretyVault.sol";
import {MockUSDC} from "../../contracts/test/MockUSDC.sol";

/// @dev The handful of Foundry cheatcodes these tests use, declared here so the suite
///      needs nothing beyond `forge` itself (no forge-std checkout, no git submodule).
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function assume(bool) external pure;
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant USDC = 1e6;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant DAY = 1 days;

    address internal constant OWNER = address(0xA11CE);
    address internal constant ARBITER = address(0xA4B1);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant AGENT = address(0xA6E47);

    /// @dev Folds any fuzzed number into [lo, hi].
    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        require(lo <= hi, "bound: lo > hi");
        if (hi - lo == type(uint256).max) return x;
        return lo + (x % (hi - lo + 1));
    }

    function deployVault(uint256 minBond, uint64 delay, uint16 feeBps) internal returns (SuretyVault vault, MockUSDC usdc) {
        usdc = new MockUSDC();
        vault = new SuretyVault(usdc, OWNER, ARBITER, TREASURY, minBond, delay, feeBps);
    }

    function fund(MockUSDC usdc, SuretyVault vault, address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev A provider's record, read into memory in one piece. (The public getter returns ten
    ///      values, which is more than Solidity can hold on the stack alongside a test's own.)
    struct P {
        bool registered;
        uint64 bondReadyAt;
        uint64 claimCount;
        uint128 bond;
        uint128 bondPendingWithdraw;
        uint128 backingAssets;
        uint128 claimsPaid;
        uint256 backingShares;
        uint256 backingSharesPending;
        string metadataURI;
    }

    function read(SuretyVault vault, address provider) internal view returns (P memory) {
        (bool ok, bytes memory data) = address(vault).staticcall(abi.encodeWithSignature("providers(address)", provider));
        require(ok, "providers() failed");
        return abi.decode(bytes.concat(bytes32(uint256(32)), data), (P));
    }

    function check(bool ok, string memory what) internal pure {
        require(ok, what);
    }
}
