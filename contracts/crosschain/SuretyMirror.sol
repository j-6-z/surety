// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {OAppReceiver, OAppCore, Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppReceiver.sol";
import {CoverageCodec} from "./CoverageCodec.sol";

/// @title SuretyMirror
/// @notice Lives on a chain other than Monad (Base first). Holds the latest thing the Monad
///         SuretyVault said about each provider, as delivered by SuretyBeacon over LayerZero.
///
///         Read `isCovered(provider)` before paying a provider on this chain. It is true only if
///         the vault said the provider was covered AND that report is recent enough to trust.
///
///         - Receive-only: it cannot send messages and holds no funds.
///         - Accepts messages from one place only: the beacon set as peer for the Monad endpoint.
///         - LayerZero does not promise delivery in the order sent, so each provider's record
///           keeps the newest report by (time observed on Monad, message nonce) and drops older ones.
///         - This is a copy, so it lags. `maxAge` is how old a report may be before `isCovered`
///           stops trusting it. Anyone can refresh a provider by calling `broadcast` on the beacon.
contract SuretyMirror is OAppReceiver, Ownable2Step {
    /// @notice The LayerZero endpoint id of the chain the vault is on. Messages from any other
    ///         chain are refused even if the owner sets a peer for it by mistake.
    uint32 public immutable hubEid;

    uint64 public constant MIN_MAX_AGE = 1 minutes;
    uint64 public constant MAX_MAX_AGE = 7 days;

    /// @dev Packed into two storage slots (8 + 7 + 1 + 16 bytes, then 16 + 16), which is most of
    ///      what a delivery costs. LayerZero nonces are uint64; 56 bits is still 7e16 messages.
    struct Coverage {
        uint64 observedAt; // Monad block time when the vault was read
        uint56 nonce; // LayerZero nonce of the message that carried it
        bool covered;
        uint128 cover;
        uint128 committedCover;
        uint128 dailyAllowance;
    }

    mapping(address provider => Coverage) private _coverage;

    /// @notice How old a report may be before `isCovered` treats the provider as not covered.
    uint64 public maxAge;
    /// @notice Monad block time and LayerZero nonce of the newest message seen.
    uint64 public lastObservedAt;
    uint56 public lastNonce;
    /// @notice The vault's per-claim ceiling, from the newest message seen.
    uint128 public maxClaimPayout;

    event CoverageUpdated(
        address indexed provider,
        bool covered,
        uint128 cover,
        uint128 committedCover,
        uint128 dailyAllowance,
        uint64 observedAt,
        uint56 nonce
    );
    event OlderReportIgnored(address indexed provider, uint64 observedAt, uint56 nonce);
    event MaxAgeSet(uint64 maxAge);

    error NotFromHub(uint32 srcEid);
    error MaxAgeOutOfRange();

    /// @param _endpoint LayerZero EndpointV2 on this chain.
    /// @param _owner Sets the peer and maxAge, and is the endpoint delegate.
    /// @param _hubEid LayerZero endpoint id of the chain the vault and beacon are on.
    /// @param _maxAge Starting freshness window, in seconds.
    constructor(address _endpoint, address _owner, uint32 _hubEid, uint64 _maxAge)
        OAppCore(_endpoint, _owner)
        Ownable(_owner)
    {
        hubEid = _hubEid;
        _setMaxAge(_maxAge);
    }

    // ------------------------------------------------------------------ reads

    /// @notice True if the vault reported this provider as covered and the report is still fresh.
    ///         False for a provider never reported, a stale report, or one reported as not covered.
    function isCovered(address provider) external view returns (bool) {
        Coverage storage c = _coverage[provider];
        return c.covered && _fresh(c.observedAt);
    }

    /// @notice The stored report for a provider, and whether it is still inside the freshness window.
    function coverageOf(address provider) external view returns (Coverage memory coverage, bool fresh) {
        coverage = _coverage[provider];
        fresh = _fresh(coverage.observedAt);
    }

    // ------------------------------------------------------------------ owner

    function setMaxAge(uint64 _maxAge) external onlyOwner {
        _setMaxAge(_maxAge);
    }

    // ------------------------------------------------------------------ receiving

    /// @dev OAppReceiver has already checked the caller is the endpoint and the sender is the peer.
    function _lzReceive(Origin calldata origin, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
    {
        if (origin.srcEid != hubEid) revert NotFromHub(origin.srcEid);
        (uint64 observedAt, uint128 claimCeiling, uint256 count) = CoverageCodec.decodeHeader(message);
        uint56 nonce = uint56(origin.nonce);

        if (observedAt > lastObservedAt || (observedAt == lastObservedAt && nonce > lastNonce)) {
            lastObservedAt = observedAt;
            lastNonce = nonce;
            maxClaimPayout = claimCeiling;
        }
        for (uint256 i = 0; i < count; ++i) {
            _record(CoverageCodec.decodeReport(message, i), observedAt, nonce);
        }
    }

    /// @dev Keep the report if it is newer than what is stored for that provider, else drop it.
    ///      Within one beacon, send order, observedAt and nonce all rise together, so comparing
    ///      (observedAt, nonce) puts reports back in the order they were sent. Time comes first so
    ///      that a replacement beacon, whose nonces start again at 1, is not locked out.
    function _record(CoverageCodec.Report memory r, uint64 observedAt, uint56 nonce) private {
        Coverage storage c = _coverage[r.provider];
        if (observedAt < c.observedAt || (observedAt == c.observedAt && nonce <= c.nonce)) {
            emit OlderReportIgnored(r.provider, observedAt, nonce);
            return;
        }
        c.observedAt = observedAt;
        c.nonce = nonce;
        c.covered = r.covered;
        c.cover = r.cover;
        c.committedCover = r.committedCover;
        c.dailyAllowance = r.dailyAllowance;
        emit CoverageUpdated(r.provider, r.covered, r.cover, r.committedCover, r.dailyAllowance, observedAt, nonce);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Never reported means observedAt == 0, which is stale on any real chain.
    function _fresh(uint64 observedAt) private view returns (bool) {
        return observedAt != 0 && block.timestamp <= uint256(observedAt) + maxAge;
    }

    function _setMaxAge(uint64 _maxAge) private {
        if (_maxAge < MIN_MAX_AGE || _maxAge > MAX_MAX_AGE) revert MaxAgeOutOfRange();
        maxAge = _maxAge;
        emit MaxAgeSet(_maxAge);
    }

    // Ownable2Step and OAppCore both descend from Ownable; these pick the two-step versions.
    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }
}
