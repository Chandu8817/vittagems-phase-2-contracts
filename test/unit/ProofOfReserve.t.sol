// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Phase1BaseTest} from "../Phase1BaseTest.sol";
import {ProofOfReserve} from "../../src/reserve/ProofOfReserve.sol";
import {AssetApprovalDAO} from "../../src/governance/AssetApprovalDAO.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract ProofOfReserveTest is Phase1BaseTest {
    function test_SummaryReflectsRegistryAndPools() public {
        uint256 a = _registerApproved(1000e18);
        _registerApproved(500e18);
        _register(200e18); // pending
        _daoAction(AssetApprovalDAO.Action.RejectAsset, _register(50e18));
        _allocate(a, stablePool, 8000);

        ProofOfReserve.ReserveSummary memory s = por.reserveSummary();
        assertEq(s.reserveValue, 800e18);
        assertEq(s.approvedAssetValue, 1500e18);
        assertEq(s.unallocatedValue, 700e18);
        assertEq(s.liabilities, 0);
        assertEq(s.reserveRatioBps, type(uint256).max);
        assertEq(s.totalAssets, 4);
        assertEq(s.approvedAssets, 2);
        assertEq(s.pendingAssets, 1);
        assertEq(s.rejectedAssets, 1);
        assertEq(s.poolCount, 2);
    }

    function test_PoolValues() public {
        uint256 a = _registerApproved(1000e18);
        _allocate(a, stablePool, 7000);
        _allocate(a, treasuryPool, 3000);

        (uint256[] memory ids, string[] memory names,, uint256[] memory values) = por.poolValues();
        assertEq(ids.length, 2);
        assertEq(names[0], "Stablecoin Reserve");
        assertEq(values[0], 700e18);
        assertEq(values[1], 300e18);
    }

    function test_ReserveRatioAgainstLiabilityToken() public {
        uint256 a = _registerApproved(1500e18);
        _allocate(a, stablePool, 10_000);

        MockUSDC liability = new MockUSDC(); // any ERC-20 supply works as the liability measure
        liability.mint(address(this), 1000e6);
        vm.prank(admin);
        por.setLiabilityToken(IERC20(address(liability)));

        // 1500e18 / 1000e6 in raw units: the real liability token (VGUSD) is 18 decimals like the reserve.
        assertEq(por.liabilities(), 1000e6);
        assertEq(por.reserveRatioBps(), 1500e18 * 10_000 / 1000e6);
    }

    function test_SnapshotsAreRateLimitedAndPaged() public {
        uint256 a = _registerApproved(1000e18);
        _allocate(a, stablePool, 10_000);

        assertEq(por.recordSnapshot(), 0);
        vm.expectRevert(
            abi.encodeWithSelector(ProofOfReserve.SnapshotTooSoon.selector, block.timestamp + SNAPSHOT_INTERVAL)
        );
        por.recordSnapshot();

        vm.warp(block.timestamp + SNAPSHOT_INTERVAL);
        _allocate(a, stablePool, 5000);
        assertEq(por.recordSnapshot(), 1);

        ProofOfReserve.Snapshot[] memory page = por.getSnapshots(0, 10);
        assertEq(page.length, 2);
        assertEq(page[0].reserveValue, 1000e18);
        assertEq(page[1].reserveValue, 500e18);
        assertEq(page[1].approvedAssetCount, 1);
        assertEq(por.getSnapshots(5, 10).length, 0);
        assertEq(por.reserveSummary().lastSnapshotAt, block.timestamp);
    }
}
