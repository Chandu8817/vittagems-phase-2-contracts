// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {AssetRegistry} from "../src/registry/AssetRegistry.sol";
import {AssetApprovalDAO} from "../src/governance/AssetApprovalDAO.sol";
import {ReserveManager} from "../src/reserve/ReserveManager.sol";
import {ProofOfReserve} from "../src/reserve/ProofOfReserve.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {IReserveHook} from "../src/interfaces/IReserveHook.sol";

/// @notice Deploys Phase 1: Asset Registry (NFT), Asset Approval DAO, Reserve Manager, Proof of Reserve.
/// @dev forge script script/DeployPhase1.s.sol --rpc-url polygon_amoy --broadcast --verify
///      The deployer is temporary admin; admin rights move to ADMIN (Timelock / Safe) at the end.
contract DeployPhase1 is Script {
    function run()
        external
        returns (AssetRegistry registry, AssetApprovalDAO dao, ReserveManager reserves, ProofOfReserve por)
    {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.envAddress("ADMIN");
        address registrar = vm.envAddress("REGISTRAR");
        address allocator = vm.envAddress("ALLOCATOR");
        address pauser = vm.envAddress("EMERGENCY_MULTISIG");
        address[] memory members = vm.envAddress("DAO_MEMBERS", ",");

        vm.startBroadcast(pk);

        registry = new AssetRegistry("VittaGems Asset", "VGA", deployer);
        dao = new AssetApprovalDAO(
            IAssetRegistry(address(registry)),
            admin,
            members,
            uint64(vm.envOr("DAO_VOTING_PERIOD", uint256(3 days))),
            uint32(vm.envOr("DAO_QUORUM", uint256(2))),
            uint16(vm.envOr("DAO_THRESHOLD_BPS", uint256(6667)))
        );
        reserves = new ReserveManager(IAssetRegistry(address(registry)), deployer);
        por = new ProofOfReserve(
            IAssetRegistry(address(registry)), reserves, admin, vm.envOr("POR_SNAPSHOT_INTERVAL", uint256(1 hours))
        );

        registry.grantRole(registry.REGISTRAR_ROLE(), registrar);
        registry.grantRole(registry.DAO_ROLE(), address(dao));
        registry.grantRole(registry.PAUSER_ROLE(), pauser);
        registry.setReserveHook(IReserveHook(address(reserves)));

        reserves.grantRole(reserves.ALLOCATOR_ROLE(), allocator);
        reserves.createPool("Stablecoin Reserve");
        reserves.createPool("Treasury Reserve");

        registry.grantRole(registry.DEFAULT_ADMIN_ROLE(), admin);
        registry.renounceRole(registry.DEFAULT_ADMIN_ROLE(), deployer);
        reserves.grantRole(reserves.DEFAULT_ADMIN_ROLE(), admin);
        reserves.renounceRole(reserves.DEFAULT_ADMIN_ROLE(), deployer);

        vm.stopBroadcast();

        console2.log("AssetRegistry   ", address(registry));
        console2.log("AssetApprovalDAO", address(dao));
        console2.log("ReserveManager  ", address(reserves));
        console2.log("ProofOfReserve  ", address(por));
    }
}
