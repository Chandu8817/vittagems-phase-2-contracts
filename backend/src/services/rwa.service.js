const { ethers } = require('ethers');
const config = require('../config/config');
const { provider, contracts } = require('./blockchain.service');

const ASSET_STATUS = ['None', 'Pending', 'Approved', 'Rejected', 'Suspended', 'Retired'];

/**
 * Decode null-terminated UTF-8 string from bytes32 hex.
 * Falls back to original hex if decode fails.
 * @param {string} bytes32Hex 
 * @returns {string}
 */
function decodeBytes32(bytes32Hex) {
    if (!bytes32Hex || bytes32Hex === ethers.ZeroHash) return '';
    try {
        return ethers.decodeBytes32String(bytes32Hex);
    } catch {
        return bytes32Hex;
    }
}

/**
 * Encode string into bytes32 hex representation.
 * @param {string} str 
 * @returns {string}
 */
function encodeBytes32(str) {
    if (!str) return ethers.ZeroHash;
    const trimmed = String(str).trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    try {
        return ethers.encodeBytes32String(trimmed);
    } catch {
        return ethers.id(trimmed);
    }
}

/**
 * Get the AssetRegistry contract instance.
 * Automatically attempts discovery via ReserveManager if not explicitly configured.
 */
async function getAssetRegistryContract() {
    let registry = contracts.assetRegistry();

    // If address is not configured explicitly, attempt to resolve via ReserveManager.registry()
    if (!registry && contracts.reserveManager()) {
        try {
            const rm = contracts.reserveManager();
            const regAddr = await rm.registry();
            if (regAddr && ethers.isAddress(regAddr) && regAddr !== ethers.ZeroAddress) {
                registry = contracts.assetRegistry(false, regAddr);
            }
        } catch {
            // ignore
        }
    }

    if (!registry || !provider) {
        const err = new Error('AssetRegistry contract or blockchain provider is unavailable.');
        err.statusCode = 503;
        err.code = 'CONTRACT_NOT_AVAILABLE';
        throw err;
    }

    return registry;
}

/**
 * Fetch reserve allocation and pool data for a specific asset from ReserveManager.
 * @param {object} rm ReserveManager contract
 * @param {number} assetId
 */
async function fetchAssetReserveData(rm, assetId) {
    if (!rm) return null;
    try {
        const [allocatedBps, reserveValue, poolIdsRaw] = await Promise.all([
            rm.allocatedBps(assetId).catch(() => 0n),
            rm.assetReserveValue(assetId).catch(() => 0n),
            rm.assetPools(assetId).catch(() => [])
        ]);

        const poolIds = Array.isArray(poolIdsRaw) ? poolIdsRaw.map(p => Number(p)) : [];
        return {
            allocatedBps,
            reserveValue,
            pools: poolIds
        };
    } catch {
        return null;
    }
}

/**
 * Format asset struct and metadata into a clean JSON presentation.
 */
function serializeAsset(id, a, owner = null, uri = null, reserveData = null) {
    const statusCode = Number(a.status);
    const statusName = ASSET_STATUS[statusCode] || 'Unknown';
    const numId = Number(id);

    return {
        id: numId,
        assetClass: {
            raw: a.assetClass,
            name: decodeBytes32(a.assetClass)
        },
        externalRef: {
            raw: a.externalRef,
            code: decodeBytes32(a.externalRef)
        },
        documentHash: a.documentHash,
        valuation: {
            raw: a.valuation.toString(),
            formatted: ethers.formatEther(a.valuation),
            unit: 'USD'
        },
        status: {
            code: statusCode,
            name: statusName
        },
        dates: {
            valuedAt: Number(a.valuedAt),
            valuedAtIso: a.valuedAt > 0n ? new Date(Number(a.valuedAt) * 1000).toISOString() : null,
            registeredAt: Number(a.registeredAt),
            registeredAtIso: a.registeredAt > 0n ? new Date(Number(a.registeredAt) * 1000).toISOString() : null,
            updatedAt: Number(a.updatedAt),
            updatedAtIso: a.updatedAt > 0n ? new Date(Number(a.updatedAt) * 1000).toISOString() : null
        },
        registrant: a.registrant,
        owner: owner || null,
        tokenURI: uri || null,
        reserves: reserveData ? {
            allocatedBps: Number(reserveData.allocatedBps || 0),
            allocatedPercent: `${((Number(reserveData.allocatedBps || 0) / 100)).toFixed(2)}%`,
            reserveValue: {
                raw: reserveData.reserveValue ? reserveData.reserveValue.toString() : '0',
                formatted: reserveData.reserveValue ? ethers.formatEther(reserveData.reserveValue) : '0.0',
                unit: 'USD'
            },
            pools: reserveData.pools || []
        } : null
    };
}

