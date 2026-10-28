// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAssetRegistry
/// @notice Company Asset Registry: every real-world asset is an NFT with valuation and DAO verification status.
interface IAssetRegistry {
    /// @dev Lifecycle:
    ///      Pending  -> Approved | Rejected          (DAO)
    ///      Rejected -> Pending                      (registrar resubmits via updateAsset)
    ///      Approved -> Suspended | Retired          (DAO)
    ///      Suspended -> Approved | Retired          (DAO)
    enum AssetStatus {
        None,
        Pending,
        Approved,
        Rejected,
        Suspended,
        Retired
    }

    struct Asset {
        bytes32 assetClass; // e.g. "GEMSTONE", "MINING_OUTPUT"
        bytes32 externalRef; // certificate / internal asset code, unique across the registry
        bytes32 documentHash; // hash of the off-chain document bundle
        uint256 valuation; // USD, 18 decimals
        uint64 valuedAt;
        uint64 registeredAt;
        uint64 updatedAt;
        AssetStatus status;
        address registrant;
    }

    function getAsset(uint256 assetId) external view returns (Asset memory);

    function assetStatus(uint256 assetId) external view returns (AssetStatus);

    function assetValuation(uint256 assetId) external view returns (uint256);

    function statusCount(AssetStatus status) external view returns (uint256);

    function totalAssets() external view returns (uint256);

    /// @notice Sum of valuations of all Approved assets (USD, 18 decimals).
    function totalApprovedValue() external view returns (uint256);

    /// @notice DAO-only status change.
    function setStatus(uint256 assetId, AssetStatus newStatus, string calldata reason) external;

    /// @notice DAO-only revaluation of an Approved or Suspended asset.
    function revalue(uint256 assetId, uint256 newValuation, bytes32 reportHash) external;
}
