const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');
const blockchainService = require('../../src/services/blockchain.service');
const settlementService = require('../../src/services/settlement.service');
const analyticsService = require('../../src/services/analytics.service');
const reconciliationService = require('../../src/services/reconciliation.service');
const settlementRepository = require('../../src/db/settlementRepository');
const { createTestRepository } = require('../helpers/testHelpers');

test('Settlement Service - Eligibility and Execution with Contract Mocks', async (t) => {
    const originalContracts = { ...blockchainService.contracts };
    const originalWallet = blockchainService.wallet;
    const { repo, db } = await createTestRepository();

    // Point settlementService repository to test repository
    const originalRepo = settlementRepository.db;

    t.after(async () => {
        blockchainService.contracts = originalContracts;
        blockchainService.wallet = originalWallet;
        await db.close();
    });

    await t.test('checkEligibility returns 404 when redemption does not exist', async () => {
        blockchainService.contracts.redemptionModule = () => ({
            getRedemption: async (id) => ({
                redeemer: ethers.ZeroAddress,
                amount: 0n,
                usdcAmount: 0n,
                priceUsed: 0n,
                createdAt: 0n,
                approvedAt: 0n,
                status: 0 // None
            })
        });

        const result = await settlementService.checkEligibility(999);
        assert.strictEqual(result.exists, false);
        assert.strictEqual(result.eligible, false);
        assert.strictEqual(result.statusCode, 404);
        assert.ok(result.reason.includes('does not exist'));
    });

    await t.test('checkEligibility returns 400 when redemption is Pending DAO approval', async () => {
        blockchainService.contracts.redemptionModule = () => ({
            getRedemption: async (id) => ({
                redeemer: '0x1111111111111111111111111111111111111111',
                amount: ethers.parseEther('100'),
                usdcAmount: 0n,
                priceUsed: 0n,
                createdAt: 1000n,
                approvedAt: 0n,
                status: 1 // Pending
            })
        });

        const result = await settlementService.checkEligibility(1);
        assert.strictEqual(result.exists, true);
        assert.strictEqual(result.eligible, false);
        assert.strictEqual(result.statusCode, 400);
        assert.strictEqual(result.status, 'Pending');
        assert.ok(result.reason.includes('DAO approval'));
    });

    await t.test('checkEligibility returns 400 when redemption is already Settled', async () => {
        blockchainService.contracts.redemptionModule = () => ({
            getRedemption: async (id) => ({
                redeemer: '0x1111111111111111111111111111111111111111',
                amount: ethers.parseEther('100'),
                usdcAmount: 99_500_000n,
                priceUsed: ethers.parseEther('1'),
                createdAt: 1000n,
                approvedAt: 1010n,
                status: 3 // Settled
            })
        });

        const result = await settlementService.checkEligibility(1);
        assert.strictEqual(result.exists, true);
        assert.strictEqual(result.eligible, false);
        assert.strictEqual(result.statusCode, 400);
        assert.strictEqual(result.status, 'Settled');
    });

    await t.test('checkEligibility returns 400 when contract is paused', async () => {
        blockchainService.contracts.redemptionModule = () => ({
            getRedemption: async (id) => ({
                redeemer: '0x1111111111111111111111111111111111111111',
                amount: ethers.parseEther('100'),
                usdcAmount: 99_500_000n,
                priceUsed: ethers.parseEther('1'),
                createdAt: 1000n,
                approvedAt: 1010n,
                status: 2 // Approved
            }),
            paused: async () => true
        });
        blockchainService.contracts.vittaStablecoin = () => ({
            paused: async () => false
        });

        const result = await settlementService.checkEligibility(1);
        assert.strictEqual(result.eligible, false);
        assert.strictEqual(result.statusCode, 400);
        assert.ok(result.reason.includes('paused'));
    });

    await t.test('checkEligibility returns 200 eligible when Approved and signer has SETTLER_ROLE', async () => {
        blockchainService.wallet = new ethers.Wallet('0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356');
        blockchainService.contracts.redemptionModule = () => ({
            getRedemption: async (id) => ({
                redeemer: '0x1111111111111111111111111111111111111111',
                amount: ethers.parseEther('100'),
                usdcAmount: 99_500_000n,
                priceUsed: ethers.parseEther('1'),
                createdAt: 1000n,
                approvedAt: 1010n,
                status: 2 // Approved
            }),
            paused: async () => false,
            hasRole: async (role, addr) => true
        });
        blockchainService.contracts.vittaStablecoin = () => ({
            paused: async () => false
        });

        const result = await settlementService.checkEligibility(1);
        assert.strictEqual(result.eligible, true);
        assert.strictEqual(result.status, 'Approved');
        assert.strictEqual(result.redemption.amount.formatted, '100.0');
        assert.strictEqual(result.redemption.usdcAmount.formatted, '99.5');
    });
});
