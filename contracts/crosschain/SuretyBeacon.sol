// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {OAppSender, OAppCore, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {CoverageCodec} from "./CoverageCodec.sol";

/// @dev The parts of SuretyVault the beacon reads. It never writes to the vault.
interface ISuretyVaultView {
    function isCovered(address provider) external view returns (bool);
    function coverOf(address provider) external view returns (uint256);
    function committedCoverOf(address provider) external view returns (uint256);
    function dailyAllowance(address provider) external view returns (uint256);
    function maxClaimPayout() external view returns (uint256);
}

/// @title SuretyBeacon
/// @notice Lives on Monad next to the SuretyVault. Anyone can call `broadcast` to send the vault's
///         current view of a set of providers to a SuretyMirror on another chain over LayerZero,
///         so contracts and agents there can check "is this provider bonded?" without a bridge
///         or an API call.
///
///         - The caller chooses WHICH providers and WHEN, and pays the LayerZero fee. They cannot
///           choose WHAT is said: every number is read from the vault inside this call.
///         - Send-only. It has no lzReceive, so no message from another chain can reach it.
///         - It has no role on the vault and holds no funds.
contract SuretyBeacon is OAppSender, Ownable2Step {
    using OptionsBuilder for bytes;
    using SafeCast for uint256;

    /// @notice Most providers one message may carry.
    uint256 public constant MAX_BATCH = 20;
    /// @notice Destination gas used when the owner has not set a figure for that chain.
    ///         Measured on the mirror: a provider it has not seen before costs about 50,000 gas
    ///         (two fresh storage slots), and the fixed part about 36,000 on the first delivery.
    ///         The rest of the base is for the endpoint's own bookkeeping, which runs inside the
    ///         same gas limit. test_gas_aFullBatchFitsWithRoomToSpare holds these to a margin.
    uint64 public constant DEFAULT_BASE_GAS = 100_000;
    uint64 public constant DEFAULT_GAS_PER_PROVIDER = 65_000;
    /// @notice Upper bounds on the owner's gas settings, so a mistake cannot price broadcasts out.
    uint64 public constant MAX_BASE_GAS = 1_000_000;
    uint64 public constant MAX_GAS_PER_PROVIDER = 200_000;

    ISuretyVaultView public immutable vault;

    struct ReceiveGas {
        uint64 base;
        uint64 perProvider;
    }

    /// @notice Gas bought for lzReceive on each destination: base + perProvider * reports.
    mapping(uint32 dstEid => ReceiveGas) public receiveGas;

    event Broadcast(uint32 indexed dstEid, bytes32 indexed guid, uint64 nonce, uint64 observedAt, uint256 providers);
    event ReceiveGasSet(uint32 indexed dstEid, uint64 base, uint64 perProvider);

    error ZeroAddress();
    error EmptyBatch();
    error BatchTooLarge(uint256 size, uint256 max);
    error GasOutOfRange();

    /// @param _endpoint LayerZero EndpointV2 on this chain.
    /// @param _owner Sets peers and gas, and is the endpoint delegate (DVN and library config).
    /// @param _vault The SuretyVault to report on.
    constructor(address _endpoint, address _owner, address _vault) OAppCore(_endpoint, _owner) Ownable(_owner) {
        if (_vault == address(0)) revert ZeroAddress();
        vault = ISuretyVaultView(_vault);
    }

    // ------------------------------------------------------------------ sending

    /// @notice The fee, in this chain's native token, to broadcast these providers to `dstEid` now.
    function quote(uint32 dstEid, address[] calldata providers) external view returns (uint256 nativeFee) {
        _checkBatch(providers.length);
        return _quote(dstEid, _message(providers), optionsFor(dstEid, providers.length), false).nativeFee;
    }

    /// @notice Read the vault for each provider and send the result to the mirror on `dstEid`.
    ///         Send at least `quote(...)` as value; anything over the fee comes back to the caller.
    /// @return guid LayerZero's id for the message. Look it up on layerzeroscan.com.
    function broadcast(uint32 dstEid, address[] calldata providers) external payable returns (bytes32 guid) {
        _checkBatch(providers.length);
        MessagingReceipt memory receipt = _lzSend(
            dstEid,
            _message(providers),
            optionsFor(dstEid, providers.length),
            MessagingFee(msg.value, 0),
            payable(msg.sender)
        );
        emit Broadcast(dstEid, receipt.guid, receipt.nonce, uint64(block.timestamp), providers.length);
        return receipt.guid;
    }

    /// @notice The executor options a broadcast of `count` providers to `dstEid` is sent with.
    ///         Built here rather than taken from the caller, because the gas the mirror needs
    ///         depends on the batch size and a caller could otherwise send a message too
    ///         under-gassed to be delivered.
    function optionsFor(uint32 dstEid, uint256 count) public view returns (bytes memory) {
        ReceiveGas memory g = receiveGas[dstEid];
        if (g.base == 0) g = ReceiveGas(DEFAULT_BASE_GAS, DEFAULT_GAS_PER_PROVIDER);
        uint256 gas = uint256(g.base) + uint256(g.perProvider) * count;
        return OptionsBuilder.newOptions().addExecutorLzReceiveOption(gas.toUint128(), 0);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Set the destination gas for one chain. Chains price storage differently, so the
    ///         defaults (sized for an OP-stack chain such as Base) may not fit all of them.
    function setReceiveGas(uint32 dstEid, uint64 base, uint64 perProvider) external onlyOwner {
        if (base == 0 || base > MAX_BASE_GAS || perProvider == 0 || perProvider > MAX_GAS_PER_PROVIDER) {
            revert GasOutOfRange();
        }
        receiveGas[dstEid] = ReceiveGas(base, perProvider);
        emit ReceiveGasSet(dstEid, base, perProvider);
    }

    // ------------------------------------------------------------------ internals

    function _checkBatch(uint256 size) private pure {
        if (size == 0) revert EmptyBatch();
        if (size > MAX_BATCH) revert BatchTooLarge(size, MAX_BATCH);
    }

    function _message(address[] calldata providers) private view returns (bytes memory message) {
        message = CoverageCodec.encodeHeader(uint64(block.timestamp), vault.maxClaimPayout().toUint128());
        for (uint256 i = 0; i < providers.length; ++i) {
            address provider = providers[i];
            message = bytes.concat(
                message,
                CoverageCodec.encodeReport(
                    CoverageCodec.Report({
                        provider: provider,
                        covered: vault.isCovered(provider),
                        cover: vault.coverOf(provider).toUint128(),
                        committedCover: vault.committedCoverOf(provider).toUint128(),
                        dailyAllowance: vault.dailyAllowance(provider).toUint128()
                    })
                )
            );
        }
    }

    // Ownable2Step and OAppCore both descend from Ownable; these pick the two-step versions.
    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }
}
