// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Phase1BaseTest} from "../Phase1BaseTest.sol";
import {AssetApprovalDAO} from "../../src/governance/AssetApprovalDAO.sol";
import {VittaStablecoin} from "../../src/VittaStablecoin.sol";
import {CollateralController} from "../../src/CollateralController.sol";
import {IVittaStablecoin} from "../../src/interfaces/IVittaStablecoin.sol";
import {IReserveManager} from "../../src/interfaces/IReserveManager.sol";

/// @notice End to end: gem registered as NFT -> DAO approves -> allocated to reserves ->
///         Proof of Reserve shows it -> Phase 2 mints stablecoin against it -> suspension blocks further mints.
contract AssetToStablecoinTest is Phase1BaseTest {
    VittaStablecoin internal token;
    CollateralController internal controller;
    address internal treasuryOps = makeAddr("treasuryOps");
    address internal holder = makeAddr("holder");

    function setUp() public override {
        super.setUp();
        token = new VittaStablecoin("VittaGems USD", "VGUSD", admin);
        controller = new CollateralController(
            IVittaStablecoin(address(token)), IReserveManager(address(reserveManager)), admin, 15_000, 10_000_000e18
        );
        vm.startPrank(admin);
        token.grantRole(token.MINTER_ROLE(), address(controller));
        controller.grantRole(controller.MINT_REQUESTER_ROLE(), treasuryOps);
        por.setLiabilityToken(IERC20(address(token)));
        vm.stopPrank();
    }

    function test_EndToEnd() public {
        // 1. Register and approve a $1.5M gem lot, allocate 100% to reserves.
        uint256 gem = _registerApproved(1_500_000e18);
        _allocate(gem, stablePool, 10_000);
        assertEq(por.reserveValue(), 1_500_000e18);

        // 2. Mint the maximum allowed at 150% collateral.
        assertEq(controller.maxMintable(), 1_000_000e18);
        vm.prank(treasuryOps);
        uint256 mintId = controller.requestMint(holder, 1_000_000e18);
        vm.prank(admin);
        controller.approveMint(mintId);

        assertEq(token.balanceOf(holder), 1_000_000e18);
        assertEq(por.reserveRatioBps(), 15_000);
        por.recordSnapshot();

        // 3. DAO suspends the asset: reserves drop to zero and no further minting is possible.
        _daoAction(AssetApprovalDAO.Action.SuspendAsset, gem);
        assertEq(por.reserveValue(), 0);
        assertFalse(controller.isHealthy());
        assertEq(controller.maxMintable(), 0);

        vm.prank(treasuryOps);
        uint256 blocked = controller.requestMint(holder, 1e18);
        vm.expectRevert(abi.encodeWithSelector(CollateralController.InsufficientCollateral.selector, 0, 15_000));
        vm.prank(admin);
        controller.approveMint(blocked);
    }
}
