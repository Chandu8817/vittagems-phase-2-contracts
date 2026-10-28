// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IVittaStablecoin} from "./interfaces/IVittaStablecoin.sol";
import {IReserveManager} from "./interfaces/IReserveManager.sol";

/// @title CollateralController
/// @notice Gatekeeper for stablecoin supply: DAO-approved mints bounded by the collateral ratio and debt ceiling.
/// @dev Flow: treasury ops call {requestMint}; the DAO (Timelock) calls {approveMint}, which re-checks the
///      collateral ratio and debt ceiling against live reserve data and mints in the same transaction.
contract CollateralController is AccessControl, Pausable {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant MINT_REQUESTER_ROLE = keccak256("MINT_REQUESTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant BPS = 10_000;

    enum MintStatus {
        None,
        Pending,
        Executed,
        Rejected,
        Cancelled
    }

    struct MintRequest {
        address to;
        uint256 amount;
        address requester;
        uint64 createdAt;
        MintStatus status;
    }

    IVittaStablecoin public immutable stablecoin;
    IReserveManager public immutable reserveManager;

    /// @notice Minimum reserve value / supply, in basis points (15_000 = 150%).
    uint256 public minCollateralRatioBps;
    /// @notice Maximum total supply of the stablecoin (18 decimals).
    uint256 public debtCeiling;

    uint256 public nextMintRequestId = 1;
    mapping(uint256 id => MintRequest) private _mintRequests;

    event MintRequested(uint256 indexed id, address indexed requester, address indexed to, uint256 amount);
    event MintExecuted(uint256 indexed id, address indexed to, uint256 amount, uint256 collateralRatioBpsAfter);
    event MintRejected(uint256 indexed id, string reason);
    event MintCancelled(uint256 indexed id);
    event MinCollateralRatioUpdated(uint256 oldRatioBps, uint256 newRatioBps);
    event DebtCeilingUpdated(uint256 oldCeiling, uint256 newCeiling);
    event ReserveRatioAlert(uint256 collateralRatioBps, uint256 minCollateralRatioBps);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidRatio(uint256 ratioBps);
    error InvalidStatus(uint256 id, MintStatus status);
    error NotRequester(uint256 id);
    error DebtCeilingExceeded(uint256 supplyAfter, uint256 debtCeiling);
    error InsufficientCollateral(uint256 ratioBpsAfter, uint256 minCollateralRatioBps);

    constructor(
        IVittaStablecoin stablecoin_,
        IReserveManager reserveManager_,
        address admin,
        uint256 minCollateralRatioBps_,
        uint256 debtCeiling_
    ) {
        if (address(stablecoin_) == address(0) || address(reserveManager_) == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        if (minCollateralRatioBps_ < BPS) revert InvalidRatio(minCollateralRatioBps_);

        stablecoin = stablecoin_;
        reserveManager = reserveManager_;
        minCollateralRatioBps = minCollateralRatioBps_;
        debtCeiling = debtCeiling_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Mint workflow
    // ---------------------------------------------------------------------

    /// @notice Opens a mint request for DAO approval.
    function requestMint(address to, uint256 amount)
        external
        onlyRole(MINT_REQUESTER_ROLE)
        whenNotPaused
        returns (uint256 id)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        id = nextMintRequestId++;
        _mintRequests[id] = MintRequest({
            to: to,
            amount: amount,
            requester: msg.sender,
            createdAt: uint64(block.timestamp),
            status: MintStatus.Pending
        });
        emit MintRequested(id, msg.sender, to, amount);
    }

    /// @notice DAO approval: validates ratios against live reserves and mints.
    function approveMint(uint256 id) external onlyRole(GOVERNOR_ROLE) whenNotPaused {
        MintRequest storage req = _pending(id);
        req.status = MintStatus.Executed;

        uint256 ratioAfter = _checkMintable(req.amount);
        stablecoin.mint(req.to, req.amount);

        emit MintExecuted(id, req.to, req.amount, ratioAfter);
    }

    /// @notice DAO rejection of a pending request.
    function rejectMint(uint256 id, string calldata reason) external onlyRole(GOVERNOR_ROLE) {
        _pending(id).status = MintStatus.Rejected;
        emit MintRejected(id, reason);
    }

    /// @notice Lets the original requester withdraw a pending request.
    function cancelMint(uint256 id) external {
        MintRequest storage req = _pending(id);
        if (req.requester != msg.sender) revert NotRequester(id);
        req.status = MintStatus.Cancelled;
        emit MintCancelled(id);
    }

    // ---------------------------------------------------------------------
    // Monitoring
    // ---------------------------------------------------------------------

    /// @notice Reserve value / supply in basis points. `type(uint256).max` when supply is zero.
    function collateralRatioBps() public view returns (uint256) {
        return _ratioBps(reserveManager.totalReserveValue(), stablecoin.totalSupply());
    }

    /// @notice True when the collateral ratio is at or above the minimum.
    function isHealthy() public view returns (bool) {
        return collateralRatioBps() >= minCollateralRatioBps;
    }

    /// @notice Largest amount that could be minted right now under both the ratio and the ceiling.
    function maxMintable() external view returns (uint256) {
        uint256 supply = stablecoin.totalSupply();
        uint256 byRatio = Math.mulDiv(reserveManager.totalReserveValue(), BPS, minCollateralRatioBps);
        uint256 cap = Math.min(byRatio, debtCeiling);
        return cap > supply ? cap - supply : 0;
    }

    /// @notice Keeper hook: emits {ReserveRatioAlert} when the ratio is below the minimum.
    function checkReserveRatio() external returns (bool healthy) {
        uint256 ratio = collateralRatioBps();
        healthy = ratio >= minCollateralRatioBps;
        if (!healthy) emit ReserveRatioAlert(ratio, minCollateralRatioBps);
    }

    function getMintRequest(uint256 id) external view returns (MintRequest memory) {
        return _mintRequests[id];
    }

    // ---------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------

    function setMinCollateralRatio(uint256 newRatioBps) external onlyRole(GOVERNOR_ROLE) {
        if (newRatioBps < BPS) revert InvalidRatio(newRatioBps);
        emit MinCollateralRatioUpdated(minCollateralRatioBps, newRatioBps);
        minCollateralRatioBps = newRatioBps;
    }

    function setDebtCeiling(uint256 newCeiling) external onlyRole(GOVERNOR_ROLE) {
        emit DebtCeilingUpdated(debtCeiling, newCeiling);
        debtCeiling = newCeiling;
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

    function _pending(uint256 id) private view returns (MintRequest storage req) {
        req = _mintRequests[id];
        if (req.status != MintStatus.Pending) revert InvalidStatus(id, req.status);
    }

    function _checkMintable(uint256 amount) private view returns (uint256 ratioAfter) {
        uint256 supplyAfter = stablecoin.totalSupply() + amount;
        if (supplyAfter > debtCeiling) revert DebtCeilingExceeded(supplyAfter, debtCeiling);

        ratioAfter = _ratioBps(reserveManager.totalReserveValue(), supplyAfter);
        if (ratioAfter < minCollateralRatioBps) revert InsufficientCollateral(ratioAfter, minCollateralRatioBps);
    }

    function _ratioBps(uint256 reserveValue, uint256 supply) private pure returns (uint256) {
        if (supply == 0) return type(uint256).max;
        return Math.mulDiv(reserveValue, BPS, supply);
    }
}
