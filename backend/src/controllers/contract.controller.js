const { contracts, provider } = require('../services/blockchain.service');
const { ethers } = require('ethers');

/**
 * Returns contract deployment and connection status.
 * Backward compatible with existing frontend / consumers.
 */
exports.getContractInfo = async (req, res, next) => {
    try {
        const vs = contracts.vittaStablecoin();
        const cc = contracts.collateralController();
        const rm = contracts.redemptionModule();
        const resMgr = contracts.reserveManager();
        const ar = contracts.assetRegistry();

        res.json({
            status: 'Connected',
            contracts: {
                vittaStablecoin: vs ? 'Deployed' : 'Not Deployed',
                collateralController: cc ? 'Deployed' : 'Not Deployed',
                redemptionModule: rm ? 'Deployed' : 'Not Deployed',
                reserveManager: resMgr ? 'Deployed' : 'Not Deployed',
                assetRegistry: ar ? 'Deployed' : 'Not Deployed',
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Returns total reserve value in USD.
 * Backward compatible with existing frontend / consumers.
 */
exports.getReserveValue = async (req, res, next) => {
    try {
        const reserveManager = contracts.reserveManager();
        if (!reserveManager) {
            return res.status(400).json({ error: 'ReserveManager not configured or not deployed' });
        }

        const totalValue = await reserveManager.totalReserveValue();

        res.json({
            totalReserveValue: ethers.formatEther(totalValue),
            rawReserveValue: totalValue.toString(),
            unit: 'USD'
        });
    } catch (error) {
        next(error);
    }
};
