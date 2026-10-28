// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Phase1BaseTest} from "../Phase1BaseTest.sol";
import {AssetRegistry} from "../../src/registry/AssetRegistry.sol";
import {AssetApprovalDAO} from "../../src/governance/AssetApprovalDAO.sol";
import {IAssetRegistry} from "../../src/interfaces/IAssetRegistry.sol";

contract AssetRegistryTest is Phase1BaseTest {
    function test_RegisterMintsNftAsPending() public {
        uint256 id = _register(100_000e18);

        assertEq(id, 1);
        assertEq(registry.ownerOf(id), companyVault);
        assertEq(registry.tokenURI(id), "ipfs://asset");
        IAssetRegistry.Asset memory a = registry.getAsset(id);
        assertEq(uint8(a.status), uint8(IAssetRegistry.AssetStatus.Pending));
        assertEq(a.valuation, 100_000e18);
        assertEq(a.assetClass, GEMSTONE);
        assertEq(a.registrant, registrar);
        assertEq(registry.totalAssets(), 1);
        assertEq(registry.statusCount(IAssetRegistry.AssetStatus.Pending), 1);
        assertEq(registry.totalApprovedValue(), 0);
    }

    function test_RevertWhen_DuplicateExternalRef() public {
        vm.startPrank(registrar);
        registry.registerAsset(companyVault, GEMSTONE, "GIA-001", DOCS, 1e18, "");
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.DuplicateExternalRef.selector, bytes32("GIA-001"), 1));
        registry.registerAsset(companyVault, GEMSTONE, "GIA-001", DOCS, 1e18, "");
        vm.stopPrank();
    }

    function test_RevertWhen_RegisterByNonRegistrar() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, registry.REGISTRAR_ROLE()
            )
        );
        vm.prank(outsider);
        registry.registerAsset(companyVault, GEMSTONE, "GIA-001", DOCS, 1e18, "");
    }

    function test_RevertWhen_ZeroValuation() public {
        vm.expectRevert(AssetRegistry.ZeroValue.selector);
        vm.prank(registrar);
        registry.registerAsset(companyVault, GEMSTONE, "GIA-001", DOCS, 0, "");
    }

    function test_UpdatePendingAsset() public {
        uint256 id = _register(100e18);
        vm.prank(registrar);
        registry.updateAsset(id, keccak256("docs-v2"), 120e18, "ipfs://v2");

        assertEq(registry.assetValuation(id), 120e18);
        assertEq(registry.tokenURI(id), "ipfs://v2");
    }

    function test_RejectedAssetResubmitsToPending() public {
        uint256 id = _register(100e18);
        _daoAction(AssetApprovalDAO.Action.RejectAsset, id);
        assertEq(uint8(registry.assetStatus(id)), uint8(IAssetRegistry.AssetStatus.Rejected));

        vm.prank(registrar);
        registry.updateAsset(id, keccak256("docs-v2"), 90e18, "");

        assertEq(uint8(registry.assetStatus(id)), uint8(IAssetRegistry.AssetStatus.Pending));
        assertEq(registry.statusCount(IAssetRegistry.AssetStatus.Rejected), 0);
        assertEq(registry.statusCount(IAssetRegistry.AssetStatus.Pending), 1);
    }

    function test_RevertWhen_UpdateApprovedAsset() public {
        uint256 id = _registerApproved(100e18);
        vm.expectRevert(
            abi.encodeWithSelector(AssetRegistry.NotEditable.selector, id, IAssetRegistry.AssetStatus.Approved)
        );
        vm.prank(registrar);
        registry.updateAsset(id, DOCS, 1e18, "");
    }

    function test_RevertWhen_StatusChangedByNonDao() public {
        uint256 id = _register(100e18);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, registry.DAO_ROLE())
        );
        vm.prank(admin);
        registry.setStatus(id, IAssetRegistry.AssetStatus.Approved, "");
    }

    function test_RevertWhen_InvalidTransition() public {
        uint256 id = _register(100e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                AssetRegistry.InvalidTransition.selector,
                id,
                IAssetRegistry.AssetStatus.Pending,
                IAssetRegistry.AssetStatus.Retired
            )
        );
        vm.prank(address(dao));
        registry.setStatus(id, IAssetRegistry.AssetStatus.Retired, "");
    }

    function test_ApprovedValueTracksLifecycle() public {
        uint256 a = _registerApproved(100e18);
        uint256 b = _registerApproved(50e18);
        assertEq(registry.totalApprovedValue(), 150e18);

        vm.startPrank(address(dao));
        registry.setStatus(a, IAssetRegistry.AssetStatus.Suspended, "audit");
        assertEq(registry.totalApprovedValue(), 50e18);

        registry.revalue(b, 80e18, keccak256("report"));
        assertEq(registry.totalApprovedValue(), 80e18);

        registry.revalue(a, 120e18, keccak256("report")); // suspended: not counted yet
        assertEq(registry.totalApprovedValue(), 80e18);

        registry.setStatus(a, IAssetRegistry.AssetStatus.Approved, "cleared");
        assertEq(registry.totalApprovedValue(), 200e18);

        registry.setStatus(b, IAssetRegistry.AssetStatus.Retired, "sold");
        assertEq(registry.totalApprovedValue(), 120e18);
        vm.stopPrank();
    }

    function test_ApprovedAssetCannotBeTransferred() public {
        uint256 id = _registerApproved(100e18);
        vm.expectRevert(
            abi.encodeWithSelector(AssetRegistry.AssetLocked.selector, id, IAssetRegistry.AssetStatus.Approved)
        );
        vm.prank(companyVault);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        registry.transferFrom(companyVault, outsider, id);
    }

    function test_PendingAndRetiredAssetsCanBeTransferred() public {
        uint256 a = _register(100e18);
        vm.prank(companyVault);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        registry.transferFrom(companyVault, outsider, a);
        assertEq(registry.ownerOf(a), outsider);

        uint256 b = _registerApproved(100e18);
        vm.prank(address(dao));
        registry.setStatus(b, IAssetRegistry.AssetStatus.Retired, "redeemed");
        vm.prank(companyVault);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        registry.transferFrom(companyVault, outsider, b);
        assertEq(registry.ownerOf(b), outsider);
    }

    function test_PauseBlocksRegistrationAndTransfers() public {
        uint256 id = _register(100e18);
        vm.prank(pauser);
        registry.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(registrar);
        registry.registerAsset(companyVault, GEMSTONE, "GIA-XYZ", DOCS, 1e18, "");

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(companyVault);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        registry.transferFrom(companyVault, outsider, id);
    }

    function test_SupportsErc721Interface() public view {
        assertTrue(registry.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(registry.supportsInterface(0x49064906)); // ERC-4906 metadata updates
    }
}
