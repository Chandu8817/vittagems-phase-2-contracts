// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceOracle
/// @notice Market price of the stablecoin in USD.
interface IPriceOracle {
    /// @notice Price of one stablecoin in USD, 18 decimals. Reverts if no valid price is available.
    function price() external view returns (uint256);
}
