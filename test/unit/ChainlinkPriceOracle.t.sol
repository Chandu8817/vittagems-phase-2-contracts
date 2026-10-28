// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../BaseTest.sol";
import {ChainlinkPriceOracle} from "../../src/oracle/ChainlinkPriceOracle.sol";

contract ChainlinkPriceOracleTest is BaseTest {
    function test_NormalisesTo18Decimals() public {
        feed.setAnswer(0.9987e8);
        assertEq(oracle.price(), 0.9987e18);
    }

    function test_RevertWhen_StaleWithoutFallback() public {
        vm.warp(block.timestamp + STALENESS + 1);
        vm.expectRevert(ChainlinkPriceOracle.NoValidPrice.selector);
        oracle.price();
    }

    function test_RevertWhen_NonPositive() public {
        feed.setAnswer(0);
        vm.expectRevert(ChainlinkPriceOracle.NoValidPrice.selector);
        oracle.price();
    }

    function test_FallbackExpires() public {
        feed.setAnswer(-1);
        vm.prank(dao);
        oracle.setFallbackPrice(1e18, block.timestamp + 1 hours);
        assertEq(oracle.price(), 1e18);

        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(ChainlinkPriceOracle.NoValidPrice.selector);
        oracle.price();
    }

    function test_FeedPreferredOverFallback() public {
        vm.prank(dao);
        oracle.setFallbackPrice(0.5e18, block.timestamp + 1 days);
        assertEq(oracle.price(), 1e18);
    }
}
