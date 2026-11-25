// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {SuretyVault} from "../../contracts/SuretyVault.sol";
import {BlockableUSDC} from "../../contracts/test/BlockableUSDC.sol";
import {MockEndpoint} from "../../contracts/test/MockEndpoint.sol";
import {SuretyRouter} from "../../contracts/crosschain/SuretyRouter.sol";
import {SuretyOutpost} from "../../contracts/crosschain/SuretyOutpost.sol";

/// @dev The whole stage-two setup in one place: the vault on "Monad" with the router as its
///      arbiter, the outpost on "Base" with its own USDC, and a mock LayerZero endpoint each side.
abstract contract SettlementBase is Base {
    uint32 internal constant MONAD = 30390;
    uint32 internal constant BASE_CHAIN = 30184;
    uint32 internal constant OTHER = 30101;
    uint256 internal constant T0 = 1_800_000_000;

    address internal constant RELAY = address(0x4E1A7);
    address internal constant PROVIDER = address(0x9001);
    address internal constant NOBODY = address(0xDEAD1);

    struct World {
        SuretyVault vault;
        BlockableUSDC usdc; // USDC on Monad
        BlockableUSDC usdcBase; // USDC on Base: a different token contract on a different chain
        MockEndpoint monad;
        MockEndpoint base;
        SuretyRouter router;
        SuretyOutpost outpost;
    }

    function b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// @dev Limits are opened wide so tests of the router are not tripped by the vault's caps;
    ///      the tests about those caps set them back.
    function deployWorld() internal returns (World memory w) {
        w.usdc = new BlockableUSDC();
        w.usdcBase = new BlockableUSDC();
        w.vault = new SuretyVault(w.usdc, OWNER, ARBITER, TREASURY, 1 * USDC, 7 days, 500);
        w.monad = new MockEndpoint(MONAD);
        w.base = new MockEndpoint(BASE_CHAIN);
        w.monad.setRemote(BASE_CHAIN, w.base);
        w.router = new SuretyRouter(address(w.monad), OWNER, address(w.vault), RELAY);
        w.outpost = new SuretyOutpost(address(w.base), OWNER, w.usdcBase, MONAD);
        vm.startPrank(OWNER);
        w.router.setPeer(BASE_CHAIN, b32(address(w.outpost)));
        w.outpost.setPeer(MONAD, b32(address(w.router)));
        w.vault.setArbiter(address(w.router));
        w.vault.setMaxClaimPayout(100 * USDC);
        w.vault.setMaxDailySlashBps(10_000);
        vm.stopPrank();

        w.usdc.mint(PROVIDER, 1_000_000 * USDC);
        vm.startPrank(PROVIDER);
        w.usdc.approve(address(w.vault), type(uint256).max);
        w.vault.register("ipfs://sla");
        w.vault.depositBond(100_000 * USDC);
        vm.stopPrank();
    }
}
