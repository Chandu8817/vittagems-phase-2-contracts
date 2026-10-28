// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IReserveManager} from "../../src/interfaces/IReserveManager.sol";

/// @dev Stand-in for the Phase 1 ReserveManager.
contract MockReserveManager is IReserveManager {
    uint256 public totalReserveValue;

    function setTotalReserveValue(uint256 value) external {
        totalReserveValue = value;
    }
}
