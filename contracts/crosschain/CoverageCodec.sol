// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CoverageCodec
/// @notice The wire format SuretyBeacon sends and SuretyMirror reads.
///
///         header (25 bytes)   version: uint8 | observedAt: uint64 | maxClaimPayout: uint128
///         report (69 bytes)   provider: address | covered: bool | cover: uint128
///                             | committedCover: uint128 | dailyAllowance: uint128
///
///         A message is one header followed by 1 or more reports. Packed rather than
///         abi.encode'd: a report is 69 bytes instead of 160, and LayerZero fees grow with size.
library CoverageCodec {
    uint8 internal constant VERSION = 1;
    uint256 internal constant HEADER_SIZE = 25;
    uint256 internal constant REPORT_SIZE = 69;

    /// @dev What the vault said about one provider at the moment the beacon read it.
    struct Report {
        address provider;
        bool covered; // vault.isCovered: active, and today's refund limit not used up
        uint128 cover; // vault.coverOf: everything that can pay claims, queued exits included
        uint128 committedCover; // vault.committedCoverOf: cover that is not queued to leave
        uint128 dailyAllowance; // vault.dailyAllowance: what can still be paid out today
    }

    error UnsupportedVersion(uint8 version);
    error BadLength(uint256 length);

    function encodeHeader(uint64 observedAt, uint128 maxClaimPayout) internal pure returns (bytes memory) {
        return abi.encodePacked(VERSION, observedAt, maxClaimPayout);
    }

    function encodeReport(Report memory r) internal pure returns (bytes memory) {
        return abi.encodePacked(r.provider, r.covered, r.cover, r.committedCover, r.dailyAllowance);
    }

    /// @notice Check the shape of a message and read its header.
    /// @return observedAt Monad block time when the beacon read the vault.
    /// @return maxClaimPayout The vault's per-claim ceiling at that moment.
    /// @return count How many reports follow.
    function decodeHeader(bytes calldata message)
        internal
        pure
        returns (uint64 observedAt, uint128 maxClaimPayout, uint256 count)
    {
        uint256 length = message.length;
        if (length < HEADER_SIZE + REPORT_SIZE || (length - HEADER_SIZE) % REPORT_SIZE != 0) revert BadLength(length);
        uint8 version = uint8(message[0]);
        if (version != VERSION) revert UnsupportedVersion(version);
        observedAt = uint64(bytes8(message[1:9]));
        maxClaimPayout = uint128(bytes16(message[9:25]));
        count = (length - HEADER_SIZE) / REPORT_SIZE;
    }

    /// @dev `index` must be below the count decodeHeader returned.
    function decodeReport(bytes calldata message, uint256 index) internal pure returns (Report memory r) {
        uint256 o = HEADER_SIZE + index * REPORT_SIZE;
        r.provider = address(bytes20(message[o:o + 20]));
        r.covered = uint8(message[o + 20]) != 0;
        r.cover = uint128(bytes16(message[o + 21:o + 37]));
        r.committedCover = uint128(bytes16(message[o + 37:o + 53]));
        r.dailyAllowance = uint128(bytes16(message[o + 53:o + 69]));
    }
}