/**
 * Inspect a single RWA asset by assetId.
 * @param {number|string} assetId
 */
async function getAssetById(assetId) {
    const id = parseInt(assetId, 10);
    if (!Number.isInteger(id) || id <= 0) {
        const err = new Error(`Invalid assetId: "${assetId}". Must be a positive integer.`);
        err.statusCode = 400;
        err.code = 'INVALID_ASSET_ID';
        throw err;
    }

    const registry = await getAssetRegistryContract();
    const rm = contracts.reserveManager();

    let asset;
    try {
        asset = await registry.getAsset(id);
    } catch (err) {
        const notFoundErr = new Error(`Asset #${id} not found: ${err.message}`);
        notFoundErr.statusCode = 404;
        notFoundErr.code = 'ASSET_NOT_FOUND';
        throw notFoundErr;
    }

    if (!asset || Number(asset.status) === 0) {
        const notFoundErr = new Error(`Asset #${id} does not exist.`);
        notFoundErr.statusCode = 404;
        notFoundErr.code = 'ASSET_NOT_FOUND';
        throw notFoundErr;
    }

    const [owner, uri, reserveData] = await Promise.all([
        registry.ownerOf(id).catch(() => null),
        registry.tokenURI(id).catch(() => null),
        rm ? fetchAssetReserveData(rm, id) : null
    ]);

    return serializeAsset(id, asset, owner, uri, reserveData);
}

/**
 * Query an RWA asset by unique external reference (certificate number, code).
 * @param {string} externalRef
 */
async function getAssetByRef(externalRef) {
    if (!externalRef) {
        const err = new Error('External reference parameter is required.');
        err.statusCode = 400;
        err.code = 'MISSING_EXTERNAL_REF';
        throw err;
    }

    const registry = await getAssetRegistryContract();
    const bytes32Ref = encodeBytes32(externalRef);

    let assetId;
    try {
        assetId = await registry.assetIdByRef(bytes32Ref);
    } catch (err) {
        const fetchErr = new Error(`Failed to query asset reference: ${err.message}`);
        fetchErr.statusCode = 502;
        fetchErr.code = 'RPC_FETCH_FAILED';
        throw fetchErr;
    }

    if (!assetId || assetId === 0n) {
        const err = new Error(`Asset with reference "${externalRef}" not found.`);
        err.statusCode = 404;
        err.code = 'ASSET_NOT_FOUND';
        throw err;
    }

    return getAssetById(Number(assetId));
}

/**
 * List RWA assets with filtering, pagination, and sorting.
 * @param {object} params
 */
