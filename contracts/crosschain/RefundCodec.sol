// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RefundCodec
/// @notice The wire format SuretyRouter sends and SuretyOutpost reads.
///
///         header (1 byte)     version: uint8
///         refund (68 bytes)   claimId: bytes32 | agent: address | amount: uint128
///
///         A message is the header followed by 1 or more refunds.
library RefundCodec {
    uint8 internal constant VERSION = 1;
    uint256 internal constant HEADER_SIZE = 1;
    uint256 internal constant REFUND_SIZE = 68;

    error UnsupportedVersion(uint8 version);
    error BadLength(uint256 length);

    function encodeHeader() internal pure returns (bytes memory) {
        return abi.encodePacked(VERSION);
    }

    function encodeRefund(bytes32 claimId, address agent, uint128 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(claimId, agent, amount);
    }

    /// @notice Check the shape of a message and return how many refunds it carries.
    function count(bytes calldata message) internal pure returns (uint256) {
        uint256 length = message.length;
        if (length < HEADER_SIZE + REFUND_SIZE || (length - HEADER_SIZE) % REFUND_SIZE != 0) revert BadLength(length);
        uint8 version = uint8(message[0]);
        if (version != VERSION) revert UnsupportedVersion(version);
        return (length - HEADER_SIZE) / REFUND_SIZE;
    }

    /// @dev `index` must be below what `count` returned.
    function decodeRefund(bytes calldata message, uint256 index)
        internal
        pure
        returns (bytes32 claimId, address agent, uint128 amount)
    {
        uint256 o = HEADER_SIZE + index * REFUND_SIZE;
        claimId = bytes32(message[o:o + 32]);
        agent = address(bytes20(message[o + 32:o + 52]));
        amount = uint128(bytes16(message[o + 52:o + 68]));
    }
}
