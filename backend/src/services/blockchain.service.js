const { ethers } = require('ethers');
const config = require('../config/config');

const VittaStablecoinABI = require('./abis/VittaStablecoin.json').abi;
const CollateralControllerABI = require('./abis/CollateralController.json').abi;
const RedemptionModuleABI = require('./abis/RedemptionModule.json').abi;
const ReserveManagerABI = require('./abis/ReserveManager.json').abi;
const AssetRegistryABI = require('./abis/AssetRegistry.json').abi;

const SETTLER_ROLE = ethers.id('SETTLER_ROLE');

// Initialize provider
let provider = null;
try {
    const network = config.CHAIN_ID ? { chainId: config.CHAIN_ID, name: 'configured-network' } : undefined;
    provider = new ethers.JsonRpcProvider(config.RPC_URL, network, { staticNetwork: true });
} catch (err) {
    console.error('Failed to initialize JsonRpcProvider:', err.message);
}

// Initialize settlement signer wallet
let wallet = null;
if (config.SETTLEMENT_SIGNER_KEY && provider) {
    try {
        wallet = new ethers.Wallet(config.SETTLEMENT_SIGNER_KEY, provider);
    } catch (err) {
        console.error('Failed to initialize settlement wallet:', err.message);
    }
}

/**
 * Get ethers Contract instance.
 * @param {string} address Contract address
 * @param {Array} abi Contract ABI
 * @param {boolean} withSigner If true, connects to wallet for write transactions
 */
const getContract = (address, abi, withSigner = false) => {
    if (!address || !ethers.isAddress(address) || !provider) return null;
    const runner = withSigner && wallet ? wallet : provider;
    return new ethers.Contract(address, abi, runner);
};

const contracts = {
    vittaStablecoin: (withSigner = false) => getContract(config.CONTRACTS.VITA_STABLECOIN, VittaStablecoinABI, withSigner),
    collateralController: (withSigner = false) => getContract(config.CONTRACTS.COLLATERAL_CONTROLLER, CollateralControllerABI, withSigner),
    redemptionModule: (withSigner = false) => getContract(config.CONTRACTS.REDEMPTION_MODULE, RedemptionModuleABI, withSigner),
    reserveManager: (withSigner = false) => getContract(config.CONTRACTS.RESERVE_MANAGER, ReserveManagerABI, withSigner),
    assetRegistry: (withSigner = false, overrideAddress = null) => {
        const address = overrideAddress || config.CONTRACTS.ASSET_REGISTRY;
        return getContract(address, AssetRegistryABI, withSigner);
    },
};

/**
 * Verify network and contract connectivity on startup or health checks.
 */
async function verifyConnectivity() {
    if (!provider) {
        return {
            connected: false,
            error: 'Provider is not initialized.'
        };
    }

    try {
        const [network, blockNumber] = await Promise.all([
            provider.getNetwork(),
            provider.getBlockNumber()
        ]);

        const chainId = Number(network.chainId);
        const chainIdMismatch = config.CHAIN_ID !== undefined && config.CHAIN_ID !== chainId;

        // Verify contract addresses deployment
        const contractStatus = {};
        const checks = [
            ['vittaStablecoin', config.CONTRACTS.VITA_STABLECOIN],
            ['collateralController', config.CONTRACTS.COLLATERAL_CONTROLLER],
            ['redemptionModule', config.CONTRACTS.REDEMPTION_MODULE],
            ['reserveManager', config.CONTRACTS.RESERVE_MANAGER],
            ['assetRegistry', config.CONTRACTS.ASSET_REGISTRY]
        ];

        await Promise.all(checks.map(async ([name, address]) => {
            if (!address) {
                contractStatus[name] = { configured: false, deployed: false, address: null };
                return;
            }
            if (!ethers.isAddress(address)) {
                contractStatus[name] = { configured: true, deployed: false, address, error: 'Invalid address format' };
                return;
            }
            try {
                const code = await provider.getCode(address);
                const isDeployed = code && code !== '0x';
                contractStatus[name] = {
                    configured: true,
                    deployed: isDeployed,
                    address,
                    ...(isDeployed ? {} : { warning: 'No bytecode found at address' })
                };
            } catch (err) {
                contractStatus[name] = {
                    configured: true,
                    deployed: false,
                    address,
                    error: err.message
                };
            }
        }));

        // Verify settlement signer
        let signerInfo = null;
        if (wallet) {
            let balance = null;
            let hasSettlerRole = null;
            try {
                const bal = await provider.getBalance(wallet.address);
                balance = ethers.formatEther(bal);
            } catch {
                // ignore
            }

            if (contractStatus.redemptionModule && contractStatus.redemptionModule.deployed) {
                try {
                    const rm = contracts.redemptionModule();
                    hasSettlerRole = await rm.hasRole(SETTLER_ROLE, wallet.address);
                } catch {
                    // ignore
                }
            }

            signerInfo = {
                address: wallet.address,
                balanceEth: balance,
                hasSettlerRole
            };
        }

        return {
            connected: true,
            network: {
                name: network.name,
                chainId,
                expectedChainId: config.CHAIN_ID,
                chainIdMismatch
            },
            currentBlock: blockNumber,
            signer: signerInfo,
            contracts: contractStatus
        };
    } catch (error) {
        return {
            connected: false,
            error: error.message
        };
    }
}

module.exports = {
    provider,
    wallet,
    SETTLER_ROLE,
    contracts,
    verifyConnectivity,
    getContract
};
