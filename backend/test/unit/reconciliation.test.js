const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');
const { createTestRepository } = require('../helpers/testHelpers');

test('Reconciliation Logic and Mismatch Detection', async (t) => {
    const { repo, db } = await createTestRepository();

    t.after(async () => {
        await db.close();
    });

    await t.test('detects parameter mismatch between DB record and on-chain event', async () => {
        const ref = ethers.id('REF-ORIGINAL');
        const created = await repo.create({
            requestId: 10,
            settlementRef: ref,
            status: 'PENDING',
            redeemer: '0x1111111111111111111111111111111111111111',
            amountBurned: '1000000000000000000000',
            usdcPaid: '995000000'
        });

        // Simulating reconciliation comparing against a different on-chain event value
        const onChainAmount = '2000000000000000000000'; // Different!
        const amountMatches = BigInt(created.amount_burned) === BigInt(onChainAmount);

        assert.strictEqual(amountMatches, false);

        // Update to MISMATCHED
        const updated = await repo.update(created.id, {
            status: 'MISMATCHED',
            errorMessage: 'Amount burned mismatch: DB 1000, On-chain 2000'
        });

        assert.strictEqual(updated.status, 'MISMATCHED');
        assert.ok(updated.error_message.includes('Amount burned mismatch'));
    });

    await t.test('reconciles and confirms pending record when on-chain event matches', async () => {
        const ref = ethers.id('REF-MATCHING');
        const created = await repo.create({
            requestId: 11,
            settlementRef: ref,
            status: 'PENDING',
            redeemer: '0x2222222222222222222222222222222222222222',
            amountBurned: '500000000000000000000',
            usdcPaid: '497500000'
        });

        const onChainEvent = {
            id: 11,
            redeemer: '0x2222222222222222222222222222222222222222',
            amountBurned: '500000000000000000000',
            usdcPaid: '497500000',
            settlementRef: ref,
            txHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
            blockNumber: 42
        };

        const matches = BigInt(created.amount_burned) === BigInt(onChainEvent.amountBurned) &&
                        BigInt(created.usdc_paid) === BigInt(onChainEvent.usdcPaid) &&
                        created.settlement_ref.toLowerCase() === onChainEvent.settlementRef.toLowerCase();

        assert.strictEqual(matches, true);

        const updated = await repo.update(created.id, {
            status: 'CONFIRMED',
            txHash: onChainEvent.txHash,
            blockNumber: onChainEvent.blockNumber,
            onChainStatus: 'Settled',
            reconciledAt: new Date().toISOString()
        });

        assert.strictEqual(updated.status, 'CONFIRMED');
        assert.strictEqual(updated.block_number, 42);
    });
});
