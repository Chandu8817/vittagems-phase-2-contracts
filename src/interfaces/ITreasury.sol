// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITreasury
/// @notice Subset of the Phase 1 Treasury that Phase 2 depends on.
/// @dev The Treasury must authorise the RedemptionModule to call {releaseUSDC}.
interface ITreasury {
    /// @notice The USDC token held by the treasury.
    function usdc() external view returns (address);

    /// @notice USDC the treasury can currently release (6 decimals).
    function availableUSDC() external view returns (uint256);

    /// @notice Transfers `amount` USDC to `to`. Callable only by authorised modules.
    function releaseUSDC(address to, uint256 amount) external;
}
