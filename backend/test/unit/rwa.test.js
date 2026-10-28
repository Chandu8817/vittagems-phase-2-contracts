const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');
const {
    serializeAsset,
    decodeBytes32,
    encodeBytes32,
    getAssetById,
    getAssetByRef,
    listAssets,
    getSummary,
    ASSET_STATUS
} = require('../../src/services/rwa.service');
const { contracts } = require('../../src/services/blockchain.service');

test('RWA Service - Asset Data Processing & Serialization', async (t) => {
    await t.test('decodes and encodes bytes32 strings properly', () => {
        const str = 'GEMSTONE';
        const encoded = encodeBytes32(str);
        assert.ok(/^0x[0-9a-fA-F]{64}$/.test(encoded));
        assert.strictEqual(decodeBytes32(encoded), 'GEMSTONE');

        // Handles ZeroHash
        assert.strictEqual(decodeBytes32(ethers.ZeroHash), '');
        assert.strictEqual(decodeBytes32(null), '');

        // Handles already formatted 32-byte hex
        const customHex = '0x1111111111111111111111111111111111111111111111111111111111111111';
        assert.strictEqual(encodeBytes32(customHex), customHex);
    });

    await t.test('serializes asset struct into clean JSON presentation with 18-decimal USD valuation', () => {
        const rawAsset = {
            assetClass: encodeBytes32('GEMSTONE'),
            externalRef: encodeBytes32('EMERALD-001'),
            documentHash: ethers.id('doc-bundle-content'),
            valuation: ethers.parseEther('1500000'), // $1.5M with 18 decimals
            valuedAt: 1700000000n,
            registeredAt: 1690000000n,
            updatedAt: 1700000500n,
            status: 2n, // Approved
            registrant: '0x1111111111111111111111111111111111111111'
        };

        const owner = '0x2222222222222222222222222222222222222222';
        const uri = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
        const reserveData = {
            allocatedBps: 5000n, // 50%
            reserveValue: ethers.parseEther('750000'), // $750k in reserves
            pools: [1, 2]
        };

        const serialized = serializeAsset(1, rawAsset, owner, uri, reserveData);

        assert.strictEqual(serialized.id, 1);
        assert.strictEqual(serialized.assetClass.name, 'GEMSTONE');
        assert.strictEqual(serialized.externalRef.code, 'EMERALD-001');
        assert.strictEqual(serialized.valuation.formatted, '1500000.0');
        assert.strictEqual(serialized.valuation.raw, '1500000000000000000000000');
        assert.strictEqual(serialized.valuation.unit, 'USD');
        assert.strictEqual(serialized.status.code, 2);
        assert.strictEqual(serialized.status.name, 'Approved');
        assert.strictEqual(serialized.owner, owner);
        assert.strictEqual(serialized.tokenURI, uri);
        assert.strictEqual(serialized.dates.valuedAt, 1700000000);
        assert.strictEqual(serialized.dates.valuedAtIso, new Date(1700000000 * 1000).toISOString());
        assert.strictEqual(serialized.reserves.allocatedBps, 5000);
        assert.strictEqual(serialized.reserves.allocatedPercent, '50.00%');
        assert.strictEqual(serialized.reserves.reserveValue.formatted, '750000.0');
        assert.deepStrictEqual(serialized.reserves.pools, [1, 2]);
    });

    await t.test('maps all enum asset statuses accurately', () => {
        assert.strictEqual(ASSET_STATUS[0], 'None');
        assert.strictEqual(ASSET_STATUS[1], 'Pending');
        assert.strictEqual(ASSET_STATUS[2], 'Approved');
        assert.strictEqual(ASSET_STATUS[3], 'Rejected');
        assert.strictEqual(ASSET_STATUS[4], 'Suspended');
        assert.strictEqual(ASSET_STATUS[5], 'Retired');
    });
});

