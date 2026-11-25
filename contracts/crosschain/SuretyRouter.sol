// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {OAppSender, OAppCore, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {RefundCodec} from "./RefundCodec.sol";

/// @dev The parts of SuretyVault the router uses.
interface ISuretyVaultClaims {
    function usdc() external view returns (IERC20);
    function payClaim(bytes32 claimId, address provider, address agent, uint256 payout, bytes32 evidenceHash) external;
}

/// @title SuretyRouter
/// @notice Lives on Monad and is set as the SuretyVault's arbiter, so that a refund can be paid
///         to an agent on another chain. The vault itself does not change.
///
///         A refund for a payer on Monad passes straight through to the vault (`payClaim`).
///         A refund for a payer on another chain (`payClaimRemote`) works in two steps:
///
///         1. Settle. The vault pays the router instead of the agent. The provider's bond is
///            slashed at once and the money is set aside here, in a queue for that chain.
///         2. Deliver. `flush` sends up to 20 queued refunds in one LayerZero message to the
///            SuretyOutpost on that chain, which pays each agent from a float of USDC it holds.
///
///         Delivery is batched because one LayerZero message costs far more than one refund is
///         worth. Anyone may call `flush` and pay the fee, so an agent never has to wait on the
///         operator. Once a batch is sent, the USDC behind it becomes `reimbursable`: the owner
///         may take it out to top the outpost's float back up. Money still in a queue cannot be
///         taken by anyone.
///
///         What the router can do to the vault is exactly what the arbiter could: pay claims,
///         within the vault's own per-claim and per-day limits. It adds no new power over funds.
contract SuretyRouter is OAppSender, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using OptionsBuilder for bytes;
    using SafeCast for uint256;

    /// @notice Most refunds one message may carry.
    uint256 public constant MAX_BATCH = 20;
    /// @notice Destination gas used when the owner has not set a figure for that chain.
    ///         A refund on the outpost is a USDC transfer to an address that may never have held
    ///         any, plus an event. test_gas_aFullBatchFitsWithRoomToSpare holds these to a margin.
    uint64 public constant DEFAULT_BASE_GAS = 100_000;
    uint64 public constant DEFAULT_GAS_PER_REFUND = 100_000;
    uint64 public constant MAX_BASE_GAS = 1_000_000;
    uint64 public constant MAX_GAS_PER_REFUND = 300_000;

    ISuretyVaultClaims public immutable vault;
    IERC20 public immutable usdc;

    /// @notice The only address that may file claims. This is the key the relay holds.
    address public relay;

    struct Pending {
        bytes32 claimId;
        address agent;
        uint96 amount;
    }

    struct Queue {
        uint256 head; // index of the next refund to send
        uint256 total; // USDC waiting in this queue
        Pending[] items;
    }

    struct ReceiveGas {
        uint64 base;
        uint64 perRefund;
    }

    mapping(uint32 dstEid => Queue) private _queues;
    mapping(uint32 dstEid => ReceiveGas) public receiveGas;

    /// @notice USDC settled but not yet sent, across every chain. Nobody can withdraw it.
    uint256 public pendingTotal;
    /// @notice USDC behind refunds already sent. The owner may take it to refill outpost floats.
    uint256 public reimbursable;

    event RelaySet(address relay);
    event RefundQueued(uint32 indexed dstEid, bytes32 indexed claimId, address indexed agent, uint256 amount);
    event Flushed(uint32 indexed dstEid, bytes32 indexed guid, uint64 nonce, uint256 refunds, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event ReceiveGasSet(uint32 indexed dstEid, uint64 base, uint64 perRefund);

    error ZeroAddress();
    error NotRelay();
    error NothingPending();
    error NothingReceived();
    error MoreThanReimbursable(uint256 amount, uint256 reimbursable);
    error GasOutOfRange();

    /// @param _endpoint LayerZero EndpointV2 on this chain.
    /// @param _owner Sets peers, gas and the relay; takes reimbursement. Also the endpoint delegate.
    /// @param _vault The SuretyVault this router will be arbiter of.
    /// @param _relay The key allowed to file claims.
    constructor(address _endpoint, address _owner, address _vault, address _relay)
        OAppCore(_endpoint, _owner)
        Ownable(_owner)
    {
        if (_vault == address(0) || _relay == address(0)) revert ZeroAddress();
        vault = ISuretyVaultClaims(_vault);
        usdc = ISuretyVaultClaims(_vault).usdc();
        relay = _relay;
        emit RelaySet(_relay);
    }

    modifier onlyRelay() {
        if (msg.sender != relay) revert NotRelay();
        _;
    }

    // ------------------------------------------------------------------ claims

    /// @notice A refund for a payer on this chain. Passed to the vault unchanged.
    function payClaim(bytes32 claimId, address provider, address agent, uint256 payout, bytes32 evidenceHash)
        external
        onlyRelay
    {
        vault.payClaim(claimId, provider, agent, payout, evidenceHash);
    }

    /// @notice A refund for a payer on another chain. The vault pays this contract; the amount it
    ///         really paid (it can be less than `payout` if the provider's cover is short) is
    ///         queued for `agent` on `dstEid`.
    /// @return received USDC taken from the provider's cover and queued.
    function payClaimRemote(
        bytes32 claimId,
        address provider,
        address agent,
        uint256 payout,
        bytes32 evidenceHash,
        uint32 dstEid
    ) external onlyRelay nonReentrant returns (uint256 received) {
        if (agent == address(0)) revert ZeroAddress();
        _getPeerOrRevert(dstEid); // never queue for a chain with no outpost
        // What arrived is measured, not assumed: the vault pays less than `payout` when cover is
        // short. This function cannot be re-entered (nonReentrant) and the vault only calls the
        // token, so nothing can move this balance in between except the vault's own payment.
        // slither-disable-next-line reentrancy-balance
        uint256 before = usdc.balanceOf(address(this));
        vault.payClaim(claimId, provider, address(this), payout, evidenceHash);
        received = usdc.balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived();

        Queue storage q = _queues[dstEid];
        q.items.push(Pending(claimId, agent, received.toUint96()));
        q.total += received;
        pendingTotal += received;
        emit RefundQueued(dstEid, claimId, agent, received);
    }

    // ------------------------------------------------------------------ delivery

    /// @notice How many refunds are waiting for `dstEid`, and how much USDC they add up to.
    function pending(uint32 dstEid) external view returns (uint256 refunds, uint256 amount) {
        Queue storage q = _queues[dstEid];
        return (q.items.length - q.head, q.total);
    }

    /// @notice The fee, in this chain's native token, to send the next batch to `dstEid` now.
    function quoteFlush(uint32 dstEid) external view returns (uint256 nativeFee) {
        (bytes memory message, uint256 n,) = _nextBatch(_queues[dstEid]);
        return _quote(dstEid, message, optionsFor(dstEid, n), false).nativeFee;
    }

    /// @notice Send the next batch of queued refunds (up to 20) to the outpost on `dstEid`.
    ///         Anyone may call this. Send at least `quoteFlush(dstEid)`; the rest comes back.
    function flush(uint32 dstEid) external payable nonReentrant returns (bytes32 guid, uint256 refunds) {
        Queue storage q = _queues[dstEid];
        uint256 amount;
        bytes memory message;
        (message, refunds, amount) = _nextBatch(q);

        for (uint256 i = 0; i < refunds; ++i) delete q.items[q.head + i];
        q.head += refunds;
        q.total -= amount;
        pendingTotal -= amount;
        reimbursable += amount;

        MessagingReceipt memory receipt =
            _lzSend(dstEid, message, optionsFor(dstEid, refunds), MessagingFee(msg.value, 0), payable(msg.sender));
        emit Flushed(dstEid, receipt.guid, receipt.nonce, refunds, amount);
        return (receipt.guid, refunds);
    }

    /// @notice The executor options a batch of `count` refunds to `dstEid` is sent with.
    function optionsFor(uint32 dstEid, uint256 count) public view returns (bytes memory) {
        ReceiveGas memory g = receiveGas[dstEid];
        if (g.base == 0) g = ReceiveGas(DEFAULT_BASE_GAS, DEFAULT_GAS_PER_REFUND);
        uint256 gas = uint256(g.base) + uint256(g.perRefund) * count;
        return OptionsBuilder.newOptions().addExecutorLzReceiveOption(gas.toUint128(), 0);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Replace the key that may file claims (for example after the server is rebuilt).
    function setRelay(address _relay) external onlyOwner {
        if (_relay == address(0)) revert ZeroAddress();
        relay = _relay;
        emit RelaySet(_relay);
    }

    /// @notice Take out USDC behind refunds that have already been sent, to refill a float.
    ///         Money still waiting in a queue is out of reach.
    function sweep(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > reimbursable) revert MoreThanReimbursable(amount, reimbursable);
        reimbursable -= amount;
        usdc.safeTransfer(to, amount);
        emit Swept(to, amount);
    }

    function setReceiveGas(uint32 dstEid, uint64 base, uint64 perRefund) external onlyOwner {
        if (base == 0 || base > MAX_BASE_GAS || perRefund == 0 || perRefund > MAX_GAS_PER_REFUND) {
            revert GasOutOfRange();
        }
        receiveGas[dstEid] = ReceiveGas(base, perRefund);
        emit ReceiveGasSet(dstEid, base, perRefund);
    }

    // ------------------------------------------------------------------ internals

    function _nextBatch(Queue storage q) private view returns (bytes memory message, uint256 n, uint256 amount) {
        n = q.items.length - q.head;
        if (n == 0) revert NothingPending();
        if (n > MAX_BATCH) n = MAX_BATCH;
        message = RefundCodec.encodeHeader();
        for (uint256 i = 0; i < n; ++i) {
            Pending storage p = q.items[q.head + i];
            message = bytes.concat(message, RefundCodec.encodeRefund(p.claimId, p.agent, p.amount));
            amount += p.amount;
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
