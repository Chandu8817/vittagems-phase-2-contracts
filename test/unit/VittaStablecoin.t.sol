// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BaseTest} from "../BaseTest.sol";

contract VittaStablecoinTest is BaseTest {
    function test_Metadata() public view {
        assertEq(token.name(), "VittaGems USD");
        assertEq(token.symbol(), "VGUSD");
        assertEq(token.decimals(), 18);
    }

    function test_RevertWhen_MintByNonMinter() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, token.MINTER_ROLE())
        );
        vm.prank(alice);
        token.mint(alice, 1e18);
    }

    function test_RevertWhen_BurnByNonBurner() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, token.BURNER_ROLE())
        );
        vm.prank(alice);
        token.burn(1e18);
    }

    function test_PauseBlocksTransfers() public {
        reserves.setTotalReserveValue(1000e18);
        _mintVia(alice, 100e18);

        vm.prank(multisig);
        token.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transfer(bob, 1e18);
    }

    function test_OnlyAdminCanUnpause() public {
        vm.prank(multisig);
        token.pause();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, multisig, token.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(multisig);
        token.unpause();

        vm.prank(dao);
        token.unpause();
        assertFalse(token.paused());
    }
}
