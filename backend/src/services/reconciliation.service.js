const { ethers } = require('ethers');
const { provider, contracts } = require('./blockchain.service');
const settlementRepository = require('../db/settlementRepository');

const TREASURY_RECONCILIATION_NOTICE = 
    'On-chain stablecoin burn and Treasury releaseUSDC call have been verified via RedemptionModule events. ' +
    'External off-chain bank / fiat transfers cannot be reconciled until the production Treasury service/API is implemented.';

/**
 * Run reconciliation against on-chain events and transaction receipts.
 * Blockchain is treated as authoritative. Safe to rerun at any time.
 * @param {object} options { fromBlock, toBlock, requestId }
 */
async function runReconciliation(options = {}) {
    const rm = contracts.redemptionModule();
    if (!rm || !provider) {
        const err = new Error('RedemptionModule contract or blockchain provider is unavailable.');
        err.statusCode = 503;
        throw err;
    }

    const fromBlock = options.fromBlock !== undefined ? options.fromBlock : 0;
    const toBlock = options.toBlock || 'latest';
    const filterRequestId = options.requestId ? Number(options.requestId) : null;

    let events = [];
    try {
        const filter = rm.filters.RedemptionSettled(filterRequestId || null);
        events = await rm.queryFilter(filter, fromBlock, toBlock);
    } catch (err) {
        const filterErr = new Error(`Failed to query RedemptionSettled events: ${err.message}`);
        filterErr.statusCode = 502;
        throw filterErr;
    }

    let newlyCreated = 0;
    let confirmedCount = 0;
    let mismatchedCount = 0;
    let pendingResolved = 0;

    const eventIds = new Set();

    // 1. Reconcile on-chain events with database records
    for (const ev of events) {
        const id = Number(ev.args[0]);
        const redeemer = ev.args[1];
        const amountBurned = ev.args[2].toString();
        const usdcPaid = ev.args[3].toString();
        const settlementRef = ev.args[4];
        const txHash = ev.transactionHash;
        const blockNumber = ev.blockNumber;

        eventIds.add(id);

        const existing = await settlementRepository.findByRequestId(id);

        if (!existing) {
            // Event exists on chain but was not in database (e.g. submitted externally or restored)
            await settlementRepository.create({
                requestId: id,
                settlementRef,
                status: 'CONFIRMED',
                txHash,
                redeemer,
                amountBurned,
                usdcPaid,
                blockNumber,
                onChainStatus: 'Settled',
                reconciledAt: new Date().toISOString()
            });
            newlyCreated++;
            confirmedCount++;
        } else {
            // Verify existing record matches event data
            const amountMatches = existing.amount_burned ? BigInt(existing.amount_burned) === BigInt(amountBurned) : true;
            const usdcMatches = existing.usdc_paid ? BigInt(existing.usdc_paid) === BigInt(usdcPaid) : true;
            const refMatches = existing.settlement_ref ? existing.settlement_ref.toLowerCase() === settlementRef.toLowerCase() : true;

            if (!amountMatches || !usdcMatches || !refMatches) {
                // Mismatch detected between DB record and on-chain event!
                await settlementRepository.update(existing.id, {
                    status: 'MISMATCHED',
                    errorMessage: `Data mismatch detected: DB ref=${existing.settlement_ref}, on-chain ref=${settlementRef}; DB amount=${existing.amount_burned}, on-chain=${amountBurned}`,
                    onChainStatus: 'Settled',
                    reconciledAt: new Date().toISOString()
                });
                mismatchedCount++;
            } else {
                // Record matches on-chain event
                await settlementRepository.update(existing.id, {
                    status: 'CONFIRMED',
                    txHash,
                    blockNumber,
                    amountBurned,
                    usdcPaid,
                    onChainStatus: 'Settled',
                    reconciledAt: new Date().toISOString()
                });
                confirmedCount++;
                if (existing.status !== 'CONFIRMED') {
                    pendingResolved++;
                }
            }
        }
    }

    // 2. Check pending / submitting records in database that were not in the event log
    const listRes = await settlementRepository.list({ limit: 100, offset: 0 });
    const pendingRecords = listRes.records.filter(
        r => r.status === 'PENDING' || r.status === 'SUBMITTING'
    );

    for (const record of pendingRecords) {
        if (eventIds.has(record.request_id)) continue;

        try {
            // Check on-chain redemption status
            const onChainRedemption = await rm.getRedemption(record.request_id);
            const statusNum = Number(onChainRedemption.status);

            if (statusNum === 3) { // Settled on-chain
                await settlementRepository.update(record.id, {
                    status: 'CONFIRMED',
                    onChainStatus: 'Settled',
                    reconciledAt: new Date().toISOString()
                });
                confirmedCount++;
                pendingResolved++;
            } else if (statusNum === 4) { // Rejected
                await settlementRepository.update(record.id, {
                    status: 'FAILED',
                    onChainStatus: 'Rejected',
                    errorMessage: 'Redemption request was rejected on-chain',
                    reconciledAt: new Date().toISOString()
                });
            } else if (statusNum === 5) { // Cancelled
                await settlementRepository.update(record.id, {
                    status: 'FAILED',
                    onChainStatus: 'Cancelled',
                    errorMessage: 'Redemption request was cancelled on-chain',
                    reconciledAt: new Date().toISOString()
                });
            } else if (record.tx_hash) {
                // Check if transaction receipt exists
                const receipt = await provider.getTransactionReceipt(record.tx_hash);
                if (receipt) {
                    if (receipt.status === 1) {
                        await settlementRepository.update(record.id, {
                            status: 'CONFIRMED',
                            blockNumber: receipt.blockNumber,
                            gasUsed: receipt.gasUsed,
                            reconciledAt: new Date().toISOString()
                        });
                        confirmedCount++;
                        pendingResolved++;
                    } else {
                        await settlementRepository.update(record.id, {
                            status: 'FAILED',
                            errorMessage: 'Transaction reverted on-chain',
                            reconciledAt: new Date().toISOString()
                        });
                    }
                }
            }
        } catch (err) {
            console.warn(`[RECONCILIATION] Could not check request #${record.request_id}: ${err.message}`);
        }
    }

    const currentBlock = await provider.getBlockNumber().catch(() => null);

    return {
        success: true,
        reconciledAt: new Date().toISOString(),
        blockRange: {
            fromBlock,
            toBlock,
            currentBlock
        },
        stats: {
            eventsScanned: events.length,
            confirmed: confirmedCount,
            mismatched: mismatchedCount,
            newlyCreated,
            pendingResolved
        },
        treasuryNotice: TREASURY_RECONCILIATION_NOTICE
    };
}

/**
 * Get current reconciliation status summary.
 */
async function getReconciliationSummary() {
    const summary = await settlementRepository.getSummary();
    return {
        ...summary,
        treasuryNotice: TREASURY_RECONCILIATION_NOTICE
    };
}

/**
 * Query records for reconciliation.
 */
async function getReconciliationRecords(filters = {}) {
    return await settlementRepository.list(filters);
}

module.exports = {
    runReconciliation,
    getReconciliationSummary,
    getReconciliationRecords,
    TREASURY_RECONCILIATION_NOTICE
};
