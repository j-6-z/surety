// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only token with configurable decimals.
contract MockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Test-only stand-in for a Uniswap V3 pool: just the views the price reader uses.
contract MockV3Pool {
    address public token0;
    address public token1;
    uint24 public fee;
    uint160 private _sqrtPriceX96;

    constructor(address a, address b, uint24 fee_, uint160 sqrtPriceX96_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
        _sqrtPriceX96 = sqrtPriceX96_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (_sqrtPriceX96, 0, 0, 0, 0, 0, true);
    }
}

/// @dev Test-only stand-in for the Uniswap V3 factory.
contract MockV3Factory {
    mapping(bytes32 => address) private _pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        _pools[keccak256(abi.encode(t0, t1, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return _pools[keccak256(abi.encode(t0, t1, fee))];
    }
}
