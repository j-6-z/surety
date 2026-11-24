// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title SuretyVault
/// @notice Underwriting layer for AI agent payments.
///         - Providers post a bond (in USDC) to get listed.
///         - Backers stake behind providers they trust and earn rewards.
///         - When a provider breaks its SLA, the arbiter pays the agent out of
///           the provider's bond first, then pro rata from backers.
///         - Exits wait out an unbonding delay, stay slashable while waiting, and
///           must be completed inside a short window. Funds queued for exit stop
///           counting toward a provider's active status and committed cover, so an
///           exit is always visible before it happens.
/// @dev The arbiter is a single trusted address for now. What it can move is bounded twice:
///      at most `maxClaimPayout` (plus fee) per claim, and per provider per UTC day at most
///      `maxDailySlashBps` of that provider's cover, plus the one claim that crosses the line.
///      So a stolen arbiter key drains slowly, and the owner has time to pause and replace it.
contract SuretyVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ------------------------------------------------------------------ types

    /// @dev Packed so a typical claim touches three storage slots. USDC amounts fit uint128.
    struct Provider {
        bool registered;
        uint64 bondReadyAt; // when a requested bond withdrawal can complete
        uint64 claimCount; // lifetime number of paid claims
        uint128 bond; // provider's own slashable stake
        uint128 bondPendingWithdraw; // part of `bond` queued for exit (still slashable)
        uint128 backingAssets; // USDC held for backers (moves with rewards and slashes)
        uint128 claimsPaid; // lifetime USDC paid out to agents
        uint256 backingShares; // total backer shares
        uint256 backingSharesPending; // backer shares queued for exit (still slashable)
        string metadataURI; // points to endpoint list + SLA terms
    }

    struct Unstake {
        uint256 shares;
        uint64 readyAt;
    }

    /// @dev One slot per provider: what has been slashed so far in the current UTC day.
    struct DailySlash {
        uint32 day; // days since the Unix epoch
        uint112 slashed; // payouts plus fees taken this day
        uint112 startCover; // the provider's cover when the day's first claim arrived
    }

    // ---------------------------------------------------------------- storage

    IERC20 public immutable usdc;
    uint256 private constant VIRTUAL_SHARES = 1e6; // blunts share-inflation attacks
    uint256 private constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000;
    uint64 public constant MIN_UNBONDING = 1 days;
    uint64 public constant MAX_UNBONDING = 30 days;
    uint256 public constant MIN_BACKING_FOR_REWARDS = 1e6; // 1 USDC
    /// @notice A matured exit must be completed within this long, or requested again.
    uint64 public constant EXIT_WINDOW = 3 days;
    /// @notice A new vault lets one claim take at most this share of the minimum bond.
    uint256 public constant DEFAULT_CLAIM_SHARE_BPS = 500; // 5%

    address public arbiter;
    address public treasury;
    uint256 public minProviderBond; // provider is active only with this much bond NOT queued for exit
    uint256 public maxClaimPayout; // cap on a single claim's payout
    uint64 public unbondingDelay; // seconds
    uint16 public slashFeeBps; // protocol cut taken on top of each payout, from the slashed funds
    uint16 public maxDailySlashBps; // share of a provider's cover that claims may take per UTC day

    mapping(address => Provider) public providers;
    mapping(address => mapping(address => uint256)) public backerShares; // provider => backer => shares
    mapping(address => mapping(address => Unstake)) public pendingUnstake; // provider => backer => request
    mapping(bytes32 => bool) public claimPaid; // claimId => paid
    mapping(address => DailySlash) public dailySlash; // provider => today's running total

    // ----------------------------------------------------------------- events

    event ProviderRegistered(address indexed provider, string metadataURI);
    event MetadataUpdated(address indexed provider, string metadataURI);
    event BondDeposited(address indexed provider, uint256 amount);
    event BondWithdrawRequested(address indexed provider, uint256 amount, uint64 readyAt);
    event BondWithdrawCancelled(address indexed provider);
    event BondWithdrawn(address indexed provider, uint256 amount);
    event Backed(address indexed provider, address indexed backer, uint256 assets, uint256 shares);
    event UnstakeRequested(address indexed provider, address indexed backer, uint256 shares, uint64 readyAt);
    event UnstakeCancelled(address indexed provider, address indexed backer);
    event Unstaked(address indexed provider, address indexed backer, uint256 shares, uint256 assets);
    event RewardsFunded(address indexed provider, address indexed from, uint256 amount);
    event ClaimPaid(
        bytes32 indexed claimId,
        address indexed provider,
        address indexed agent,
        uint256 payout,
        uint256 fromBond,
        uint256 fromBackers,
        uint256 fee,
        bytes32 evidenceHash
    );
    event ArbiterSet(address arbiter);
    event TreasurySet(address treasury);
    event ParamsSet(uint256 minProviderBond, uint64 unbondingDelay, uint16 slashFeeBps);
    event MaxClaimPayoutSet(uint256 maxClaimPayout);
    event MaxDailySlashBpsSet(uint16 maxDailySlashBps);

    // ----------------------------------------------------------------- errors

    error NotArbiter();
    error NotRegistered();
    error AlreadyRegistered();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBond();
    error InsufficientShares();
    error NothingPending();
    error StillUnbonding(uint64 readyAt);
    error ExitWindowClosed(uint64 closedAt);
    error ClaimAlreadyPaid();
    error PayoutTooLarge(uint256 payout, uint256 max);
    error NoCover();
    error NoBackers();
    error FeeTooHigh();
    error DelayOutOfRange();
    error DailyLimitReached(uint256 limit);
    error BpsOutOfRange();

    // ------------------------------------------------------------ constructor

    constructor(
        IERC20 _usdc,
        address _owner,
        address _arbiter,
        address _treasury,
        uint256 _minProviderBond,
        uint64 _unbondingDelay,
        uint16 _slashFeeBps
    ) Ownable(_owner) {
        if (address(_usdc) == address(0) || _arbiter == address(0) || _treasury == address(0)) revert ZeroAddress();
        _checkParams(_unbondingDelay, _slashFeeBps);
        usdc = _usdc;
        arbiter = _arbiter;
        treasury = _treasury;
        minProviderBond = _minProviderBond;
        // Paid API calls cost cents. One claim may take 5% of the minimum bond, and all of a day's
        // claims a fifth of the provider's cover, until the owner decides otherwise.
        maxClaimPayout = (_minProviderBond * DEFAULT_CLAIM_SHARE_BPS) / BPS;
        maxDailySlashBps = 2_000;
        unbondingDelay = _unbondingDelay;
        slashFeeBps = _slashFeeBps;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    modifier onlyRegistered(address provider) {
        if (!providers[provider].registered) revert NotRegistered();
        _;
    }

    // -------------------------------------------------------------- providers

    function register(string calldata metadataURI) external whenNotPaused {
        Provider storage p = providers[msg.sender];
        if (p.registered) revert AlreadyRegistered();
        p.registered = true;
        p.metadataURI = metadataURI;
        emit ProviderRegistered(msg.sender, metadataURI);
    }

    function setMetadata(string calldata metadataURI) external onlyRegistered(msg.sender) {
        providers[msg.sender].metadataURI = metadataURI;
        emit MetadataUpdated(msg.sender, metadataURI);
    }

    function depositBond(uint256 amount) external nonReentrant whenNotPaused onlyRegistered(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        providers[msg.sender].bond += amount.toUint128();
        emit BondDeposited(msg.sender, amount);
    }

    /// @notice Queue bond for exit. Replaces any earlier request. The queued amount stays
    ///         slashable but stops counting toward active status straight away.
    function requestBondWithdraw(uint256 amount) external onlyRegistered(msg.sender) {
        Provider storage p = providers[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > p.bond) revert InsufficientBond();
        uint64 readyAt = uint64(block.timestamp) + unbondingDelay;
        p.bondPendingWithdraw = uint128(amount);
        p.bondReadyAt = readyAt;
        emit BondWithdrawRequested(msg.sender, amount, readyAt);
    }

    function cancelBondWithdraw() external onlyRegistered(msg.sender) {
        Provider storage p = providers[msg.sender];
        if (p.bondPendingWithdraw == 0) revert NothingPending();
        p.bondPendingWithdraw = 0;
        p.bondReadyAt = 0;
        emit BondWithdrawCancelled(msg.sender);
    }

    function completeBondWithdraw() external nonReentrant onlyRegistered(msg.sender) {
        Provider storage p = providers[msg.sender];
        uint128 amount = p.bondPendingWithdraw; // payClaim keeps this <= bond
        if (amount == 0) revert NothingPending();
        _checkExitTime(p.bondReadyAt);
        p.bond -= amount;
        p.bondPendingWithdraw = 0;
        p.bondReadyAt = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- backers

    function back(address provider, uint256 assets)
        external
        nonReentrant
        whenNotPaused
        onlyRegistered(provider)
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        Provider storage p = providers[provider];
        shares = _toShares(p, assets);
        if (shares == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        p.backingAssets += assets.toUint128();
        p.backingShares += shares;
        backerShares[provider][msg.sender] += shares;
        emit Backed(provider, msg.sender, assets, shares);
    }

    /// @notice Queue shares for exit. Replaces any earlier request. Queued shares stay slashable
    ///         and keep earning, but stop counting toward the provider's committed cover.
    function requestUnstake(address provider, uint256 shares) external onlyRegistered(provider) {
        if (shares == 0) revert ZeroAmount();
        if (shares > backerShares[provider][msg.sender]) revert InsufficientShares();
        Provider storage p = providers[provider];
        Unstake storage u = pendingUnstake[provider][msg.sender];
        uint64 readyAt = uint64(block.timestamp) + unbondingDelay;
        p.backingSharesPending = p.backingSharesPending - u.shares + shares;
        u.shares = shares;
        u.readyAt = readyAt;
        emit UnstakeRequested(provider, msg.sender, shares, readyAt);
    }

    function cancelUnstake(address provider) external {
        Unstake memory u = pendingUnstake[provider][msg.sender];
        if (u.shares == 0) revert NothingPending();
        providers[provider].backingSharesPending -= u.shares;
        delete pendingUnstake[provider][msg.sender];
        emit UnstakeCancelled(provider, msg.sender);
    }

    function completeUnstake(address provider) external nonReentrant returns (uint256 assets) {
        Unstake memory u = pendingUnstake[provider][msg.sender];
        if (u.shares == 0) revert NothingPending();
        _checkExitTime(u.readyAt);
        Provider storage p = providers[provider];
        assets = _toAssets(p, u.shares); // valued now, so slashes during unbonding apply
        delete pendingUnstake[provider][msg.sender];
        backerShares[provider][msg.sender] -= u.shares;
        p.backingShares -= u.shares;
        p.backingSharesPending -= u.shares;
        p.backingAssets -= uint128(assets); // _toAssets never exceeds backingAssets
        usdc.safeTransfer(msg.sender, assets);
        emit Unstaked(provider, msg.sender, u.shares, assets);
    }

    /// @notice Anyone (usually the provider or protocol) can add USDC rewards for a provider's backers.
    ///         Rewards raise the value of every backer share. Needs at least 1 USDC already staked.
    function fundRewards(address provider, uint256 amount) external nonReentrant onlyRegistered(provider) {
        if (amount == 0) revert ZeroAmount();
        Provider storage p = providers[provider];
        // With nobody (or only dust) staked there is no one to receive rewards: they would be stranded.
        if (p.backingAssets < MIN_BACKING_FOR_REWARDS) revert NoBackers();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        p.backingAssets += amount.toUint128();
        emit RewardsFunded(provider, msg.sender, amount);
    }

    // ----------------------------------------------------------------- claims

    /// @notice Pay an agent for a proven SLA failure. Bond pays first, then backers pro rata.
    ///         If cover is short, the agent gets what is there and the fee shrinks first.
    /// @param claimId Unique id (the relay derives it from the x402 payment tx). Each pays once.
    /// @param payout USDC owed to the agent. The protocol fee is taken on top from the same funds.
    /// @param evidenceHash Hash of the evidence bundle (request, response, verifier report).
    function payClaim(bytes32 claimId, address provider, address agent, uint256 payout, bytes32 evidenceHash)
        external
        nonReentrant
        whenNotPaused
        onlyArbiter
        onlyRegistered(provider)
    {
        if (payout == 0) revert ZeroAmount();
        if (payout > maxClaimPayout) revert PayoutTooLarge(payout, maxClaimPayout);
        if (agent == address(0)) revert ZeroAddress();
        if (claimPaid[claimId]) revert ClaimAlreadyPaid();
        claimPaid[claimId] = true;

        Provider storage p = providers[provider];
        uint256 cover = uint256(p.bond) + p.backingAssets;
        if (cover == 0) revert NoCover();

        uint256 fee = (payout * slashFeeBps) / BPS;
        if (payout + fee > cover) {
            if (payout > cover) payout = cover;
            fee = cover - payout;
        }
        _countTowardDailyLimit(provider, cover, payout + fee);
        (uint256 fromBond, uint256 fromBackers) = _slash(p, payout + fee);
        p.claimsPaid += uint128(payout);
        p.claimCount += 1;

        usdc.safeTransfer(agent, payout);
        if (fee != 0) usdc.safeTransfer(treasury, fee);

        emit ClaimPaid(claimId, provider, agent, payout, fromBond, fromBackers, fee, evidenceHash);
    }

    // ------------------------------------------------------------------ views

    /// @notice Everything that can pay claims against this provider right now, queued exits included.
    function coverOf(address provider) external view returns (uint256) {
        Provider storage p = providers[provider];
        return uint256(p.bond) + p.backingAssets;
    }

    /// @notice Cover that is NOT queued for exit. This is the number to judge a provider by.
    function committedCoverOf(address provider) external view returns (uint256) {
        Provider storage p = providers[provider];
        return uint256(p.bond - p.bondPendingWithdraw) + _toAssets(p, p.backingShares - p.backingSharesPending);
    }

    /// @notice Registered, with at least the minimum bond not queued for exit.
    function isActive(address provider) public view returns (bool) {
        Provider storage p = providers[provider];
        return p.registered && p.bond - p.bondPendingWithdraw >= minProviderBond;
    }

    /// @notice How much more can be paid out against this provider today (payouts plus fees).
    ///         While this is above zero the next claim is paid in full, even if it crosses the line.
    function dailyAllowance(address provider) public view returns (uint256) {
        Provider storage p = providers[provider];
        DailySlash storage d = dailySlash[provider];
        if (maxDailySlashBps == BPS || d.day != uint32(block.timestamp / 1 days)) {
            return ((uint256(p.bond) + p.backingAssets) * maxDailySlashBps) / BPS;
        }
        uint256 limit = (uint256(d.startCover) * maxDailySlashBps) / BPS;
        return limit > d.slashed ? limit - d.slashed : 0;
    }

    /// @notice Active, and today's claims have not used up the daily limit. A failed call to a
    ///         provider for which this is false would NOT be refunded today. Check this before paying.
    function isCovered(address provider) external view returns (bool) {
        return isActive(provider) && dailyAllowance(provider) != 0;
    }

    function backerAssets(address provider, address backer) external view returns (uint256) {
        return _toAssets(providers[provider], backerShares[provider][backer]);
    }

    function previewBack(address provider, uint256 assets) external view returns (uint256) {
        return _toShares(providers[provider], assets);
    }

    // ------------------------------------------------------------------ admin

    function setArbiter(address _arbiter) external onlyOwner {
        if (_arbiter == address(0)) revert ZeroAddress();
        arbiter = _arbiter;
        emit ArbiterSet(_arbiter);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    function setParams(uint256 _minProviderBond, uint64 _unbondingDelay, uint16 _slashFeeBps) external onlyOwner {
        _checkParams(_unbondingDelay, _slashFeeBps);
        minProviderBond = _minProviderBond;
        unbondingDelay = _unbondingDelay;
        slashFeeBps = _slashFeeBps;
        emit ParamsSet(_minProviderBond, _unbondingDelay, _slashFeeBps);
    }

    function setMaxClaimPayout(uint256 _maxClaimPayout) external onlyOwner {
        maxClaimPayout = _maxClaimPayout;
        emit MaxClaimPayoutSet(_maxClaimPayout);
    }

    /// @notice Share of a provider's cover that claims may take per UTC day. 10000 turns the limit off.
    function setMaxDailySlashBps(uint16 _maxDailySlashBps) external onlyOwner {
        if (_maxDailySlashBps == 0 || _maxDailySlashBps > BPS) revert BpsOutOfRange();
        maxDailySlashBps = _maxDailySlashBps;
        emit MaxDailySlashBpsSet(_maxDailySlashBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // --------------------------------------------------------------- internal

    /// @dev Takes `total` from the bond first, then from backers. Caller ensures total <= cover.
    /// @dev Reverts once a provider's claims for the UTC day have reached the daily limit.
    ///      The claim that crosses the line is still paid in full, so `dailyAllowance > 0`
    ///      always means "the next claim will be paid". A reverted claim can be paid on a later day.
    function _countTowardDailyLimit(address provider, uint256 cover, uint256 amount) private {
        if (maxDailySlashBps == BPS) return; // limit switched off
        DailySlash storage d = dailySlash[provider];
        uint32 today = uint32(block.timestamp / 1 days);
        if (d.day != today) {
            d.day = today;
            d.slashed = 0;
            d.startCover = cover.toUint112();
        }
        uint256 limit = (uint256(d.startCover) * maxDailySlashBps) / BPS;
        if (d.slashed >= limit) revert DailyLimitReached(limit);
        d.slashed = (uint256(d.slashed) + amount).toUint112();
    }

    function _slash(Provider storage p, uint256 total) private returns (uint256 fromBond, uint256 fromBackers) {
        uint256 bond = p.bond;
        fromBond = total < bond ? total : bond;
        fromBackers = total - fromBond;
        uint128 newBond = uint128(bond - fromBond);
        p.bond = newBond;
        if (p.bondPendingWithdraw > newBond) p.bondPendingWithdraw = newBond;
        if (fromBackers != 0) p.backingAssets -= uint128(fromBackers); // every share loses value pro rata
    }

    function _checkParams(uint64 delay, uint16 feeBps) private pure {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (delay < MIN_UNBONDING || delay > MAX_UNBONDING) revert DelayOutOfRange();
    }

    function _checkExitTime(uint64 readyAt) private view {
        if (block.timestamp < readyAt) revert StillUnbonding(readyAt);
        if (block.timestamp > readyAt + EXIT_WINDOW) revert ExitWindowClosed(readyAt + EXIT_WINDOW);
    }

    function _toShares(Provider storage p, uint256 assets) internal view returns (uint256) {
        return Math.mulDiv(assets, p.backingShares + VIRTUAL_SHARES, uint256(p.backingAssets) + 1);
    }

    function _toAssets(Provider storage p, uint256 shares) internal view returns (uint256) {
        return Math.mulDiv(shares, uint256(p.backingAssets) + 1, p.backingShares + VIRTUAL_SHARES);
    }
}
