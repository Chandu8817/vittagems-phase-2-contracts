// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {VittaStablecoin} from "../src/VittaStablecoin.sol";
import {CollateralController} from "../src/CollateralController.sol";
import {RedemptionModule} from "../src/RedemptionModule.sol";
import {ChainlinkPriceOracle} from "../src/oracle/ChainlinkPriceOracle.sol";
import {IVittaStablecoin} from "../src/interfaces/IVittaStablecoin.sol";
import {IReserveManager} from "../src/interfaces/IReserveManager.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";

import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockReserveManager} from "./mocks/MockReserveManager.sol";
import {MockTreasury} from "./mocks/MockTreasury.sol";
import {MockPriceFeed} from "./mocks/MockPriceFeed.sol";

/// @dev Deploys the full Phase 2 system against Phase 1 mocks, wired as in script/Deploy.s.sol.
abstract contract BaseTest is Test {
    uint256 internal constant MIN_RATIO_BPS = 15_000; // 150%
    uint256 internal constant DEBT_CEILING = 10_000_000e18;
    uint256 internal constant DISCOUNT_BPS = 50; // 0.5%
    uint256 internal constant MIN_REDEMPTION = 10e18;
    uint256 internal constant STALENESS = 1 hours;

    address internal dao = makeAddr("dao"); // Timelock
    address internal multisig = makeAddr("multisig"); // emergency pauser
    address internal treasuryOps = makeAddr("treasuryOps"); // mint requester
    address internal settler = makeAddr("settler"); // Settlement API signer
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockUSDC internal usdc;
    MockReserveManager internal reserves;
    MockTreasury internal treasury;
    MockPriceFeed internal feed;

    VittaStablecoin internal token;
    CollateralController internal controller;
    ChainlinkPriceOracle internal oracle;
    RedemptionModule internal redemption;

    function setUp() public virtual {
        vm.warp(1_750_000_000);

        usdc = new MockUSDC();
        reserves = new MockReserveManager();
        treasury = new MockTreasury(address(usdc));
        feed = new MockPriceFeed(8, 1e8);

        token = new VittaStablecoin("VittaGems USD", "VGUSD", dao);
        controller = new CollateralController(
            IVittaStablecoin(address(token)), IReserveManager(address(reserves)), dao, MIN_RATIO_BPS, DEBT_CEILING
        );
        oracle = new ChainlinkPriceOracle(feed, STALENESS, dao);
        redemption = new RedemptionModule(
            IVittaStablecoin(address(token)),
            ITreasury(address(treasury)),
            IPriceOracle(address(oracle)),
            dao,
            DISCOUNT_BPS,
            MIN_REDEMPTION
        );

        vm.startPrank(dao);
        token.grantRole(token.MINTER_ROLE(), address(controller));
        token.grantRole(token.BURNER_ROLE(), address(redemption));
        token.grantRole(token.PAUSER_ROLE(), multisig);
        controller.grantRole(controller.MINT_REQUESTER_ROLE(), treasuryOps);
        controller.grantRole(controller.PAUSER_ROLE(), multisig);
        redemption.grantRole(redemption.SETTLER_ROLE(), settler);
        redemption.grantRole(redemption.PAUSER_ROLE(), multisig);
        vm.stopPrank();

        treasury.setAuthorized(address(redemption), true);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _mintVia(address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(treasuryOps);
        id = controller.requestMint(to, amount);
        vm.prank(dao);
        controller.approveMint(id);
    }

    function _requestRedemption(address who, uint256 amount) internal returns (uint256 id) {
        vm.startPrank(who);
        token.approve(address(redemption), amount);
        id = redemption.requestRedemption(amount);
        vm.stopPrank();
    }

    function _fundTreasury(uint256 amount) internal {
        usdc.mint(address(treasury), amount);
    }
}
