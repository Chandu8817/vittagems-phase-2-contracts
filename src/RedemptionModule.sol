// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IVittaStablecoin} from "./interfaces/IVittaStablecoin.sol";
import {ITreasury} from "./interfaces/ITreasury.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title RedemptionModule
/// @notice Treasury-controlled redemption of the stablecoin for USDC.
/// @dev Flow:
///      1. Holder calls {requestRedemption}; tokens are locked in this contract.
///      2. DAO calls {approveRedemption}: price is quoted from the oracle (capped at $1), the discount applied,
///         and treasury liquidity reserved.
///      3. The Settlement API operator calls {settle}: tokens are burned and the Treasury releases USDC.
///      Rejected or cancelled requests return the locked tokens.
contract RedemptionModule is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IVittaStablecoin;

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_DISCOUNT_BPS = 1000; // 10%
    uint256 private constant ONE_USD = 1e18;

    enum RedemptionStatus {
        None,
        Pending,
        Approved,
        Settled,
        Rejected,
        Cancelled
    }

    struct Redemption {
        address redeemer;
        uint256 amount; // stablecoin, 18 decimals
        uint256 usdcAmount; // payout, USDC decimals; set on approval
        uint256 priceUsed; // 18 decimals; set on approval
        uint64 createdAt;
        uint64 approvedAt;
        RedemptionStatus status;
    }

    IVittaStablecoin public immutable stablecoin;
    ITreasury public immutable treasury;
    uint256 private immutable _usdcScale; // 10 ** (18 - usdcDecimals)

    IPriceOracle public oracle;
    uint256 public discountBps;
    uint256 public minRedemptionAmount;

    /// @notice USDC reserved for approved but unsettled redemptions.
    uint256 public reservedUSDC;
    /// @notice Stablecoin locked in pending or approved redemptions.
    uint256 public lockedAmount;

    uint256 public nextRedemptionId = 1;
    mapping(uint256 id => Redemption) private _redemptions;

    event RedemptionRequested(uint256 indexed id, address indexed redeemer, uint256 amount);
    event RedemptionApproved(uint256 indexed id, uint256 priceUsed, uint256 discountBps, uint256 usdcAmount);
    event RedemptionRejected(uint256 indexed id, string reason);
    event RedemptionCancelled(uint256 indexed id);
    event RedemptionSettled(
        uint256 indexed id, address indexed redeemer, uint256 amountBurned, uint256 usdcPaid, bytes32 settlementRef
    );
    event OracleUpdated(address indexed oracle);
    event DiscountUpdated(uint256 oldBps, uint256 newBps);
    event MinRedemptionAmountUpdated(uint256 oldAmount, uint256 newAmount);

    error ZeroAddress();
    error AmountTooSmall(uint256 amount, uint256 minimum);
    error InvalidDiscount(uint256 bps);
    error InvalidStatus(uint256 id, RedemptionStatus status);
    error NotRedeemer(uint256 id);
    error InsufficientTreasuryLiquidity(uint256 required, uint256 available);
    error ZeroPayout(uint256 id);

    constructor(
        IVittaStablecoin stablecoin_,
        ITreasury treasury_,
        IPriceOracle oracle_,
        address admin,
        uint256 discountBps_,
        uint256 minRedemptionAmount_
    ) {
        if (
            address(stablecoin_) == address(0) || address(treasury_) == address(0) || address(oracle_) == address(0)
                || admin == address(0)
        ) revert ZeroAddress();
        if (discountBps_ > MAX_DISCOUNT_BPS) revert InvalidDiscount(discountBps_);

        stablecoin = stablecoin_;
        treasury = treasury_;
        oracle = oracle_;
        discountBps = discountBps_;
        minRedemptionAmount = minRedemptionAmount_;
        _usdcScale = 10 ** (18 - IERC20Metadata(treasury_.usdc()).decimals());

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Redemption workflow
    // ---------------------------------------------------------------------

    /// @notice Locks `amount` stablecoin and opens a redemption request.
    function requestRedemption(uint256 amount) external whenNotPaused nonReentrant returns (uint256 id) {
        if (amount == 0 || amount < minRedemptionAmount) revert AmountTooSmall(amount, minRedemptionAmount);

        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
        lockedAmount += amount;

        id = nextRedemptionId++;
        _redemptions[id] = Redemption({
            redeemer: msg.sender,
            amount: amount,
            usdcAmount: 0,
            priceUsed: 0,
            createdAt: uint64(block.timestamp),
            approvedAt: 0,
            status: RedemptionStatus.Pending
        });
        emit RedemptionRequested(id, msg.sender, amount);
    }

    /// @notice DAO approval: quotes the payout and reserves treasury liquidity for it.
    function approveRedemption(uint256 id) external onlyRole(GOVERNOR_ROLE) whenNotPaused {
        Redemption storage r = _requireStatus(id, RedemptionStatus.Pending);

        uint256 priceUsed = Math.min(oracle.price(), ONE_USD);
        uint256 usdcAmount = _quote(r.amount, priceUsed, discountBps);
        if (usdcAmount == 0) revert ZeroPayout(id);

        uint256 required = reservedUSDC + usdcAmount;
        uint256 available = treasury.availableUSDC();
        if (available < required) revert InsufficientTreasuryLiquidity(required, available);

        reservedUSDC = required;
        r.usdcAmount = usdcAmount;
        r.priceUsed = priceUsed;
        r.approvedAt = uint64(block.timestamp);
        r.status = RedemptionStatus.Approved;

        emit RedemptionApproved(id, priceUsed, discountBps, usdcAmount);
    }

    /// @notice DAO rejection; locked tokens go back to the redeemer. Works on pending or approved requests.
    function rejectRedemption(uint256 id, string calldata reason) external onlyRole(GOVERNOR_ROLE) nonReentrant {
        Redemption storage r = _redemptions[id];
        if (r.status == RedemptionStatus.Approved) {
            reservedUSDC -= r.usdcAmount;
        } else if (r.status != RedemptionStatus.Pending) {
            revert InvalidStatus(id, r.status);
        }
        r.status = RedemptionStatus.Rejected;
        _returnLocked(r);
        emit RedemptionRejected(id, reason);
    }

    /// @notice Redeemer withdraws a request that the DAO has not yet approved.
    function cancelRedemption(uint256 id) external nonReentrant {
        Redemption storage r = _requireStatus(id, RedemptionStatus.Pending);
        if (r.redeemer != msg.sender) revert NotRedeemer(id);
        r.status = RedemptionStatus.Cancelled;
        _returnLocked(r);
        emit RedemptionCancelled(id);
    }

    /// @notice Called by the Settlement API: burns the locked tokens and pays USDC from the treasury.
    /// @param settlementRef Off-chain settlement id, emitted for reconciliation.
    function settle(uint256 id, bytes32 settlementRef) external onlyRole(SETTLER_ROLE) whenNotPaused nonReentrant {
        Redemption storage r = _requireStatus(id, RedemptionStatus.Approved);
        r.status = RedemptionStatus.Settled;

        reservedUSDC -= r.usdcAmount;
        lockedAmount -= r.amount;

        stablecoin.burn(r.amount);
        treasury.releaseUSDC(r.redeemer, r.usdcAmount);

        emit RedemptionSettled(id, r.redeemer, r.amount, r.usdcAmount, settlementRef);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice USDC a redemption of `amount` would pay at the current oracle price and discount.
    function quote(uint256 amount) external view returns (uint256) {
        return _quote(amount, Math.min(oracle.price(), ONE_USD), discountBps);
    }

    function getRedemption(uint256 id) external view returns (Redemption memory) {
        return _redemptions[id];
    }

    // ---------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------

    function setOracle(IPriceOracle newOracle) external onlyRole(GOVERNOR_ROLE) {
        if (address(newOracle) == address(0)) revert ZeroAddress();
        oracle = newOracle;
        emit OracleUpdated(address(newOracle));
    }

    function setDiscount(uint256 newBps) external onlyRole(GOVERNOR_ROLE) {
        if (newBps > MAX_DISCOUNT_BPS) revert InvalidDiscount(newBps);
        emit DiscountUpdated(discountBps, newBps);
        discountBps = newBps;
    }

    function setMinRedemptionAmount(uint256 newAmount) external onlyRole(GOVERNOR_ROLE) {
        emit MinRedemptionAmountUpdated(minRedemptionAmount, newAmount);
        minRedemptionAmount = newAmount;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _quote(uint256 amount, uint256 priceUsed, uint256 discount) private view returns (uint256) {
        uint256 usdValue = Math.mulDiv(amount, priceUsed, ONE_USD);
        return Math.mulDiv(usdValue, BPS - discount, BPS * _usdcScale);
    }

    function _requireStatus(uint256 id, RedemptionStatus expected) private view returns (Redemption storage r) {
        r = _redemptions[id];
        if (r.status != expected) revert InvalidStatus(id, r.status);
    }

    function _returnLocked(Redemption storage r) private {
        lockedAmount -= r.amount;
        stablecoin.safeTransfer(r.redeemer, r.amount);
    }
}
