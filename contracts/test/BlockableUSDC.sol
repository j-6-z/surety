// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "./MockUSDC.sol";

/// @dev Test-only USDC that can refuse transfers to chosen addresses, as real USDC can.
contract BlockableUSDC is MockUSDC {
    mapping(address => bool) public blocked;

    function setBlocked(address who, bool isBlocked) external {
        blocked[who] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}
