// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {VittaStablecoin} from "../src/VittaStablecoin.sol";
import {CollateralController} from "../src/CollateralController.sol";
import {RedemptionModule} from "../src/RedemptionModule.sol";
import {ChainlinkPriceOracle} from "../src/oracle/ChainlinkPriceOracle.sol";
import {IVittaStablecoin} from "../src/interfaces/IVittaStablecoin.sol";
import {IReserveManager} from "../src/interfaces/IReserveManager.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";

/// @notice Deploys Phase 2 and wires roles. The deployer is temporary admin and renounces at the end,
///         leaving the DAO Timelock as the only admin.
/// @dev forge script script/Deploy.s.sol --rpc-url polygon_amoy --broadcast --verify
///      After deployment the Phase 1 Treasury must authorise the RedemptionModule to call releaseUSDC().
contract Deploy is Script {
    struct Config {
        address reserveManager;
        address treasury;
        address timelock;
        address multisig;
        address settler;
        address treasuryOps;
        address priceFeed;
        uint256 maxStaleness;
        uint256 minCollateralRatioBps;
        uint256 debtCeiling;
        uint256 discountBps;
        uint256 minRedemption;
    }

    function run()
        external
        returns (
            VittaStablecoin token,
            CollateralController controller,
            ChainlinkPriceOracle oracle,
            RedemptionModule redemption
        )
    {
        Config memory c = _config();
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        token = new VittaStablecoin("VittaGems USD", "VGUSD", deployer);
        controller = new CollateralController(
            IVittaStablecoin(address(token)),
            IReserveManager(c.reserveManager),
            deployer,
            c.minCollateralRatioBps,
            c.debtCeiling
        );
        oracle = new ChainlinkPriceOracle(AggregatorV3Interface(c.priceFeed), c.maxStaleness, deployer);
        redemption = new RedemptionModule(
            IVittaStablecoin(address(token)),
            ITreasury(c.treasury),
            IPriceOracle(address(oracle)),
            deployer,
            c.discountBps,
            c.minRedemption
        );

        // Token
        token.grantRole(token.MINTER_ROLE(), address(controller));
        token.grantRole(token.BURNER_ROLE(), address(redemption));
        token.grantRole(token.PAUSER_ROLE(), c.multisig);
        _handOver(address(token), token.DEFAULT_ADMIN_ROLE(), bytes32(0), c.timelock, deployer);

        // Controller
        controller.grantRole(controller.MINT_REQUESTER_ROLE(), c.treasuryOps);
        controller.grantRole(controller.PAUSER_ROLE(), c.multisig);
        _handOver(
            address(controller), controller.DEFAULT_ADMIN_ROLE(), controller.GOVERNOR_ROLE(), c.timelock, deployer
        );

        // Oracle
        _handOver(address(oracle), oracle.DEFAULT_ADMIN_ROLE(), oracle.GOVERNOR_ROLE(), c.timelock, deployer);

        // Redemption
        redemption.grantRole(redemption.SETTLER_ROLE(), c.settler);
        redemption.grantRole(redemption.PAUSER_ROLE(), c.multisig);
        _handOver(
            address(redemption), redemption.DEFAULT_ADMIN_ROLE(), redemption.GOVERNOR_ROLE(), c.timelock, deployer
        );

        vm.stopBroadcast();

        console2.log("VittaStablecoin     ", address(token));
        console2.log("CollateralController", address(controller));
        console2.log("ChainlinkPriceOracle", address(oracle));
        console2.log("RedemptionModule    ", address(redemption));
        console2.log("NEXT: authorise RedemptionModule on Treasury", c.treasury);
    }

    /// @dev Grants admin (and governor, if any) to the timelock, then renounces them from the deployer.
    function _handOver(address target, bytes32 adminRole, bytes32 governorRole, address timelock, address deployer)
        private
    {
        IAccessControlLike ac = IAccessControlLike(target);
        if (governorRole != bytes32(0)) {
            ac.grantRole(governorRole, timelock);
            ac.renounceRole(governorRole, deployer);
        }
        ac.grantRole(adminRole, timelock);
        ac.renounceRole(adminRole, deployer);
    }

    function _config() private view returns (Config memory c) {
        c.reserveManager = vm.envAddress("RESERVE_MANAGER");
        c.treasury = vm.envAddress("TREASURY");
        c.timelock = vm.envAddress("DAO_TIMELOCK");
        c.multisig = vm.envAddress("EMERGENCY_MULTISIG");
        c.settler = vm.envAddress("SETTLEMENT_OPERATOR");
        c.treasuryOps = vm.envAddress("TREASURY_OPS");
        c.priceFeed = vm.envAddress("PRICE_FEED");
        c.maxStaleness = vm.envOr("PRICE_MAX_STALENESS", uint256(3600));
        c.minCollateralRatioBps = vm.envOr("MIN_COLLATERAL_RATIO_BPS", uint256(15_000));
        c.debtCeiling = vm.envOr("DEBT_CEILING", uint256(10_000_000e18));
        c.discountBps = vm.envOr("REDEMPTION_DISCOUNT_BPS", uint256(50));
        c.minRedemption = vm.envOr("MIN_REDEMPTION_AMOUNT", uint256(10e18));
    }
}

interface IAccessControlLike {
    function grantRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address callerConfirmation) external;
}
