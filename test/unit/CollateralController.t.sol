// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BaseTest} from "../BaseTest.sol";
import {CollateralController} from "../../src/CollateralController.sol";

contract CollateralControllerTest is BaseTest {
    function setUp() public override {
        super.setUp();
        reserves.setTotalReserveValue(1_500_000e18); // supports 1,000,000 at 150%
    }

    function test_MintFlow() public {
        uint256 id = _mintVia(alice, 1_000_000e18);

        assertEq(token.balanceOf(alice), 1_000_000e18);
        assertEq(controller.collateralRatioBps(), 15_000);
        assertEq(uint8(controller.getMintRequest(id).status), uint8(CollateralController.MintStatus.Executed));
    }

    function test_RevertWhen_MintBreachesCollateralRatio() public {
        vm.prank(treasuryOps);
        uint256 id = controller.requestMint(alice, 1_000_001e18);

        vm.expectRevert(
            abi.encodeWithSelector(CollateralController.InsufficientCollateral.selector, 14_999, MIN_RATIO_BPS)
        );
        vm.prank(dao);
        controller.approveMint(id);
        assertEq(token.totalSupply(), 0);
    }

    function test_RevertWhen_MintBreachesDebtCeiling() public {
        vm.prank(dao);
        controller.setDebtCeiling(500e18);

        vm.prank(treasuryOps);
        uint256 id = controller.requestMint(alice, 501e18);

        vm.expectRevert(abi.encodeWithSelector(CollateralController.DebtCeilingExceeded.selector, 501e18, 500e18));
        vm.prank(dao);
        controller.approveMint(id);
    }

    function test_RatioCheckedAtApprovalNotRequest() public {
        vm.prank(treasuryOps);
        uint256 id = controller.requestMint(alice, 1_000_000e18);

        reserves.setTotalReserveValue(1_000_000e18); // reserves fall before the vote executes

        vm.expectRevert(
            abi.encodeWithSelector(CollateralController.InsufficientCollateral.selector, 10_000, MIN_RATIO_BPS)
        );
        vm.prank(dao);
        controller.approveMint(id);
    }

    function test_RevertWhen_ApproveTwice() public {
        uint256 id = _mintVia(alice, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralController.InvalidStatus.selector, id, CollateralController.MintStatus.Executed
            )
        );
        vm.prank(dao);
        controller.approveMint(id);
    }

    function test_RejectAndCancel() public {
        vm.startPrank(treasuryOps);
        uint256 a = controller.requestMint(alice, 1e18);
        uint256 b = controller.requestMint(alice, 1e18);
        controller.cancelMint(b);
        vm.stopPrank();

        vm.prank(dao);
        controller.rejectMint(a, "insufficient documentation");

        assertEq(uint8(controller.getMintRequest(a).status), uint8(CollateralController.MintStatus.Rejected));
        assertEq(uint8(controller.getMintRequest(b).status), uint8(CollateralController.MintStatus.Cancelled));
    }

    function test_RevertWhen_CancelByOther() public {
        vm.prank(treasuryOps);
        uint256 id = controller.requestMint(alice, 1e18);
        vm.expectRevert(abi.encodeWithSelector(CollateralController.NotRequester.selector, id));
        vm.prank(bob);
        controller.cancelMint(id);
    }

    function test_PauseBlocksMint() public {
        vm.prank(treasuryOps);
        uint256 id = controller.requestMint(alice, 1e18);

        vm.prank(multisig);
        controller.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(dao);
        controller.approveMint(id);
    }

    function test_MaxMintable() public {
        assertEq(controller.maxMintable(), 1_000_000e18);
        _mintVia(alice, 400_000e18);
        assertEq(controller.maxMintable(), 600_000e18);

        vm.prank(dao);
        controller.setDebtCeiling(500_000e18);
        assertEq(controller.maxMintable(), 100_000e18);
    }

    function test_ReserveRatioAlert() public {
        _mintVia(alice, 1_000_000e18);
        assertTrue(controller.checkReserveRatio());

        reserves.setTotalReserveValue(1_200_000e18);
        vm.expectEmit(address(controller));
        emit CollateralController.ReserveRatioAlert(12_000, MIN_RATIO_BPS);
        assertFalse(controller.checkReserveRatio());
    }

    function test_RevertWhen_RatioBelowOneHundredPercent() public {
        vm.expectRevert(abi.encodeWithSelector(CollateralController.InvalidRatio.selector, 9999));
        vm.prank(dao);
        controller.setMinCollateralRatio(9999);
    }

    function testFuzz_MintNeverBreachesLimits(uint256 reserveValue, uint256 amount) public {
        reserveValue = bound(reserveValue, 0, 1e30);
        amount = bound(amount, 1, 1e30);
        reserves.setTotalReserveValue(reserveValue);

        vm.prank(treasuryOps);
        uint256 id = controller.requestMint(alice, amount);

        vm.prank(dao);
        try controller.approveMint(id) {
            assertLe(token.totalSupply(), DEBT_CEILING);
            assertGe(controller.collateralRatioBps(), MIN_RATIO_BPS);
        } catch {
            assertEq(token.totalSupply(), 0);
        }
    }
}
