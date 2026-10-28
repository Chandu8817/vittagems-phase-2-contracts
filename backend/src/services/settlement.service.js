const { ethers } = require('ethers');
const crypto = require('crypto');
const config = require('../config/config');
const { provider, wallet, contracts, SETTLER_ROLE } = require('./blockchain.service');
const settlementRepository = require('../db/settlementRepository');

const REDEMPTION_STATUS = ['None', 'Pending', 'Approved', 'Settled', 'Rejected', 'Cancelled'];

/**
 * Format and validate settlement reference into a bytes32 hex string.
 * @param {string} ref Optional user-provided reference
 * @param {number} requestId Redemption request ID
 * @returns {string} bytes32 hex string (0x + 64 hex characters)
 */
function formatSettlementRef(ref, requestId) {
    if (!ref) {
        // Generate a cryptographically unique settlement reference
        const randomEntropy = crypto.randomBytes(8).toString('hex');
        return ethers.id(`SETTLEMENT-${requestId}-${Date.now()}-${randomEntropy}`);
    }

    const trimmed = String(ref).trim();

    // Check sensible length limit
    if (trimmed.length > 128) {
        const err = new Error('Settlement reference exceeds maximum allowed length of 128 characters.');
        err.statusCode = 400;
        err.code = 'INVALID_SETTLEMENT_REF';
        throw err;
    }

    // If it's already a valid 32-byte hex string (0x + 64 chars)
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
        return trimmed.toLowerCase();
    }

    // Otherwise, hash the provided reference to produce a deterministic bytes32
    return ethers.id(trimmed);
}

/**
 * Check on-chain eligibility of a redemption request for settlement.
 * @param {number} requestId
 */
async function checkEligibility(requestId) {
    const id = parseInt(requestId, 10);
    if (!Number.isInteger(id) || id <= 0) {
        const err = new Error(`Invalid requestId: "${requestId}". Must be a positive integer.`);
        err.statusCode = 400;
        err.code = 'INVALID_REQUEST_ID';
        throw err;
    }

    const rm = contracts.redemptionModule();
    if (!rm) {
        const err = new Error('RedemptionModule contract is not configured or not deployed.');
        err.statusCode = 503;
        err.code = 'CONTRACT_NOT_AVAILABLE';
        throw err;
    }

    const redemption = await rm.getRedemption(id);
    const statusCode = Number(redemption.status);
    const statusLabel = REDEMPTION_STATUS[statusCode] || 'Unknown';

    // Status 0 = None (does not exist)
    if (statusCode === 0) {
        return {
            exists: false,
            eligible: false,
            statusCode: 404,
            status: statusLabel,
            reason: `Redemption request #${id} does not exist.`
        };
    }

    // Status 1 = Pending (needs DAO approval first)
    if (statusCode === 1) {
        return {
            exists: true,
            eligible: false,
            statusCode: 400,
            status: statusLabel,
            reason: `Redemption request #${id} is currently in Pending status and requires DAO approval before settlement.`,
            redemption: serializeRedemption(id, redemption)
        };
    }

    // Status 3 = Settled
    if (statusCode === 3) {
        return {
            exists: true,
            eligible: false,
            statusCode: 400,
            status: statusLabel,
            reason: `Redemption request #${id} has already been settled on-chain.`,
            redemption: serializeRedemption(id, redemption)
        };
    }

    // Status 4 = Rejected
    if (statusCode === 4) {
        return {
            exists: true,
            eligible: false,
            statusCode: 400,
            status: statusLabel,
            reason: `Redemption request #${id} was rejected by the DAO.`,
            redemption: serializeRedemption(id, redemption)
        };
    }

    // Status 5 = Cancelled
    if (statusCode === 5) {
        return {
            exists: true,
            eligible: false,
            statusCode: 400,
            status: statusLabel,
            reason: `Redemption request #${id} was cancelled by the redeemer.`,
            redemption: serializeRedemption(id, redemption)
        };
    }

    // At this point, statusCode must be 2 (Approved)
    // Check pause states
    const vs = contracts.vittaStablecoin();
    const [isRmPaused, isVsPaused] = await Promise.all([
        rm.paused().catch(() => false),
        vs ? vs.paused().catch(() => false) : false
    ]);

    if (isRmPaused) {
        return {
            exists: true,
            eligible: false,
            statusCode: 400,
            status: statusLabel,
            reason: 'RedemptionModule contract is currently paused.',
            redemption: serializeRedemption(id, redemption)
        };
    }

    if (isVsPaused) {
        return {
            exists: true,
            eligible: false,
            statusCode: 400,
            status: statusLabel,
            reason: 'VittaStablecoin contract is currently paused.',
            redemption: serializeRedemption(id, redemption)
        };
    }

    // Verify settlement signer configuration and role
    if (!wallet) {
        return {
            exists: true,
            eligible: false,
            statusCode: 503,
            status: statusLabel,
            reason: 'Settlement signer wallet is not configured on this server.',
            redemption: serializeRedemption(id, redemption)
        };
    }

    const hasRole = await rm.hasRole(SETTLER_ROLE, wallet.address).catch(() => false);
    if (!hasRole) {
        return {
            exists: true,
            eligible: false,
            statusCode: 503,
            status: statusLabel,
            reason: `Configured settlement signer (${wallet.address}) does not hold SETTLER_ROLE on RedemptionModule.`,
            redemption: serializeRedemption(id, redemption)
        };
    }

    return {
        exists: true,
        eligible: true,
        status: statusLabel,
        redemption: serializeRedemption(id, redemption)
    };
}

