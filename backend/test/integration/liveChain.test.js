const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');
const blockchainService = require('../../src/services/blockchain.service');
const settlementService = require('../../src/services/settlement.service');
const reconciliationService = require('../../src/services/reconciliation.service');
const analyticsService = require('../../src/services/analytics.service');
const settlementRepository = require('../../src/db/settlementRepository');
const config = require('../../src/config/config');

test('Live Anvil Integration - Full Lifecycle: Mint -> Redeem -> Approve -> Settle -> Reconcile', async (t) => {
    const connectivity = await blockchainService.verifyConnectivity();
    if (!connectivity.connected || !connectivity.contracts.redemptionModule.deployed) {
        t.skip('Skipping live chain integration test: local Anvil node not reachable or contracts not deployed.');
        return;
    }

    const provider = blockchainService.provider;
    // Account 0 is Admin (deployer)
    const admin = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
    // Account 9 is Holder
    const holder = new ethers.Wallet('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', provider);

    const vsContract = blockchainService.contracts.vittaStablecoin();
    const rmContract = blockchainService.contracts.redemptionModule();

    // 1. Setup tokens for Holder: Admin temporarily grants MINTER_ROLE to admin, mints to holder, and revokes
    const MINTER_ROLE = ethers.id('MINTER_ROLE');
    const vsAdmin = vsContract.connect(admin);
    const rmAdmin = rmContract.connect(admin);
    const vsHolder = vsContract.connect(holder);
    const rmHolder = rmContract.connect(holder);

    let adminNonce = await provider.getTransactionCount(admin.address, 'latest');
    let holderNonce = await provider.getTransactionCount(holder.address, 'latest');

    const hasMinter = await vsContract.hasRole(MINTER_ROLE, admin.address);
    if (!hasMinter) {
        const txGrant = await vsAdmin.grantRole(MINTER_ROLE, admin.address, { nonce: adminNonce++ });
        await txGrant.wait();
    }

    const mintAmount = ethers.parseEther('1000');
    const txMint = await vsAdmin.mint(holder.address, mintAmount, { nonce: adminNonce++ });
    await txMint.wait();

    // 2. Holder approves RedemptionModule and calls requestRedemption
    const txApproveToken = await vsHolder.approve(config.CONTRACTS.REDEMPTION_MODULE, mintAmount, { nonce: holderNonce++ });
    await txApproveToken.wait();

    const txRequest = await rmHolder.requestRedemption(mintAmount, { nonce: holderNonce++ });
    const reqReceipt = await txRequest.wait();

    // Find RedemptionRequested event to get ID
    let redemptionId = null;
    for (const log of reqReceipt.logs) {
        try {
            const parsed = rmContract.interface.parseLog(log);
            if (parsed && parsed.name === 'RedemptionRequested') {
                redemptionId = Number(parsed.args[0]);
                break;
            }
        } catch {
            // ignore
        }
    }

    assert.ok(redemptionId, 'Should have received a valid redemptionId');

    // 3. Inspect before DAO approval: should be in Pending status (ineligible for settlement)
    const beforeApproval = await settlementService.checkEligibility(redemptionId);
    assert.strictEqual(beforeApproval.eligible, false);
    assert.strictEqual(beforeApproval.status, 'Pending');

    // 4. Admin (Governor) approves redemption
    const txApproveRedeem = await rmAdmin.approveRedemption(redemptionId, { nonce: adminNonce++ });
    await txApproveRedeem.wait();

    // 5. Inspect after DAO approval: should be eligible!
    const afterApproval = await settlementService.checkEligibility(redemptionId);
    assert.strictEqual(afterApproval.eligible, true);
    assert.strictEqual(afterApproval.status, 'Approved');

    // 6. Settlement API settles the approved request
    const customRef = `REF-TEST-${Date.now()}`;
    const settlementResult = await settlementService.settleRedemption({
        requestId: redemptionId,
        settlementRef: customRef
    });

    assert.strictEqual(settlementResult.success, true);
    assert.strictEqual(settlementResult.status, 'CONFIRMED');
    assert.strictEqual(settlementResult.requestId, redemptionId);
    assert.ok(settlementResult.txHash);
    assert.ok(settlementResult.blockNumber);

    // 7. Verify settlement idempotency: repeating the settle call returns existing CONFIRMED record
    const idempotentResult = await settlementService.settleRedemption({
        requestId: redemptionId,
        settlementRef: customRef
    });

    assert.strictEqual(idempotentResult.status, 'CONFIRMED');
    assert.strictEqual(idempotentResult.idempotent, true);
    assert.strictEqual(idempotentResult.txHash, settlementResult.txHash);

    // 8. Run reconciliation: confirms records and identifies on-chain state
    const reconResult = await reconciliationService.runReconciliation({
        fromBlock: reqReceipt.blockNumber,
        requestId: redemptionId
    });

    assert.strictEqual(reconResult.success, true);
    assert.ok(reconResult.stats.confirmed >= 1);
    assert.strictEqual(reconResult.stats.mismatched, 0);

    // 9. Verify supply and reserve analytics reflect the burn
    const supplyAnalytics = await analyticsService.getSupplyAnalytics();
    assert.ok(supplyAnalytics.supply.totalSupply);
});