async function listAssets({ page = 1, limit = 20, status, assetClass, owner, sort = 'desc' } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const registry = await getAssetRegistryContract();
    const rm = contracts.reserveManager();

    const [nextAssetId, totalApprovedValue, statusCountsRaw] = await Promise.all([
        registry.nextAssetId().catch(() => 1n),
        registry.totalApprovedValue().catch(() => 0n),
        Promise.all([1, 2, 3, 4, 5].map(s => registry.statusCount(s).catch(() => 0n)))
    ]);

    const totalRegistered = Math.max(0, Number(nextAssetId) - 1);
    const statusCounts = {
        total: totalRegistered,
        pending: Number(statusCountsRaw[0]),
        approved: Number(statusCountsRaw[1]),
        rejected: Number(statusCountsRaw[2]),
        suspended: Number(statusCountsRaw[3]),
        retired: Number(statusCountsRaw[4])
    };

    if (totalRegistered === 0) {
        return {
            success: true,
            total: 0,
            totalRegistered: 0,
            page: pageNum,
            limit: limitNum,
            totalPages: 0,
            statusCounts,
            totalApprovedValue: {
                raw: totalApprovedValue.toString(),
                formatted: ethers.formatEther(totalApprovedValue),
                unit: 'USD'
            },
            assets: []
        };
    }

    // Generate asset ID range
    const allIds = [];
    for (let i = 1; i <= totalRegistered; i++) {
        allIds.push(i);
    }

    if (sort.toLowerCase() !== 'asc') {
        allIds.reverse();
    }

    // Concurrently fetch all asset records
    const assetRecords = await Promise.all(
        allIds.map(async (id) => {
            try {
                const a = await registry.getAsset(id);
                if (!a || Number(a.status) === 0) return null;

                const [tokenOwner, uri, reserveData] = await Promise.all([
                    registry.ownerOf(id).catch(() => null),
                    registry.tokenURI(id).catch(() => null),
                    rm ? fetchAssetReserveData(rm, id) : null
                ]);

                return serializeAsset(id, a, tokenOwner, uri, reserveData);
            } catch {
                return null;
            }
        })
    );

    let filtered = assetRecords.filter(Boolean);

    // Filter by status (name or code)
    if (status !== undefined && status !== null && status !== '') {
        const statusQuery = String(status).toLowerCase().trim();
        filtered = filtered.filter(item => {
            if (item.status.name.toLowerCase() === statusQuery) return true;
            if (String(item.status.code) === statusQuery) return true;
            return false;
        });
    }

    // Filter by assetClass (name or raw)
    if (assetClass) {
        const classQuery = String(assetClass).toLowerCase().trim();
        filtered = filtered.filter(item => {
            return (
                item.assetClass.name.toLowerCase().includes(classQuery) ||
                item.assetClass.raw.toLowerCase() === classQuery
            );
        });
    }

    // Filter by owner address
    if (owner) {
        const ownerQuery = String(owner).toLowerCase().trim();
        filtered = filtered.filter(item => {
            return item.owner && item.owner.toLowerCase() === ownerQuery;
        });
    }

    const filteredTotal = filtered.length;
    const totalPages = Math.ceil(filteredTotal / limitNum) || 0;
    const offset = (pageNum - 1) * limitNum;
    const paginatedAssets = filtered.slice(offset, offset + limitNum);

    return {
        success: true,
        total: filteredTotal,
        totalRegistered,
        page: pageNum,
        limit: limitNum,
        totalPages,
        statusCounts,
        totalApprovedValue: {
            raw: totalApprovedValue.toString(),
            formatted: ethers.formatEther(totalApprovedValue),
            unit: 'USD'
        },
        assets: paginatedAssets
    };
}

/**
 * Get summary statistics for the RWA Asset Registry.
 */
async function getSummary() {
    const registry = await getAssetRegistryContract();
    const rm = contracts.reserveManager();

    const [
        nextAssetId,
        totalApprovedValue,
        paused,
        reserveHook,
        networkRes,
        blockNumberRes,
        statusCountsRaw,
        contractAddress
    ] = await Promise.all([
        registry.nextAssetId().catch(() => 1n),
        registry.totalApprovedValue().catch(() => 0n),
        registry.paused().catch(() => false),
        registry.reserveHook().catch(() => ethers.ZeroAddress),
        provider ? provider.getNetwork().catch(() => null) : null,
        provider ? provider.getBlockNumber().catch(() => null) : null,
        Promise.all([1, 2, 3, 4, 5].map(s => registry.statusCount(s).catch(() => 0n))),
        registry.getAddress().catch(() => null)
    ]);

    const totalAssets = Math.max(0, Number(nextAssetId) - 1);

    return {
        success: true,
        contract: {
            address: contractAddress,
            paused: Boolean(paused),
            reserveHook: reserveHook && reserveHook !== ethers.ZeroAddress ? reserveHook : null,
            reserveManagerConfigured: Boolean(rm)
        },
        network: {
            chainId: networkRes ? Number(networkRes.chainId) : config.CHAIN_ID || null,
            name: networkRes ? networkRes.name : 'unknown',
            blockNumber: blockNumberRes
        },
        timestamp: new Date().toISOString(),
        summary: {
            totalAssets,
            totalApprovedValue: {
                raw: totalApprovedValue.toString(),
                formatted: ethers.formatEther(totalApprovedValue),
                unit: 'USD'
            },
            statusCounts: {
                pending: Number(statusCountsRaw[0]),
                approved: Number(statusCountsRaw[1]),
                rejected: Number(statusCountsRaw[2]),
                suspended: Number(statusCountsRaw[3]),
                retired: Number(statusCountsRaw[4])
            }
        }
    };
}

module.exports = {
    getAssetById,
    getAssetByRef,
    listAssets,
    getSummary,
    serializeAsset,
    decodeBytes32,
    encodeBytes32,
    getAssetRegistryContract,
    ASSET_STATUS
};
