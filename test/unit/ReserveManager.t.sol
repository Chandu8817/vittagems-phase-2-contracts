// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Phase1BaseTest} from "../Phase1BaseTest.sol";
import {ReserveManager} from "../../src/reserve/ReserveManager.sol";
import {AssetApprovalDAO} from "../../src/governance/AssetApprovalDAO.sol";
import {IAssetRegistry} from "../../src/interfaces/IAssetRegistry.sol";

contract ReserveManagerTest is Phase1BaseTest {
    function test_AllocationFollowsValuation() public {
        uint256 id = _registerApproved(1000e18);
        _allocate(id, stablePool, 6000);
        _allocate(id, treasuryPool, 4000);

        assertEq(reserveManager.poolValue(stablePool), 600e18);
        assertEq(reserveManager.poolValue(treasuryPool), 400e18);
        assertEq(reserveManager.totalReserveValue(), 1000e18);
        assertEq(reserveManager.assetReserveValue(id), 1000e18);
        assertEq(reserveManager.poolAssets(stablePool).length, 1);
    }

    function test_RevertWhen_AllocatingUnapprovedAsset() public {
        uint256 id = _register(1000e18);
        vm.expectRevert(
            abi.encodeWithSelector(ReserveManager.AssetNotApproved.selector, id, IAssetRegistry.AssetStatus.Pending)
        );
        _allocate(id, stablePool, 5000);
    }

    function test_RevertWhen_OverAllocated() public {
        uint256 id = _registerApproved(1000e18);
        _allocate(id, stablePool, 7000);
        vm.expectRevert(abi.encodeWithSelector(ReserveManager.OverAllocated.selector, id, 11_000));
        _allocate(id, treasuryPool, 4000);
    }

    function test_ReallocateAndRemove() public {
        uint256 id = _registerApproved(1000e18);
        _allocate(id, stablePool, 10_000);
        _allocate(id, stablePool, 2500);
        assertEq(reserveManager.totalReserveValue(), 250e18);

        _allocate(id, stablePool, 0);
        assertEq(reserveManager.totalReserveValue(), 0);
        assertEq(reserveManager.allocatedBps(id), 0);
        assertEq(reserveManager.assetPools(id).length, 0);
    }

    function test_SuspensionRemovesValueAndReinstatementRestoresIt() public {
        uint256 id = _registerApproved(1000e18);
        _allocate(id, stablePool, 10_000);

        _daoAction(AssetApprovalDAO.Action.SuspendAsset, id);
        assertEq(reserveManager.totalReserveValue(), 0);
        assertEq(reserveManager.poolValue(stablePool), 0);

        _daoAction(AssetApprovalDAO.Action.ReinstateAsset, id);
        assertEq(reserveManager.totalReserveValue(), 1000e18);
    }

    function test_RevaluationFlowsIntoPools() public {
        uint256 id = _registerApproved(1000e18);
        _allocate(id, stablePool, 5000);

        vm.prank(m1);
        uint256 pid = dao.proposeRevaluation(id, 800e18, keccak256("report"), "");
        _passProposal(pid);

        assertEq(reserveManager.poolValue(stablePool), 400e18);
        assertEq(reserveManager.totalReserveValue(), 400e18);
    }

    function test_RetiredAssetLeavesReserve() public {
        uint256 id = _registerApproved(1000e18);
        _allocate(id, stablePool, 10_000);
        _daoAction(AssetApprovalDAO.Action.RetireAsset, id);
        assertEq(reserveManager.totalReserveValue(), 0);
    }

    function test_InactivePoolRejectsNewAllocations() public {
        uint256 id = _registerApproved(1000e18);
        vm.prank(admin);
        reserveManager.setPoolActive(stablePool, false);

        vm.expectRevert(abi.encodeWithSelector(ReserveManager.PoolInactive.selector, stablePool));
        _allocate(id, stablePool, 1000);
    }

    function test_RevertWhen_HookCalledByOthers() public {
        vm.expectRevert(ReserveManager.NotRegistry.selector);
        reserveManager.onAssetUpdated(1);
    }

    function test_RevertWhen_UnknownPool() public {
        uint256 id = _registerApproved(1000e18);
        vm.expectRevert(abi.encodeWithSelector(ReserveManager.PoolNotFound.selector, 99));
        _allocate(id, 99, 1000);
    }

    function testFuzz_ReserveNeverExceedsApprovedValue(uint256 valuation, uint256 bpsA, uint256 bpsB) public {
        valuation = bound(valuation, 1, 1e30);
        bpsA = bound(bpsA, 0, 10_000);
        bpsB = bound(bpsB, 0, 10_000 - bpsA);

        uint256 id = _registerApproved(valuation);
        _allocate(id, stablePool, bpsA);
        _allocate(id, treasuryPool, bpsB);

        assertLe(reserveManager.totalReserveValue(), registry.totalApprovedValue());
        assertEq(
            reserveManager.totalReserveValue(),
            reserveManager.poolValue(stablePool) + reserveManager.poolValue(treasuryPool)
        );
    }
}