/**
 * Serialize on-chain redemption struct into a clean, BigInt-safe JSON object.
 */
function serializeRedemption(id, r) {
    const statusCode = Number(r.status);
    return {
        id: Number(id),
        redeemer: r.redeemer,
        amount: {
            raw: r.amount.toString(),
            formatted: ethers.formatEther(r.amount)
        },
        usdcAmount: {
            raw: r.usdcAmount.toString(),
            formatted: ethers.formatUnits(r.usdcAmount, 6)
        },
        priceUsed: {
            raw: r.priceUsed.toString(),
            formatted: ethers.formatEther(r.priceUsed)
        },
        createdAt: Number(r.createdAt),
        createdAtIso: r.createdAt > 0n ? new Date(Number(r.createdAt) * 1000).toISOString() : null,
        approvedAt: Number(r.approvedAt),
        approvedAtIso: r.approvedAt > 0n ? new Date(Number(r.approvedAt) * 1000).toISOString() : null,
        status: REDEMPTION_STATUS[statusCode] || 'Unknown',
        statusCode
    };
}

/**
 * Settle an approved redemption request.
 * Fully idempotent: prevents duplicate submissions and double-spend.
 */
async function settleRedemption({ requestId, settlementRef, idempotencyKey }) {
    const id = parseInt(requestId, 10);
    if (!Number.isInteger(id) || id <= 0) {
        const err = new Error(`Invalid requestId: "${requestId}". Must be a positive integer.`);
        err.statusCode = 400;
        err.code = 'INVALID_REQUEST_ID';
        throw err;
    }

    // 1. Idempotency Check in DB
    const existing = await settlementRepository.findExisting({
        requestId: id,
        idempotencyKey,
        settlementRef: settlementRef ? formatSettlementRef(settlementRef, id) : undefined
    });

    if (existing) {
        // If already confirmed, return the existing confirmed result
        if (existing.status === 'CONFIRMED') {
            return {
                idempotent: true,
                status: 'CONFIRMED',
                requestId: id,
                settlementRef: existing.settlement_ref,
                txHash: existing.tx_hash,
                blockNumber: existing.block_number,
                chainId: existing.chain_id,
                redeemer: existing.redeemer,
                amountBurned: {
                    raw: existing.amount_burned,
                    formatted: existing.amount_burned ? ethers.formatEther(existing.amount_burned) : null
                },
                usdcPaid: {
                    raw: existing.usdc_paid,
                    formatted: existing.usdc_paid ? ethers.formatUnits(existing.usdc_paid, 6) : null
                },
                confirmedAt: existing.reconciled_at || existing.updated_at
            };
        }

        // If currently in progress (SUBMITTING or PENDING), check if tx has already been mined on chain
        if (existing.status === 'SUBMITTING' || existing.status === 'PENDING') {
            if (existing.tx_hash && provider) {
                try {
                    const receipt = await provider.getTransactionReceipt(existing.tx_hash);
                    if (receipt && receipt.status === 1) {
                        await settlementRepository.update(existing.id, {
                            status: 'CONFIRMED',
                            blockNumber: receipt.blockNumber,
                            gasUsed: receipt.gasUsed,
                            reconciledAt: new Date().toISOString()
                        });
                        return {
                            idempotent: true,
                            status: 'CONFIRMED',
                            requestId: id,
                            settlementRef: existing.settlement_ref,
                            txHash: existing.tx_hash,
                            blockNumber: receipt.blockNumber,
                            chainId: existing.chain_id
                        };
                    } else if (receipt && receipt.status === 0) {
                        await settlementRepository.update(existing.id, {
                            status: 'FAILED',
                            errorMessage: 'Transaction reverted on-chain'
                        });
                    }
                } catch {
                    // Ignore provider error during check
                }
            }

            const conflictErr = new Error(`Settlement for request #${id} is currently in progress (status: ${existing.status}). Transaction hash: ${existing.tx_hash || 'pending'}. Please wait for confirmation.`);
            conflictErr.statusCode = 409;
            conflictErr.code = 'SETTLEMENT_IN_PROGRESS';
            conflictErr.details = {
                status: existing.status,
                txHash: existing.tx_hash,
                settlementRef: existing.settlement_ref
            };
            throw conflictErr;
        }
    }

    // 2. Format / validate the settlement reference
    const formattedRef = formatSettlementRef(settlementRef, id);

    // 3. Pre-flight on-chain eligibility check
    const eligibility = await checkEligibility(id);
    if (!eligibility.eligible) {
        const err = new Error(eligibility.reason || 'Redemption request is not eligible for settlement.');
        err.statusCode = eligibility.statusCode || 400;
        err.code = 'NOT_ELIGIBLE';
        err.details = eligibility;
        throw err;
    }

    const r = eligibility.redemption;

    // 4. Create initial DB record in SUBMITTING status
    let record = await settlementRepository.create({
        requestId: id,
        settlementRef: formattedRef,
        idempotencyKey,
        status: 'SUBMITTING',
        redeemer: r.redeemer,
        amountBurned: r.amount.raw,
        usdcPaid: r.usdcAmount.raw,
        priceUsed: r.priceUsed.raw,
        onChainStatus: 'Approved'
    });

    const rmWithSigner = contracts.redemptionModule(true);
    if (!rmWithSigner) {
        await settlementRepository.update(record.id, {
            status: 'FAILED',
            errorMessage: 'Settlement contract runner unavailable.'
        });
        const err = new Error('Settlement contract runner is unavailable.');
        err.statusCode = 503;
        err.code = 'SIGNER_UNAVAILABLE';
        throw err;
    }

    // 5. Submit transaction on-chain
    let tx;
    try {
        tx = await rmWithSigner.settle(id, formattedRef);
    } catch (err) {
        await settlementRepository.update(record.id, {
            status: 'FAILED',
            errorMessage: err.message
        });
        const submitErr = new Error(`Failed to submit settlement transaction: ${err.message}`);
        submitErr.statusCode = 500;
        submitErr.code = 'TRANSACTION_SUBMISSION_FAILED';
        submitErr.details = { originalError: err.message };
        throw submitErr;
    }

    // 6. Record pending transaction hash
    let networkChainId = config.CHAIN_ID;
    try {
        const net = await provider.getNetwork();
        networkChainId = Number(net.chainId);
    } catch {
        // ignore
    }

    record = await settlementRepository.update(record.id, {
        status: 'PENDING',
        txHash: tx.hash,
        chainId: networkChainId
    });

    // 7. Wait for transaction receipt
    let receipt;
    try {
        receipt = await tx.wait(config.CONFIRMATIONS);
    } catch (err) {
        await settlementRepository.update(record.id, {
            status: 'FAILED',
            errorMessage: `Transaction failed during confirmation: ${err.message}`
        });
        const waitErr = new Error(`Settlement transaction reverted or dropped: ${err.message}`);
        waitErr.statusCode = 500;
        waitErr.code = 'TRANSACTION_EXECUTION_FAILED';
        throw waitErr;
    }

    if (!receipt || receipt.status !== 1) {
        await settlementRepository.update(record.id, {
            status: 'FAILED',
            blockNumber: receipt ? receipt.blockNumber : null,
            gasUsed: receipt ? receipt.gasUsed : null,
            errorMessage: 'Transaction reverted on-chain (status 0).'
        });
        const revertErr = new Error('Settlement transaction reverted on-chain.');
        revertErr.statusCode = 500;
        revertErr.code = 'TRANSACTION_REVERTED';
        throw revertErr;
    }

    // 8. Confirm settlement in DB
    const nowIso = new Date().toISOString();
    record = await settlementRepository.update(record.id, {
        status: 'CONFIRMED',
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        onChainStatus: 'Settled',
        reconciledAt: nowIso
    });

    return {
        success: true,
        status: 'CONFIRMED',
        requestId: id,
        settlementRef: formattedRef,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        chainId: networkChainId,
        redeemer: r.redeemer,
        amountBurned: r.amount,
        usdcPaid: r.usdcAmount,
        priceUsed: r.priceUsed,
        confirmedAt: nowIso
    };
}

