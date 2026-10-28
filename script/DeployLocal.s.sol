// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AssetRegistry} from "../src/registry/AssetRegistry.sol";
import {AssetApprovalDAO} from "../src/governance/AssetApprovalDAO.sol";
import {ReserveManager} from "../src/reserve/ReserveManager.sol";
import {ProofOfReserve} from "../src/reserve/ProofOfReserve.sol";
import {VittaStablecoin} from "../src/VittaStablecoin.sol";
import {CollateralController} from "../src/CollateralController.sol";
import {RedemptionModule} from "../src/RedemptionModule.sol";
import {ChainlinkPriceOracle} from "../src/oracle/ChainlinkPriceOracle.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {IReserveHook} from "../src/interfaces/IReserveHook.sol";
import {IVittaStablecoin} from "../src/interfaces/IVittaStablecoin.sol";
import {IReserveManager} from "../src/interfaces/IReserveManager.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";

import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {MockTreasury} from "../test/mocks/MockTreasury.sol";
import {MockPriceFeed} from "../test/mocks/MockPriceFeed.sol";

/// @notice Deploys Phase 1 + Phase 2 with mock USDC, Treasury and price feed to a local anvil node for the
///         demo frontend (`frontend/`). Every role goes to a different anvil account so the UI can act as each.
/// @dev make demo-deploy   (anvil must be running on 127.0.0.1:8545 with the default mnemonic)
///      Account 0 stands in for the DAO Timelock and keeps admin; nothing is handed over or renounced.
contract DeployLocal is Script {
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";

    uint64 internal constant VOTING_PERIOD = 1 days;
    uint32 internal constant QUORUM = 2;
    uint16 internal constant THRESHOLD_BPS = 6000; // 2 of 3 For votes decides a proposal early
    uint256 internal constant SNAPSHOT_INTERVAL = 60;
    uint256 internal constant MAX_STALENESS = 1 days;
    uint256 internal constant TREASURY_USDC = 1_000_000e6;

    AssetRegistry internal registry;
    AssetApprovalDAO internal dao;
    ReserveManager internal reserves;
    ProofOfReserve internal por;
    MockUSDC internal usdc;
    MockTreasury internal treasury;
    MockPriceFeed internal feed;
    VittaStablecoin internal token;
    CollateralController internal controller;
    ChainlinkPriceOracle internal oracle;
    RedemptionModule internal redemption;

    function run() external {
        require(block.chainid == 31_337, "DeployLocal: anvil only");

        uint256 pk = vm.deriveKey(MNEMONIC, 0);
        vm.startBroadcast(pk);
        _deployPhase1(vm.addr(pk));
        _deployMocks();
        _deployPhase2(vm.addr(pk));
        vm.stopBroadcast();

        console2.log("AssetRegistry       ", address(registry));
        console2.log("AssetApprovalDAO    ", address(dao));
        console2.log("ReserveManager      ", address(reserves));
        console2.log("ProofOfReserve      ", address(por));
        console2.log("MockUSDC            ", address(usdc));
        console2.log("MockTreasury        ", address(treasury));
        console2.log("MockPriceFeed       ", address(feed));
        console2.log("VittaStablecoin     ", address(token));
        console2.log("CollateralController", address(controller));
        console2.log("ChainlinkPriceOracle", address(oracle));
        console2.log("RedemptionModule    ", address(redemption));
    }

    /// @dev Accounts: 1 registrar, 2 allocator, 3-5 DAO members, 8 pauser.
    function _deployPhase1(address admin) private {
        address[] memory members = new address[](3);
        members[0] = _account(3);
        members[1] = _account(4);
        members[2] = _account(5);

        registry = new AssetRegistry("VittaGems Asset", "VGA", admin);
        dao = new AssetApprovalDAO(
            IAssetRegistry(address(registry)), admin, members, VOTING_PERIOD, QUORUM, THRESHOLD_BPS
        );
        reserves = new ReserveManager(IAssetRegistry(address(registry)), admin);
        por = new ProofOfReserve(IAssetRegistry(address(registry)), reserves, admin, SNAPSHOT_INTERVAL);

        registry.grantRole(registry.REGISTRAR_ROLE(), _account(1));
        registry.grantRole(registry.DAO_ROLE(), address(dao));
        registry.grantRole(registry.PAUSER_ROLE(), _account(8));
        registry.setReserveHook(IReserveHook(address(reserves)));
        reserves.grantRole(reserves.ALLOCATOR_ROLE(), _account(2));
        reserves.createPool("Stablecoin Reserve");
        reserves.createPool("Treasury Reserve");
    }

    /// @dev Stand-ins for the Phase 1 Treasury (not built yet) and the Chainlink feed.
    function _deployMocks() private {
        usdc = new MockUSDC();
        treasury = new MockTreasury(address(usdc));
        feed = new MockPriceFeed(8, 1e8);
        usdc.mint(address(treasury), TREASURY_USDC);
    }

    /// @dev Accounts: 6 treasury ops (mint requester), 7 settlement operator, 8 pauser.
    function _deployPhase2(address admin) private {
        token = new VittaStablecoin("VittaGems USD", "VGUSD", admin);
        controller = new CollateralController(
            IVittaStablecoin(address(token)), IReserveManager(address(reserves)), admin, 15_000, 10_000_000e18
        );
        oracle = new ChainlinkPriceOracle(AggregatorV3Interface(address(feed)), MAX_STALENESS, admin);
        redemption = new RedemptionModule(
            IVittaStablecoin(address(token)),
            ITreasury(address(treasury)),
            IPriceOracle(address(oracle)),
            admin,
            50,
            10e18
        );

        token.grantRole(token.MINTER_ROLE(), address(controller));
        token.grantRole(token.BURNER_ROLE(), address(redemption));
        token.grantRole(token.PAUSER_ROLE(), _account(8));
        controller.grantRole(controller.MINT_REQUESTER_ROLE(), _account(6));
        controller.grantRole(controller.PAUSER_ROLE(), _account(8));
        redemption.grantRole(redemption.SETTLER_ROLE(), _account(7));
        redemption.grantRole(redemption.PAUSER_ROLE(), _account(8));

        treasury.setAuthorized(address(redemption), true);
        por.setLiabilityToken(IERC20(address(token)));
    }

    function _account(uint32 index) private pure returns (address) {
        return vm.addr(vm.deriveKey(MNEMONIC, index));
    }
}
