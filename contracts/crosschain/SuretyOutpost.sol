// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OAppReceiver, OAppCore, Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppReceiver.sol";
import {RefundCodec} from "./RefundCodec.sol";

/// @title SuretyOutpost
/// @notice Lives on a chain other than Monad (Base first) and pays refunds there. It holds a
///         float of USDC. When a batch of refunds arrives from the SuretyRouter on Monad, each
///         agent is paid from the float.
///
///         A refund the outpost cannot pay right now is never lost and never blocks the others:
///         it becomes a `credit` for that agent, which anyone can turn into a payment with
///         `collect(agent)` once the float is topped up. That covers an empty float and a token
///         that refuses the transfer (USDC can block an address).
///
///         - Receive-only, and only from the router set as peer on the Monad endpoint.
///         - The owner can take out spare float, never the part owed as credits.
///         - The refund itself was already settled on Monad: the provider's bond was slashed and
///           the money set aside in the router before the message was sent.
contract SuretyOutpost is OAppReceiver, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    /// @notice The LayerZero endpoint id of the chain the vault and router are on.
    uint32 public immutable hubEid;

    /// @notice Refunds that arrived but could not be paid yet, per agent.
    mapping(address agent => uint256) public credit;
    uint256 public totalCredit;
    /// @notice Everything this outpost has ever paid to agents.
    uint256 public totalPaid;

    event RefundPaid(bytes32 indexed claimId, address indexed agent, uint256 amount);
    event RefundCredited(bytes32 indexed claimId, address indexed agent, uint256 amount);
    event Collected(address indexed agent, uint256 amount);
    event FloatWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error NotFromHub(uint32 srcEid);
    error NothingOwed();
    error FloatEmpty();
    error MoreThanSpareFloat(uint256 amount, uint256 spare);

    /// @param _endpoint LayerZero EndpointV2 on this chain.
    /// @param _owner Sets the peer, withdraws spare float. Also the endpoint delegate.
    /// @param _usdc The token refunds are paid in on this chain.
    /// @param _hubEid LayerZero endpoint id of the chain the vault and router are on.
    constructor(address _endpoint, address _owner, IERC20 _usdc, uint32 _hubEid)
        OAppCore(_endpoint, _owner)
        Ownable(_owner)
    {
        if (address(_usdc) == address(0)) revert ZeroAddress();
        usdc = _usdc;
        hubEid = _hubEid;
    }

    // ------------------------------------------------------------------ reads

    /// @notice Float that is not spoken for by credits. New refunds are paid from this.
    function spareFloat() public view returns (uint256) {
        uint256 balance = usdc.balanceOf(address(this));
        return balance > totalCredit ? balance - totalCredit : 0;
    }

    // ------------------------------------------------------------------ paying

    /// @notice Pay `agent` what it is owed in credits, or as much of it as the outpost holds.
    ///         Anyone may call this for any agent; the money only ever goes to the agent.
    function collect(address agent) external nonReentrant returns (uint256 paid) {
        uint256 owed = credit[agent];
        if (owed == 0) revert NothingOwed();
        uint256 balance = usdc.balanceOf(address(this));
        if (balance == 0) revert FloatEmpty();
        paid = owed < balance ? owed : balance;
        credit[agent] = owed - paid;
        totalCredit -= paid;
        totalPaid += paid;
        usdc.safeTransfer(agent, paid);
        emit Collected(agent, paid);
    }

    /// @notice Take out float that no credit has a claim on. To add float, send USDC here.
    function withdrawFloat(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 spare = spareFloat();
        if (amount > spare) revert MoreThanSpareFloat(amount, spare);
        usdc.safeTransfer(to, amount);
        emit FloatWithdrawn(to, amount);
    }

    // ------------------------------------------------------------------ receiving

    /// @dev OAppReceiver has already checked the caller is the endpoint and the sender is the peer.
    ///      Refunds are independent of each other, so the order messages arrive in does not matter.
    function _lzReceive(Origin calldata origin, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
        nonReentrant
    {
        if (origin.srcEid != hubEid) revert NotFromHub(origin.srcEid);
        uint256 n = RefundCodec.count(message);
        for (uint256 i = 0; i < n; ++i) {
            (bytes32 claimId, address agent, uint128 amount) = RefundCodec.decodeRefund(message, i);
            if (_tryPay(agent, amount)) {
                totalPaid += amount;
                emit RefundPaid(claimId, agent, amount);
            } else {
                credit[agent] += amount;
                totalCredit += amount;
                emit RefundCredited(claimId, agent, amount);
            }
        }
    }

    // ------------------------------------------------------------------ internals

    /// @dev Pays from spare float only, so an agent already waiting on a credit is not jumped.
    ///      A transfer the token refuses returns false instead of reverting, so one bad address
    ///      cannot stop a whole batch from being delivered.
    function _tryPay(address to, uint256 amount) private returns (bool) {
        if (spareFloat() < amount) return false;
        (bool ok, bytes memory result) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (result.length == 0 || abi.decode(result, (bool)));
    }

    // Ownable2Step and OAppCore both descend from Ownable; these pick the two-step versions.
    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }
}
