// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {AssetRegistry} from "../src/registry/AssetRegistry.sol";
import {AssetApprovalDAO} from "../src/governance/AssetApprovalDAO.sol";
import {ReserveManager} from "../src/reserve/ReserveManager.sol";
import {ProofOfReserve} from "../src/reserve/ProofOfReserve.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {IReserveHook} from "../src/interfaces/IReserveHook.sol";

/// @dev Deploys the Phase 1 system (registry, DAO, reserve manager, proof of reserve) wired as in DeployPhase1.
abstract contract Phase1BaseTest is Test {
    uint64 internal constant VOTING_PERIOD = 3 days;
    uint32 internal constant QUORUM = 2;
    uint16 internal constant THRESHOLD_BPS = 6000; // 60% of For + Against
    uint256 internal constant SNAPSHOT_INTERVAL = 1 hours;

    bytes32 internal constant GEMSTONE = "GEMSTONE";
    bytes32 internal constant DOCS = keccak256("docs-v1");

    address internal admin = makeAddr("admin"); // Timelock / multisig
    address internal registrar = makeAddr("registrar");
    address internal allocator = makeAddr("allocator");
    address internal pauser = makeAddr("pauser");
    address internal companyVault = makeAddr("companyVault");
    address internal m1 = makeAddr("member1");
    address internal m2 = makeAddr("member2");
    address internal m3 = makeAddr("member3");
    address internal outsider = makeAddr("outsider");

    AssetRegistry internal registry;
    AssetApprovalDAO internal dao;
    ReserveManager internal reserveManager;
    ProofOfReserve internal por;

    uint256 internal stablePool;
    uint256 internal treasuryPool;
    uint256 private _refNonce;

    function setUp() public virtual {
        vm.warp(1_750_000_000);

        registry = new AssetRegistry("VittaGems Asset", "VGA", admin);

        address[] memory members = new address[](3);
        members[0] = m1;
        members[1] = m2;
        members[2] = m3;
        dao = new AssetApprovalDAO(
            IAssetRegistry(address(registry)), admin, members, VOTING_PERIOD, QUORUM, THRESHOLD_BPS
        );

        reserveManager = new ReserveManager(IAssetRegistry(address(registry)), admin);
        por = new ProofOfReserve(IAssetRegistry(address(registry)), reserveManager, admin, SNAPSHOT_INTERVAL);

        vm.startPrank(admin);
        registry.grantRole(registry.REGISTRAR_ROLE(), registrar);
        registry.grantRole(registry.DAO_ROLE(), address(dao));
        registry.grantRole(registry.PAUSER_ROLE(), pauser);
        registry.setReserveHook(IReserveHook(address(reserveManager)));
        reserveManager.grantRole(reserveManager.ALLOCATOR_ROLE(), allocator);
        stablePool = reserveManager.createPool("Stablecoin Reserve");
        treasuryPool = reserveManager.createPool("Treasury Reserve");
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _register(uint256 valuation) internal returns (uint256 id) {
        bytes32 ref = keccak256(abi.encode("GIA", ++_refNonce));
        vm.prank(registrar);
        id = registry.registerAsset(companyVault, GEMSTONE, ref, DOCS, valuation, "ipfs://asset");
    }

    /// @dev Two of three members vote For, which decides the proposal early; then execute.
    function _passProposal(uint256 proposalId) internal {
        vm.prank(m1);
        dao.castVote(proposalId, AssetApprovalDAO.VoteType.For, "");
        vm.prank(m2);
        dao.castVote(proposalId, AssetApprovalDAO.VoteType.For, "");
        dao.execute(proposalId);
    }

    function _daoAction(AssetApprovalDAO.Action action, uint256 assetId) internal {
        vm.prank(m1);
        uint256 pid = dao.proposeAssetAction(action, assetId, keccak256("report"), "");
        _passProposal(pid);
    }

    function _registerApproved(uint256 valuation) internal returns (uint256 id) {
        id = _register(valuation);
        _daoAction(AssetApprovalDAO.Action.ApproveAsset, id);
    }

    function _allocate(uint256 assetId, uint256 poolId, uint256 bps) internal {
        vm.prank(allocator);
        reserveManager.allocate(assetId, poolId, bps);
    }
}
