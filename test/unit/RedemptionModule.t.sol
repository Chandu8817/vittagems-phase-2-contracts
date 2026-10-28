// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BaseTest} from "../BaseTest.sol";
import {RedemptionModule} from "../../src/RedemptionModule.sol";
import {ChainlinkPriceOracle} from "../../src/oracle/ChainlinkPriceOracle.sol";

contract RedemptionModuleTest is BaseTest {
    bytes32 internal constant REF = keccak256("settlement-001");

    function setUp() public override {
        super.setUp();
        reserves.setTotalReserveValue(15_000e18);
        _mintVia(alice, 10_000e18);
        _fundTreasury(5000e6);
    }

    function test_FullRedemptionFlow() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        assertEq(token.balanceOf(address(redemption)), 1000e18);

        vm.prank(dao);
        redemption.approveRedemption(id);
        // $1 price, 0.5% discount
        assertEq(redemption.getRedemption(id).usdcAmount, 995e6);
        assertEq(redemption.reservedUSDC(), 995e6);

        vm.expectEmit(address(redemption));
        emit RedemptionModule.RedemptionSettled(id, alice, 1000e18, 995e6, REF);
        vm.prank(settler);
        redemption.settle(id, REF);

        assertEq(usdc.balanceOf(alice), 995e6);
        assertEq(token.totalSupply(), 9000e18);
        assertEq(redemption.reservedUSDC(), 0);
        assertEq(redemption.lockedAmount(), 0);
    }

    function test_PriceBelowPegReducesPayout() public {
        feed.setAnswer(0.98e8);
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.prank(dao);
        redemption.approveRedemption(id);
        // 1000 * 0.98 * 0.995
        assertEq(redemption.getRedemption(id).usdcAmount, 975.1e6);
    }

    function test_PriceAbovePegIsCapped() public {
        feed.setAnswer(1.05e8);
        assertEq(redemption.quote(1000e18), 995e6);
    }

    function test_RevertWhen_TreasuryLiquidityInsufficient() public {
        uint256 a = _requestRedemption(alice, 3000e18);
        uint256 b = _requestRedemption(alice, 3000e18);

        vm.startPrank(dao);
        redemption.approveRedemption(a); // reserves 2,985 of 5,000
        vm.expectRevert(abi.encodeWithSelector(RedemptionModule.InsufficientTreasuryLiquidity.selector, 5970e6, 5000e6));
        redemption.approveRedemption(b);
        vm.stopPrank();
    }

    function test_RejectReturnsTokensAndReleasesLiquidity() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.startPrank(dao);
        redemption.approveRedemption(id);
        redemption.rejectRedemption(id, "compliance hold");
        vm.stopPrank();

        assertEq(token.balanceOf(alice), 10_000e18);
        assertEq(redemption.reservedUSDC(), 0);
        assertEq(redemption.lockedAmount(), 0);
    }

    function test_CancelPending() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.prank(alice);
        redemption.cancelRedemption(id);
        assertEq(token.balanceOf(alice), 10_000e18);
    }

    function test_RevertWhen_CancelAfterApproval() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.prank(dao);
        redemption.approveRedemption(id);

        vm.expectRevert(
            abi.encodeWithSelector(
                RedemptionModule.InvalidStatus.selector, id, RedemptionModule.RedemptionStatus.Approved
            )
        );
        vm.prank(alice);
        redemption.cancelRedemption(id);
    }

    function test_RevertWhen_SettleTwice() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.prank(dao);
        redemption.approveRedemption(id);
        vm.startPrank(settler);
        redemption.settle(id, REF);
        vm.expectRevert(
            abi.encodeWithSelector(
                RedemptionModule.InvalidStatus.selector, id, RedemptionModule.RedemptionStatus.Settled
            )
        );
        redemption.settle(id, REF);
        vm.stopPrank();
    }

    function test_RevertWhen_SettleBeforeApproval() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RedemptionModule.InvalidStatus.selector, id, RedemptionModule.RedemptionStatus.Pending
            )
        );
        vm.prank(settler);
        redemption.settle(id, REF);
    }

    function test_RevertWhen_BelowMinimum() public {
        vm.startPrank(alice);
        token.approve(address(redemption), 1e18);
        vm.expectRevert(abi.encodeWithSelector(RedemptionModule.AmountTooSmall.selector, 1e18, MIN_REDEMPTION));
        redemption.requestRedemption(1e18);
        vm.stopPrank();
    }

    function test_RevertWhen_OracleStale() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.warp(block.timestamp + STALENESS + 1);
        vm.expectRevert(ChainlinkPriceOracle.NoValidPrice.selector);
        vm.prank(dao);
        redemption.approveRedemption(id);
    }

    function test_FallbackPriceUsedWhenFeedStale() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.warp(block.timestamp + STALENESS + 1);

        vm.startPrank(dao);
        oracle.setFallbackPrice(0.99e18, block.timestamp + 1 days);
        redemption.approveRedemption(id);
        vm.stopPrank();

        assertEq(redemption.getRedemption(id).priceUsed, 0.99e18);
    }

    function test_EmergencyPauseStopsRedemption() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.prank(dao);
        redemption.approveRedemption(id);

        vm.prank(multisig);
        redemption.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(settler);
        redemption.settle(id, REF);
    }

    function test_TokenPauseStopsRequestAndSettle() public {
        uint256 id = _requestRedemption(alice, 1000e18);
        vm.prank(dao);
        redemption.approveRedemption(id);

        vm.prank(multisig);
        token.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(settler);
        redemption.settle(id, REF);

        vm.startPrank(alice);
        token.approve(address(redemption), 100e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        redemption.requestRedemption(100e18);
        vm.stopPrank();
    }

    function testFuzz_QuoteNeverExceedsFaceValue(uint256 amount, int256 price, uint256 discount) public {
        amount = bound(amount, 0, 1e30);
        price = bound(price, 1, 10e8);
        discount = bound(discount, 0, redemption.MAX_DISCOUNT_BPS());
        feed.setAnswer(price);
        vm.prank(dao);
        redemption.setDiscount(discount);

        // Payout in USDC (6 decimals) never exceeds $1 per token.
        assertLe(redemption.quote(amount), amount / 1e12);
    }
}
