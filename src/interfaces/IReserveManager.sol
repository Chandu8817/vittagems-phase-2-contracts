// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReserveManager
/// @notice Subset of the Phase 1 ReserveManager that Phase 2 depends on.
interface IReserveManager {
    /// @notice Total value of DAO-approved reserves, in USD with 18 decimals.
    function totalReserveValue() external view returns (uint256);
}
