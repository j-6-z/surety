// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessagingParams, MessagingFee, MessagingReceipt, Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {ILayerZeroReceiver} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";
import {ExecutorOptions} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/libs/ExecutorOptions.sol";

/// @dev Test-only stand-in for LayerZero's EndpointV2: just the calls an OApp makes.
///      One instance per pretend chain. `send` charges a fee, hands out a nonce per pathway and
///      queues the packet on the destination's MockEndpoint. A test then calls `deliver(i)` in any
///      order it likes, which is how out-of-order arrival is tested. Delivery runs lzReceive with
///      exactly the gas the sender's options bought, as a real executor would.
contract MockEndpoint {
    struct Packet {
        Origin origin;
        address receiver;
        bytes32 guid;
        bytes message;
        uint128 gas;
        bool delivered;
    }

    uint32 public immutable eid;
    uint256 public baseFee = 0.001 ether;
    uint256 public feePerByte = 1 gwei;
    uint256 public feePerGas = 1 gwei;

    mapping(uint32 => MockEndpoint) public remotes;
    mapping(address => address) public delegates;
    mapping(address sender => mapping(uint32 dstEid => mapping(bytes32 receiver => uint64))) public outboundNonce;
    Packet[] public inbox;
    /// @dev Gas the receiver's lzReceive used in the latest `deliver`, and what it was given.
    uint256 public lastGasUsed;
    uint256 public lastGasGiven;

    error NoRemote(uint32 dstEid);
    error InsufficientFee(uint256 required, uint256 provided);
    error AlreadyDelivered();
    error BadOptions();

    constructor(uint32 _eid) {
        eid = _eid;
    }

    function setRemote(uint32 dstEid, MockEndpoint remote) external {
        remotes[dstEid] = remote;
    }

    function setDelegate(address delegate) external {
        delegates[msg.sender] = delegate;
    }

    function lzToken() external pure returns (address) {
        return address(0);
    }

    function quote(MessagingParams calldata p, address) public view returns (MessagingFee memory) {
        return MessagingFee(baseFee + p.message.length * feePerByte + uint256(_gasOf(p.options)) * feePerGas, 0);
    }

    function send(MessagingParams calldata p, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory receipt)
    {
        MockEndpoint remote = remotes[p.dstEid];
        if (address(remote) == address(0)) revert NoRemote(p.dstEid);
        MessagingFee memory fee = quote(p, msg.sender);
        if (msg.value < fee.nativeFee) revert InsufficientFee(fee.nativeFee, msg.value);

        uint64 nonce = ++outboundNonce[msg.sender][p.dstEid][p.receiver];
        bytes32 sender = bytes32(uint256(uint160(msg.sender)));
        bytes32 guid = keccak256(abi.encodePacked(nonce, eid, sender, p.dstEid, p.receiver));
        remote.enqueue(Origin(eid, sender, nonce), address(uint160(uint256(p.receiver))), guid, p.message, _gasOf(p.options));

        if (msg.value > fee.nativeFee) {
            (bool ok,) = refundAddress.call{value: msg.value - fee.nativeFee}("");
            require(ok, "refund failed");
        }
        return MessagingReceipt(guid, nonce, fee);
    }

    /// @dev Called by the sending chain's MockEndpoint. Open in the mock; the real thing needs DVNs.
    function enqueue(Origin calldata origin, address receiver, bytes32 guid, bytes calldata message, uint128 gas)
        external
    {
        inbox.push(Packet(origin, receiver, guid, message, gas, false));
    }

    function inboxLength() external view returns (uint256) {
        return inbox.length;
    }

    /// @dev Run packet `index` with the gas its options paid for. Reverts if lzReceive does.
    function deliver(uint256 index) external {
        Packet storage p = inbox[index];
        if (p.delivered) revert AlreadyDelivered();
        p.delivered = true;
        Origin memory origin = p.origin;
        (address receiver, bytes32 guid, bytes memory message, uint256 gas) = (p.receiver, p.guid, p.message, p.gas);
        uint256 before = gasleft();
        ILayerZeroReceiver(receiver).lzReceive{gas: gas}(origin, guid, message, msg.sender, "");
        lastGasUsed = before - gasleft();
        lastGasGiven = gas;
    }

    /// @dev Run a packet the test made up, to check what a receiver does with a forged origin or body.
    function deliverRaw(address receiver, Origin calldata origin, bytes calldata message) external payable {
        ILayerZeroReceiver(receiver).lzReceive{value: msg.value}(origin, bytes32(0), message, msg.sender, "");
    }

    /// @dev Sum of the lzReceive gas in type-3 options, read with LayerZero's own decoder.
    function _gasOf(bytes calldata options) private pure returns (uint128 gas) {
        if (options.length < 2 || uint16(bytes2(options[0:2])) != 3) revert BadOptions();
        uint256 cursor = 2;
        while (cursor < options.length) {
            (uint8 optionType, bytes calldata option, uint256 next) = ExecutorOptions.nextExecutorOption(options, cursor);
            if (optionType == ExecutorOptions.OPTION_TYPE_LZRECEIVE) {
                (uint128 g,) = ExecutorOptions.decodeLzReceiveOption(option);
                gas += g;
            }
            cursor = next;
        }
    }
}