test('RWA Service - Contract Interaction and Validation with Mocks', async (t) => {
    const originalAssetRegistry = contracts.assetRegistry;
    const originalReserveManager = contracts.reserveManager;

    t.after(() => {
        contracts.assetRegistry = originalAssetRegistry;
        contracts.reserveManager = originalReserveManager;
    });

    await t.test('getAssetById validates positive integer asset ID', async () => {
        await assert.rejects(async () => {
            await getAssetById('invalid');
        }, (err) => {
            return err.statusCode === 400 && err.code === 'INVALID_ASSET_ID';
        });

        await assert.rejects(async () => {
            await getAssetById(0);
        }, (err) => {
            return err.statusCode === 400 && err.code === 'INVALID_ASSET_ID';
        });

        await assert.rejects(async () => {
            await getAssetById(-5);
        }, (err) => {
            return err.statusCode === 400 && err.code === 'INVALID_ASSET_ID';
        });
    });

    await t.test('getAssetById returns 404 if asset does not exist (status 0)', async () => {
        contracts.assetRegistry = () => ({
            getAsset: async (id) => ({
                status: 0n,
                assetClass: ethers.ZeroHash,
                externalRef: ethers.ZeroHash,
                documentHash: ethers.ZeroHash,
                valuation: 0n,
                valuedAt: 0n,
                registeredAt: 0n,
                updatedAt: 0n,
                registrant: ethers.ZeroAddress
            })
        });

        await assert.rejects(async () => {
            await getAssetById(999);
        }, (err) => {
            return err.statusCode === 404 && err.code === 'ASSET_NOT_FOUND';
        });
    });

    await t.test('getAssetById successfully retrieves and serializes existing asset', async () => {
        contracts.assetRegistry = () => ({
            getAsset: async (id) => ({
                status: 2n, // Approved
                assetClass: encodeBytes32('GOLD'),
                externalRef: encodeBytes32('GOLD-BAR-999'),
                documentHash: ethers.id('gold-certificate'),
                valuation: ethers.parseEther('250000'),
                valuedAt: 1700000000n,
                registeredAt: 1695000000n,
                updatedAt: 1700000000n,
                registrant: '0x1111111111111111111111111111111111111111'
            }),
            ownerOf: async (id) => '0x3333333333333333333333333333333333333333',
            tokenURI: async (id) => 'ipfs://gold-metadata'
        });

        contracts.reserveManager = () => ({
            allocatedBps: async (id) => 10000n, // 100%
            assetReserveValue: async (id) => ethers.parseEther('250000'),
            assetPools: async (id) => [1n]
        });

        const asset = await getAssetById(1);
        assert.strictEqual(asset.id, 1);
        assert.strictEqual(asset.assetClass.name, 'GOLD');
        assert.strictEqual(asset.externalRef.code, 'GOLD-BAR-999');
        assert.strictEqual(asset.status.name, 'Approved');
        assert.strictEqual(asset.valuation.formatted, '250000.0');
        assert.strictEqual(asset.owner, '0x3333333333333333333333333333333333333333');
        assert.strictEqual(asset.tokenURI, 'ipfs://gold-metadata');
        assert.strictEqual(asset.reserves.allocatedPercent, '100.00%');
        assert.deepStrictEqual(asset.reserves.pools, [1]);
    });

    await t.test('getAssetByRef validates externalRef parameter and returns 404 if not found', async () => {
        await assert.rejects(async () => {
            await getAssetByRef('');
        }, (err) => {
            return err.statusCode === 400 && err.code === 'MISSING_EXTERNAL_REF';
        });

        contracts.assetRegistry = () => ({
            assetIdByRef: async (ref) => 0n
        });

        await assert.rejects(async () => {
            await getAssetByRef('UNKNOWN-REF');
        }, (err) => {
            return err.statusCode === 404 && err.code === 'ASSET_NOT_FOUND';
        });
    });

    await t.test('listAssets returns empty list when no assets are registered', async () => {
        contracts.assetRegistry = () => ({
            nextAssetId: async () => 1n,
            totalApprovedValue: async () => 0n,
            statusCount: async () => 0n
        });

        const result = await listAssets();
        assert.strictEqual(result.total, 0);
        assert.strictEqual(result.totalRegistered, 0);
        assert.strictEqual(result.assets.length, 0);
        assert.strictEqual(result.statusCounts.total, 0);
    });

    await t.test('listAssets filters by status and assetClass', async () => {
        const mockAssets = {
            1: {
                status: 2n, // Approved
                assetClass: encodeBytes32('GEMSTONE'),
                externalRef: encodeBytes32('GEM-1'),
                documentHash: ethers.id('doc1'),
                valuation: ethers.parseEther('100000'),
                valuedAt: 1700000000n,
                registeredAt: 1690000000n,
                updatedAt: 1700000000n,
                registrant: '0x1111111111111111111111111111111111111111'
            },
            2: {
                status: 1n, // Pending
                assetClass: encodeBytes32('MINING_OUTPUT'),
                externalRef: encodeBytes32('MINE-1'),
                documentHash: ethers.id('doc2'),
                valuation: ethers.parseEther('50000'),
                valuedAt: 1700000000n,
                registeredAt: 1690000000n,
                updatedAt: 1700000000n,
                registrant: '0x1111111111111111111111111111111111111111'
            }
        };

        contracts.assetRegistry = () => ({
            nextAssetId: async () => 3n,
            totalApprovedValue: async () => ethers.parseEther('100000'),
            statusCount: async (s) => (s === 2 ? 1n : s === 1 ? 1n : 0n),
            getAsset: async (id) => mockAssets[id],
            ownerOf: async (id) => '0x2222222222222222222222222222222222222222',
            tokenURI: async (id) => `ipfs://asset-${id}`
        });

        contracts.reserveManager = () => ({
            allocatedBps: async () => 0n,
            assetReserveValue: async () => 0n,
            assetPools: async () => []
        });

        // Query all
        const allResult = await listAssets();
        assert.strictEqual(allResult.total, 2);
        assert.strictEqual(allResult.statusCounts.approved, 1);
        assert.strictEqual(allResult.statusCounts.pending, 1);

        // Filter by status=Approved
        const approvedOnly = await listAssets({ status: 'Approved' });
        assert.strictEqual(approvedOnly.total, 1);
        assert.strictEqual(approvedOnly.assets[0].externalRef.code, 'GEM-1');

        // Filter by assetClass=mining
        const miningOnly = await listAssets({ assetClass: 'mining' });
        assert.strictEqual(miningOnly.total, 1);
        assert.strictEqual(miningOnly.assets[0].assetClass.name, 'MINING_OUTPUT');
    });

    await t.test('getSummary aggregates registry totals and configuration state', async () => {
        contracts.assetRegistry = () => ({
            nextAssetId: async () => 6n,
            totalApprovedValue: async () => ethers.parseEther('4500000'),
            paused: async () => false,
            reserveHook: async () => '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0',
            statusCount: async (s) => (s === 2 ? 3n : s === 1 ? 1n : 0n),
            getAddress: async () => '0x5fbdb2315678afecb367f032d93f642f64180aa3'
        });

        const summary = await getSummary();
        assert.strictEqual(summary.success, true);
        assert.strictEqual(summary.summary.totalAssets, 5);
        assert.strictEqual(summary.summary.totalApprovedValue.formatted, '4500000.0');
        assert.strictEqual(summary.summary.statusCounts.approved, 3);
        assert.strictEqual(summary.contract.address, '0x5fbdb2315678afecb367f032d93f642f64180aa3');
        assert.strictEqual(summary.contract.paused, false);
    });
});
