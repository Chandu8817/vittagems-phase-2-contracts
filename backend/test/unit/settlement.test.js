const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');
const { formatSettlementRef, REDEMPTION_STATUS } = require('../../src/services/settlement.service');
const { createTestRepository } = require('../helpers/testHelpers');

test('Settlement Reference Formatting', async (t) => {
    await t.test('generates unique bytes32 reference when not provided', () => {
        const ref1 = formatSettlementRef(null, 1);
        const ref2 = formatSettlementRef(null, 1);

        assert.ok(/^0x[0-9a-fA-F]{64}$/.test(ref1), 'Should be valid 32-byte hex string');
        assert.ok(/^0x[0-9a-fA-F]{64}$/.test(ref2), 'Should be valid 32-byte hex string');
        assert.notStrictEqual(ref1, ref2, 'Consecutive generated refs must be unique');
    });

    await t.test('accepts valid 32-byte hex string as-is', () => {
        const customHex = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        const formatted = formatSettlementRef(customHex, 1);
        assert.strictEqual(formatted, customHex.toLowerCase());
    });

    await t.test('hashes arbitrary string to deterministic bytes32', () => {
        const customString = 'SETTLEMENT-OFFCHAIN-BANK-WIRE-REF-999';
        const formatted = formatSettlementRef(customString, 1);
        const expected = ethers.id(customString);

        assert.strictEqual(formatted, expected);
        assert.ok(/^0x[0-9a-fA-F]{64}$/.test(formatted));
    });

    await t.test('rejects references longer than 128 characters', () => {
        const overlyLong = 'A'.repeat(129);
        assert.throws(() => {
            formatSettlementRef(overlyLong, 1);
        }, (err) => {
            return err.statusCode === 400 && err.code === 'INVALID_SETTLEMENT_REF';
        });
    });
});

test('Settlement Repository & Idempotency', async (t) => {
    const { repo, db } = await createTestRepository();

    t.after(async () => {
        await db.close();
    });

    await t.test('creates and retrieves a settlement record', async () => {
        const ref = ethers.id('REF-TEST-001');
        const created = await repo.create({
            requestId: 1,
            settlementRef: ref,
            idempotencyKey: 'idemp-key-1',
            status: 'SUBMITTING',
            redeemer: '0x1111111111111111111111111111111111111111',
            amountBurned: '1000000000000000000000',
            usdcPaid: '995000000'
        });

        assert.ok(created.id);
        assert.strictEqual(created.request_id, 1);
        assert.strictEqual(created.settlement_ref, ref);
        assert.strictEqual(created.status, 'SUBMITTING');

        const found = await repo.findByRequestId(1);
        assert.strictEqual(found.id, created.id);

        const foundByKey = await repo.findByIdempotencyKey('idemp-key-1');
        assert.strictEqual(foundByKey.id, created.id);
    });

    await t.test('updates settlement to CONFIRMED on transaction success', async () => {
        const existing = await repo.findByRequestId(1);
        const updated = await repo.update(existing.id, {
            status: 'CONFIRMED',
            txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            blockNumber: 12345,
            gasUsed: '85000',
            onChainStatus: 'Settled',
            reconciledAt: new Date().toISOString()
        });

        assert.strictEqual(updated.status, 'CONFIRMED');
        assert.strictEqual(updated.block_number, 12345);
        assert.strictEqual(updated.on_chain_status, 'Settled');
    });

    await t.test('idempotently finds existing record by request ID or idempotency key', async () => {
        const matchByReq = await repo.findExisting({ requestId: 1 });
        assert.ok(matchByReq);
        assert.strictEqual(matchByReq.status, 'CONFIRMED');

        const matchByKey = await repo.findExisting({ idempotencyKey: 'idemp-key-1' });
        assert.ok(matchByKey);
        assert.strictEqual(matchByKey.request_id, 1);

        const noMatch = await repo.findExisting({ requestId: 999, idempotencyKey: 'unknown' });
        assert.strictEqual(noMatch, null);
    });

    await t.test('aggregates summary accurately across statuses', async () => {
        // Add a failed record
        await repo.create({
            requestId: 2,
            settlementRef: ethers.id('REF-TEST-002'),
            status: 'FAILED',
            errorMessage: 'Reverted on chain'
        });

        const summary = await repo.getSummary();
        assert.strictEqual(summary.total, 2);
        assert.strictEqual(summary.byStatus.CONFIRMED, 1);
        assert.strictEqual(summary.byStatus.FAILED, 1);
        assert.strictEqual(summary.confirmedTotals.amountBurnedWei, '1000000000000000000000');
        assert.strictEqual(summary.confirmedTotals.usdcPaidUnits, '995000000');
    });
});
