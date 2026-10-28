const { ethers } = require('ethers');
const config = require('../config/config');
const { provider, contracts } = require('./blockchain.service');

const BPS = 10_000n;
const MAX_UINT256 = ethers.MaxUint256;

/**
 * Fetch token supply metrics.
 */
async function getSupplyAnalytics() {
    const vs = contracts.vittaStablecoin();
    const rm = contracts.redemptionModule();
    const cc = contracts.collateralController();

    if (!vs || !provider) {
        const err = new Error('VittaStablecoin contract or provider is unavailable.');
        err.statusCode = 503;
        err.code = 'BLOCKCHAIN_DATA_UNAVAILABLE';
        throw err;
    }

    try {
        const [totalSupply, lockedAmount, debtCeiling, maxMintable, blockNumber, network] = await Promise.all([
            vs.totalSupply(),
            rm ? rm.lockedAmount().catch(() => 0n) : 0n,
            cc ? cc.debtCeiling().catch(() => 0n) : 0n,
            cc ? cc.maxMintable().catch(() => 0n) : 0n,
            provider.getBlockNumber(),
            provider.getNetwork()
        ]);

        const circulatingSupply = totalSupply > lockedAmount ? totalSupply - lockedAmount : 0n;

        return {
            network: {
                chainId: Number(network.chainId),
                name: network.name,
                blockNumber
            },
            timestamp: new Date().toISOString(),
            token: {
                name: 'VittaGems USD',
                symbol: 'VGUSD',
                decimals: 18
            },
            supply: {
                totalSupply: {
                    raw: totalSupply.toString(),
                    formatted: ethers.formatEther(totalSupply)
                },
                lockedAmount: {
                    raw: lockedAmount.toString(),
                    formatted: ethers.formatEther(lockedAmount)
                },
                circulatingSupply: {
                    raw: circulatingSupply.toString(),
                    formatted: ethers.formatEther(circulatingSupply)
                },
                debtCeiling: {
                    raw: debtCeiling.toString(),
                    formatted: ethers.formatEther(debtCeiling)
                },
                maxMintable: {
                    raw: maxMintable.toString(),
                    formatted: ethers.formatEther(maxMintable)
                }
            }
        };
    } catch (err) {
        const fetchErr = new Error(`Failed to fetch supply analytics from blockchain: ${err.message}`);
        fetchErr.statusCode = 502;
        fetchErr.code = 'RPC_FETCH_FAILED';
        throw fetchErr;
    }
}

/**
 * Fetch reserve value and pool breakdown.
 */
async function getReserveAnalytics() {
    const resMgr = contracts.reserveManager();
    const rm = contracts.redemptionModule();

    if (!resMgr || !provider) {
        const err = new Error('ReserveManager contract or provider is unavailable.');
        err.statusCode = 503;
        err.code = 'BLOCKCHAIN_DATA_UNAVAILABLE';
        throw err;
    }

    try {
        const [totalReserveValue, reservedUSDC, poolCountBig, blockNumber, network] = await Promise.all([
            resMgr.totalReserveValue(),
            rm ? rm.reservedUSDC().catch(() => 0n) : 0n,
            resMgr.poolCount().catch(() => 0n),
            provider.getBlockNumber(),
            provider.getNetwork()
        ]);

        const poolCount = Number(poolCountBig);
        const poolPromises = [];

        for (let i = 1; i <= poolCount; i++) {
            poolPromises.push(
                resMgr.getPool(i).then(p => ({
                    poolId: i,
                    name: p.name,
                    active: p.active,
                    value: {
                        raw: p.value.toString(),
                        formatted: ethers.formatEther(p.value),
                        unit: 'USD'
                    }
                })).catch(() => null)
            );
        }

        const pools = (await Promise.all(poolPromises)).filter(Boolean);

        return {
            network: {
                chainId: Number(network.chainId),
                name: network.name,
                blockNumber
            },
            timestamp: new Date().toISOString(),
            reserves: {
                totalReserveValue: {
                    raw: totalReserveValue.toString(),
                    formatted: ethers.formatEther(totalReserveValue),
                    unit: 'USD'
                },
                reservedUSDC: {
                    raw: reservedUSDC.toString(),
                    formatted: ethers.formatUnits(reservedUSDC, 6),
                    unit: 'USDC'
                },
                poolCount,
                pools
            }
        };
    } catch (err) {
        const fetchErr = new Error(`Failed to fetch reserve analytics from blockchain: ${err.message}`);
        fetchErr.statusCode = 502;
        fetchErr.code = 'RPC_FETCH_FAILED';
        throw fetchErr;
    }
}

/**
 * Fetch high-level overview combining supply, reserves, and collateral ratio.
 */
async function getOverviewAnalytics() {
    const vs = contracts.vittaStablecoin();
    const resMgr = contracts.reserveManager();
    const cc = contracts.collateralController();

    if (!provider || !vs || !resMgr || !cc) {
        const err = new Error('One or more required contracts or blockchain provider is unavailable.');
        err.statusCode = 503;
        err.code = 'BLOCKCHAIN_DATA_UNAVAILABLE';
        throw err;
    }

    try {
        const [
            totalSupply,
            totalReserveValue,
            collateralRatioBpsRaw,
            minCollateralRatioBps,
            isHealthy,
            debtCeiling,
            blockNumber,
            network
        ] = await Promise.all([
            vs.totalSupply(),
            resMgr.totalReserveValue(),
            cc.collateralRatioBps(),
            cc.minCollateralRatioBps(),
            cc.isHealthy(),
            cc.debtCeiling(),
            provider.getBlockNumber(),
            provider.getNetwork()
        ]);

        const zeroSupply = totalSupply === 0n;

        let ratioBps = null;
        let ratioPercent = 'N/A';

        if (zeroSupply) {
            // When supply is 0, the contract returns type(uint256).max
            ratioBps = null;
            ratioPercent = 'N/A (zero supply)';
        } else {
            ratioBps = Number(collateralRatioBpsRaw);
            ratioPercent = `${(ratioBps / 100).toFixed(2)}%`;
        }

        const minRatioBps = Number(minCollateralRatioBps);
        const minRatioPercent = `${(minRatioBps / 100).toFixed(2)}%`;

        return {
            network: {
                chainId: Number(network.chainId),
                name: network.name,
                blockNumber
            },
            timestamp: new Date().toISOString(),
            metrics: {
                totalSupply: {
                    raw: totalSupply.toString(),
                    formatted: ethers.formatEther(totalSupply)
                },
                totalReserveValue: {
                    raw: totalReserveValue.toString(),
                    formatted: ethers.formatEther(totalReserveValue),
                    unit: 'USD'
                },
                collateralRatio: {
                    zeroSupply,
                    collateralRatioBps: ratioBps,
                    collateralRatioPercent: ratioPercent,
                    minCollateralRatioBps: minRatioBps,
                    minCollateralRatioPercent: minRatioPercent,
                    isHealthy: Boolean(isHealthy)
                },
                debtCeiling: {
                    raw: debtCeiling.toString(),
                    formatted: ethers.formatEther(debtCeiling)
                }
            }
        };
    } catch (err) {
        const fetchErr = new Error(`Failed to fetch overview analytics from blockchain: ${err.message}`);
        fetchErr.statusCode = 502;
        fetchErr.code = 'RPC_FETCH_FAILED';
        throw fetchErr;
    }
}

module.exports = {
    getSupplyAnalytics,
    getReserveAnalytics,
    getOverviewAnalytics
};
