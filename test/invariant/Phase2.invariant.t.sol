// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "../BaseTest.sol";
import {VittaStablecoin} from "../../src/VittaStablecoin.sol";
import {CollateralController} from "../../src/CollateralController.sol";
import {RedemptionModule} from "../../src/RedemptionModule.sol";
import {MockReserveManager} from "../mocks/MockReserveManager.sol";

/// @dev Drives random mint / redeem / approve / settle / reject sequences. Reserves only grow here,
///      so any breach of the collateral ratio would come from the contracts, not from a price shock.
contract Handler is Test {
    VittaStablecoin internal token;
    CollateralController internal controller;
    RedemptionModule internal redemption;
    MockReserveManager internal reserves;
    address internal dao;
    address internal treasuryOps;
    address internal settler;

    address[] internal users;
    uint256[] internal openRedemptions;

    constructor(
        VittaStablecoin token_,
        CollateralController controller_,
        RedemptionModule redemption_,
        MockReserveManager reserves_,
        address dao_,
        address treasuryOps_,
        address settler_
    ) {
        token = token_;
        controller = controller_;
        redemption = redemption_;
        reserves = reserves_;
        dao = dao_;
        treasuryOps = treasuryOps_;
        settler = settler_;
        users.push(makeAddr("u1"));
        users.push(makeAddr("u2"));
        users.push(makeAddr("u3"));
    }

    function addReserves(uint256 amount) external {
        amount = bound(amount, 0, 1_000_000e18);
        reserves.setTotalReserveValue(reserves.totalReserveValue() + amount);
    }

    function mint(uint256 userSeed, uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e18);
        address to = users[userSeed % users.length];
        vm.prank(treasuryOps);
        uint256 id = controller.requestMint(to, amount);
        vm.prank(dao);
        try controller.approveMint(id) {} catch {}
    }

    function requestRedemption(uint256 userSeed, uint256 amount) external {
        address who = users[userSeed % users.length];
        uint256 bal = token.balanceOf(who);
        if (bal < redemption.minRedemptionAmount()) return;
        amount = bound(amount, redemption.minRedemptionAmount(), bal);
        vm.startPrank(who);
        token.approve(address(redemption), amount);
        openRedemptions.push(redemption.requestRedemption(amount));
        vm.stopPrank();
    }

    function approve(uint256 seed) external {
        if (openRedemptions.length == 0) return;
        vm.prank(dao);
        try redemption.approveRedemption(openRedemptions[seed % openRedemptions.length]) {} catch {}
    }

    function settle(uint256 seed) external {
        if (openRedemptions.length == 0) return;
        vm.prank(settler);
        try redemption.settle(openRedemptions[seed % openRedemptions.length], bytes32(seed)) {} catch {}
    }

    function reject(uint256 seed) external {
        if (openRedemptions.length == 0) return;
        vm.prank(dao);
        try redemption.rejectRedemption(openRedemptions[seed % openRedemptions.length], "") {} catch {}
    }
}

contract Phase2InvariantTest is BaseTest {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        _fundTreasury(100_000_000e6);
        handler = new Handler(token, controller, redemption, reserves, dao, treasuryOps, settler);
        targetContract(address(handler));
    }

    /// Supply stays within the debt ceiling.
    function invariant_SupplyWithinDebtCeiling() public view {
        assertLe(token.totalSupply(), controller.debtCeiling());
    }

    /// With reserves never falling, the collateral ratio never drops below the minimum.
    function invariant_CollateralRatioHolds() public view {
        assertGe(controller.collateralRatioBps(), controller.minCollateralRatioBps());
    }

    /// Tokens held by the redemption module equal the amount locked in open requests.
    function invariant_LockedTokensAccounted() public view {
        assertEq(token.balanceOf(address(redemption)), redemption.lockedAmount());
    }

    /// Reserved USDC never exceeds what the treasury holds.
    function invariant_ReservedLiquidityCovered() public view {
        assertLe(redemption.reservedUSDC(), treasury.availableUSDC());
    }
}
