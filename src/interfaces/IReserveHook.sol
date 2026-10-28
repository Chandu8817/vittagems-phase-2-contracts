// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReserveHook
/// @notice Called by the AssetRegistry whenever an asset's status or valuation changes,
///         so reserve totals stay in sync without looping over all assets.
interface IReserveHook {
    function onAssetUpdated(uint256 assetId) external;
}
