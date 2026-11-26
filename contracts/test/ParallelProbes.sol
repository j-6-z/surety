// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev MEASUREMENT ONLY. No access control, never to be deployed. Two ways of holding provider
///      bonds, stripped to the storage each one touches when a claim is paid, so that
///      scripts/parallel.js can compare how they behave under Monad's parallel execution.

/// @dev How SuretyVault works today: one contract holds every provider's USDC, and each claim
///      sends the fee to the treasury. Every claim therefore changes the pool's token balance
///      and the treasury's, whichever provider it is against.
contract PooledBondsProbe {
    IERC20 public immutable usdc;
    address public immutable treasury;
    mapping(address => uint256) public bond;

    constructor(IERC20 _usdc, address _treasury) {
        usdc = _usdc;
        treasury = _treasury;
    }

    function deposit(uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        bond[msg.sender] += amount;
    }

    function claim(address provider, address agent, uint256 payout) external {
        uint256 fee = payout / 20;
        bond[provider] -= payout + fee;
        usdc.transfer(agent, payout);
        usdc.transfer(treasury, fee);
    }
}

/// @dev One escrow per provider. Its USDC balance is its own slot in the token, and the fee is
///      counted inside the escrow and collected later, so a claim touches nothing another
///      provider's claim touches.
contract ProviderEscrowProbe {
    IERC20 public immutable usdc;
    address public immutable treasury;
    uint256 public bond;
    uint256 public feesOwed;

    constructor(IERC20 _usdc, address _treasury) {
        usdc = _usdc;
        treasury = _treasury;
    }

    function deposit(uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        bond += amount;
    }

    function claim(address agent, uint256 payout) external {
        uint256 fee = payout / 20;
        bond -= payout + fee;
        feesOwed += fee;
        usdc.transfer(agent, payout);
    }

    function collectFees() external {
        uint256 fees = feesOwed;
        feesOwed = 0;
        usdc.transfer(treasury, fees);
    }
}
