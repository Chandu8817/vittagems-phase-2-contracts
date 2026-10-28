// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAssetRegistry} from "../interfaces/IAssetRegistry.sol";
import {ReserveManager} from "./ReserveManager.sol";

/// @title ProofOfReserve
/// @notice Public, read-only view of VittaGems reserves plus an on-chain history of reserve snapshots.
/// @dev - Reserve value retrieval and statistics come live from the AssetRegistry and ReserveManager.
///      - Anyone can record a snapshot, at most once per `minSnapshotInterval`; snapshots feed historical charts.
///      - `liabilityToken` (the Phase 2 stablecoin) is optional; while unset, liabilities are zero.
contract ProofOfReserve is AccessControl {
    uint256 public constant BPS = 10_000;

    struct Snapshot {
        uint64 timestamp;
        uint64 blockNumber;
        uint256 reserveValue; // allocated to reserve pools
        uint256 approvedAssetValue; // all Approved assets
        uint256 liabilities; // liability token supply
        uint256 approvedAssetCount;
    }

    struct ReserveSummary {
        uint256 reserveValue;
        uint256 approvedAssetValue;
        uint256 unallocatedValue;
        uint256 liabilities;
        uint256 reserveRatioBps; // type(uint256).max when liabilities are zero
        uint256 totalAssets;
        uint256 pendingAssets;
        uint256 approvedAssets;
        uint256 rejectedAssets;
        uint256 suspendedAssets;
        uint256 retiredAssets;
        uint256 poolCount;
        uint256 lastSnapshotAt;
    }

    IAssetRegistry public immutable registry;
    ReserveManager public immutable reserveManager;

    IERC20 public liabilityToken;
    uint256 public minSnapshotInterval;

    Snapshot[] private _snapshots;

    event ReserveSnapshotRecorded(
        uint256 indexed index,
        uint256 reserveValue,
        uint256 approvedAssetValue,
        uint256 liabilities,
        uint256 reserveRatioBps,
        address indexed recorder
    );
    event LiabilityTokenUpdated(address indexed token);
    event MinSnapshotIntervalUpdated(uint256 interval);

    error ZeroAddress();
    error SnapshotTooSoon(uint256 nextAllowedAt);

    constructor(IAssetRegistry registry_, ReserveManager reserveManager_, address admin, uint256 minSnapshotInterval_) {
        if (address(registry_) == address(0) || address(reserveManager_) == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        reserveManager = reserveManager_;
        minSnapshotInterval = minSnapshotInterval_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Live reserve data
    // ---------------------------------------------------------------------

    function reserveValue() public view returns (uint256) {
        return reserveManager.totalReserveValue();
    }

    function liabilities() public view returns (uint256) {
        return address(liabilityToken) == address(0) ? 0 : liabilityToken.totalSupply();
    }

    /// @notice Reserve value / liabilities in basis points; `type(uint256).max` when there are no liabilities.
    function reserveRatioBps() public view returns (uint256) {
        uint256 l = liabilities();
        return l == 0 ? type(uint256).max : Math.mulDiv(reserveValue(), BPS, l);
    }

    function reserveSummary() external view returns (ReserveSummary memory s) {
        s.reserveValue = reserveValue();
        s.approvedAssetValue = registry.totalApprovedValue();
        s.unallocatedValue = s.approvedAssetValue > s.reserveValue ? s.approvedAssetValue - s.reserveValue : 0;
        s.liabilities = liabilities();
        s.reserveRatioBps = reserveRatioBps();
        s.totalAssets = registry.totalAssets();
        s.pendingAssets = registry.statusCount(IAssetRegistry.AssetStatus.Pending);
        s.approvedAssets = registry.statusCount(IAssetRegistry.AssetStatus.Approved);
        s.rejectedAssets = registry.statusCount(IAssetRegistry.AssetStatus.Rejected);
        s.suspendedAssets = registry.statusCount(IAssetRegistry.AssetStatus.Suspended);
        s.retiredAssets = registry.statusCount(IAssetRegistry.AssetStatus.Retired);
        s.poolCount = reserveManager.poolCount();
        s.lastSnapshotAt = _snapshots.length == 0 ? 0 : _snapshots[_snapshots.length - 1].timestamp;
    }

    /// @notice Every pool with its name, active flag and current value.
    function poolValues()
        external
        view
        returns (uint256[] memory ids, string[] memory names, bool[] memory active, uint256[] memory values)
    {
        uint256 n = reserveManager.poolCount();
        ids = new uint256[](n);
        names = new string[](n);
        active = new bool[](n);
        values = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ReserveManager.Pool memory p = reserveManager.getPool(i + 1);
            ids[i] = i + 1;
            names[i] = p.name;
            active[i] = p.active;
            values[i] = p.value;
        }
    }

    // ---------------------------------------------------------------------
    // Snapshots
    // ---------------------------------------------------------------------

    /// @notice Records the current reserve position on-chain. Permissionless, rate-limited.
    function recordSnapshot() external returns (uint256 index) {
        uint256 n = _snapshots.length;
        if (n != 0) {
            uint256 nextAllowed = _snapshots[n - 1].timestamp + minSnapshotInterval;
            if (block.timestamp < nextAllowed) revert SnapshotTooSoon(nextAllowed);
        }

        Snapshot memory s = Snapshot({
            timestamp: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            reserveValue: reserveValue(),
            approvedAssetValue: registry.totalApprovedValue(),
            liabilities: liabilities(),
            approvedAssetCount: registry.statusCount(IAssetRegistry.AssetStatus.Approved)
        });
        _snapshots.push(s);
        index = n;

        emit ReserveSnapshotRecorded(
            index, s.reserveValue, s.approvedAssetValue, s.liabilities, reserveRatioBps(), msg.sender
        );
    }

    function snapshotCount() external view returns (uint256) {
        return _snapshots.length;
    }

    function getSnapshot(uint256 index) external view returns (Snapshot memory) {
        return _snapshots[index];
    }

    /// @notice Page of snapshots, oldest first.
    function getSnapshots(uint256 offset, uint256 limit) external view returns (Snapshot[] memory page) {
        uint256 n = _snapshots.length;
        if (offset >= n) return new Snapshot[](0);
        uint256 end = Math.min(n, offset + limit);
        page = new Snapshot[](end - offset); 
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _snapshots[i];
        }
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setLiabilityToken(IERC20 token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        liabilityToken = token;
        emit LiabilityTokenUpdated(address(token));
    }

    function setMinSnapshotInterval(uint256 interval) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minSnapshotInterval = interval;
        emit MinSnapshotIntervalUpdated(interval);
    }
}