/**
 * Inspect a redemption request on-chain and return eligibility status.
 */
async function inspectRedemption(requestId) {
    const eligibility = await checkEligibility(requestId);
    const existingSettlement = await settlementRepository.findByRequestId(requestId);

    return {
        ...eligibility,
        settlementRecord: existingSettlement ? {
            id: existingSettlement.id,
            status: existingSettlement.status,
            txHash: existingSettlement.tx_hash,
            settlementRef: existingSettlement.settlement_ref,
            reconciledAt: existingSettlement.reconciled_at
        } : null
    };
}

/**
 * List redemption requests on-chain (paginated).
 */
async function listRedemptions({ limit = 20, offset = 0, status } = {}) {
    const rm = contracts.redemptionModule();
    if (!rm) {
        const err = new Error('RedemptionModule contract is not available.');
        err.statusCode = 503;
        throw err;
    }

    let nextId = 1;
    try {
        nextId = Number(await rm.nextRedemptionId());
    } catch {
        nextId = 1;
    }

    const total = Math.max(0, nextId - 1);
    const results = [];

    // Scan backwards from newest request
    const startId = total - offset;
    const endId = Math.max(1, startId - limit + 1);

    for (let id = startId; id >= endId; id--) {
        try {
            const r = await rm.getRedemption(id);
            const serialized = serializeRedemption(id, r);
            if (!status || serialized.status.toLowerCase() === status.toLowerCase()) {
                results.push(serialized);
            }
        } catch {
            // Ignore individual fetch failure
        }
    }

    return {
        total,
        limit,
        offset,
        redemptions: results
    };
}

module.exports = {
    checkEligibility,
    settleRedemption,
    inspectRedemption,
    listRedemptions,
    formatSettlementRef,
    serializeRedemption,
    REDEMPTION_STATUS
};
