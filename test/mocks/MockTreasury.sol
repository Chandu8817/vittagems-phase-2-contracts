// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

/// @dev Stand-in for the Phase 1 Treasury: holds USDC and releases it to authorised modules.
contract MockTreasury is ITreasury {
    using SafeERC20 for IERC20;

    address public immutable usdc;
    mapping(address => bool) public authorized;

    error NotAuthorized();

    constructor(address usdc_) {
        usdc = usdc_;
    }

    function setAuthorized(address module, bool allowed) external {
        authorized[module] = allowed;
    }

    function availableUSDC() external view returns (uint256) {
        return IERC20(usdc).balanceOf(address(this));
    }

    function releaseUSDC(address to, uint256 amount) external {
        if (!authorized[msg.sender]) revert NotAuthorized();
        IERC20(usdc).safeTransfer(to, amount);
    }
}
