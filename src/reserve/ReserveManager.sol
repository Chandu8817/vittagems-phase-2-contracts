// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAssetRegistry} from "../interfaces/IAssetRegistry.sol";
import {IReserveHook} from "../interfaces/IReserveHook.sol";
import {IReserveManager} from "../interfaces/IReserveManager.sol";

/// @title ReserveManager
/// @notice Allocates DAO-approved assets into reserve pools, valued from the Asset Registry.
/// @dev An asset can be split across pools in basis points (total <= 100%). Its contribution to a pool is
///      `valuation * bps / 10_000` while the asset is Approved, and zero otherwise (Suspended, Retired).
///      The registry calls {onAssetUpdated} on every status or valuation change, so pool values and the total
///      reserve are kept current in O(pools per asset) without looping over the registry.
contract ReserveManager is AccessControl, IReserveManager, IReserveHook {
    using EnumerableSet for EnumerableSet.UintSet;

    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    uint256 public constant BPS = 10_000;

    struct Pool {
        string name;
        bool active;
        uint256 value; // USD, 18 decimals
    }

    IAssetRegistry public immutable registry;

    uint256 public poolCount;
    /// @notice Sum of all pool values (USD, 18 decimals). Read by the Phase 2 CollateralController.
    uint256 public totalReserveValue;

    mapping(uint256 poolId => Pool) private _pools;
    mapping(uint256 assetId => mapping(uint256 poolId => uint256 bps)) public allocationBps;
    mapping(uint256 assetId => mapping(uint256 poolId => uint256 value)) public contribution;
    mapping(uint256 assetId => uint256 bps) public allocatedBps;
    mapping(uint256 assetId => EnumerableSet.UintSet) private _assetPools;
    mapping(uint256 poolId => EnumerableSet.UintSet) private _poolAssets;

    event PoolCreated(uint256 indexed poolId, string name);
    event PoolStatusChanged(uint256 indexed poolId, bool active);
    event ReserveAllocated(uint256 indexed assetId, uint256 indexed poolId, uint256 oldBps, uint256 newBps);
    event ReserveValueUpdated(
        uint256 indexed assetId,
        uint256 indexed poolId,
        uint256 oldContribution,
        uint256 newContribution,
        uint256 poolValue,
        uint256 totalReserveValue
    );

    error ZeroAddress();
    error NotRegistry();
    error PoolNotFound(uint256 poolId);
    error PoolInactive(uint256 poolId);
    error AssetNotApproved(uint256 assetId, IAssetRegistry.AssetStatus status);
    error OverAllocated(uint256 assetId, uint256 totalBps);

    constructor(IAssetRegistry registry_, address admin) {
        if (address(registry_) == address(0) || admin == address(0)) revert ZeroAddress();
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Pools (admin)
    // ---------------------------------------------------------------------

    function createPool(string calldata name) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 poolId) {
        poolId = ++poolCount;
        _pools[poolId] = Pool({name: name, active: true, value: 0});
        emit PoolCreated(poolId, name);
    }

    /// @notice Inactive pools accept no new allocations; existing allocations keep counting.
    function setPoolActive(uint256 poolId, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pool(poolId).active = active;
        emit PoolStatusChanged(poolId, active);
    }

    // ---------------------------------------------------------------------
    // Allocation (allocator)
    // ---------------------------------------------------------------------

    /// @notice Sets the share of `assetId` allocated to `poolId`. `bps = 0` removes the allocation.
    function allocate(uint256 assetId, uint256 poolId, uint256 bps) external onlyRole(ALLOCATOR_ROLE) {
        Pool storage pool = _pool(poolId);
        if (bps != 0) {
            if (!pool.active) revert PoolInactive(poolId);
            IAssetRegistry.AssetStatus st = registry.assetStatus(assetId);
            if (st != IAssetRegistry.AssetStatus.Approved) revert AssetNotApproved(assetId, st);
        }

        uint256 oldBps = allocationBps[assetId][poolId];
        uint256 newTotal = allocatedBps[assetId] - oldBps + bps;
        if (newTotal > BPS) revert OverAllocated(assetId, newTotal);

        allocatedBps[assetId] = newTotal;
        allocationBps[assetId][poolId] = bps;
        if (bps == 0) {
            _assetPools[assetId].remove(poolId);
            _poolAssets[poolId].remove(assetId);
        } else {
            _assetPools[assetId].add(poolId);
            _poolAssets[poolId].add(assetId);
        }

        emit ReserveAllocated(assetId, poolId, oldBps, bps);
        _sync(assetId, poolId);
    }

    // ---------------------------------------------------------------------
    // Registry hook
    // ---------------------------------------------------------------------

    /// @inheritdoc IReserveHook
    function onAssetUpdated(uint256 assetId) external {
        if (msg.sender != address(registry)) revert NotRegistry();
        uint256[] memory pools = _assetPools[assetId].values();
        for (uint256 i; i < pools.length; ++i) {
            _sync(assetId, pools[i]);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getPool(uint256 poolId) external view returns (Pool memory) {
        return _pools[poolId];
    }

    function poolValue(uint256 poolId) external view returns (uint256) {
        return _pools[poolId].value;
    }

    function poolAssets(uint256 poolId) external view returns (uint256[] memory) {
        return _poolAssets[poolId].values();
    }

    function assetPools(uint256 assetId) external view returns (uint256[] memory) {
        return _assetPools[assetId].values();
    }

    /// @notice Reserve value currently contributed by `assetId` across all pools.
    function assetReserveValue(uint256 assetId) external view returns (uint256 total) {
        uint256[] memory pools = _assetPools[assetId].values();
        for (uint256 i; i < pools.length; ++i) {
            total += contribution[assetId][pools[i]];
        }
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _pool(uint256 poolId) private view returns (Pool storage p) {
        if (poolId == 0 || poolId > poolCount) revert PoolNotFound(poolId);
        p = _pools[poolId];
    }

    function _sync(uint256 assetId, uint256 poolId) private {
        uint256 newC;
        if (registry.assetStatus(assetId) == IAssetRegistry.AssetStatus.Approved) {
            newC = Math.mulDiv(registry.assetValuation(assetId), allocationBps[assetId][poolId], BPS);
        }
        uint256 oldC = contribution[assetId][poolId];
        if (newC == oldC) return;

        contribution[assetId][poolId] = newC;
        Pool storage pool = _pools[poolId];
        pool.value = pool.value - oldC + newC;
        totalReserveValue = totalReserveValue - oldC + newC;

        emit ReserveValueUpdated(assetId, poolId, oldC, newC, pool.value, totalReserveValue);
    }
}
