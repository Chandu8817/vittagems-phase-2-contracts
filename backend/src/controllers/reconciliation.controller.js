const reconciliationService = require('../services/reconciliation.service');

/**
 * Get summary reconciliation metrics and statuses.
 * GET /api/reconciliation/status
 */
exports.getStatus = async (req, res, next) => {
    try {
        const summary = await reconciliationService.getReconciliationSummary();
        res.json(summary);
    } catch (error) {
        next(error);
    }
};

/**
 * Query recorded settlements and reconciliation records.
 * GET /api/reconciliation/records
 */
exports.getRecords = async (req, res, next) => {
    try {
        const status = req.query.status || null;
        const requestId = req.query.requestId ? parseInt(req.query.requestId, 10) : null;
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
        const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;

        const records = await reconciliationService.getReconciliationRecords({
            status,
            requestId,
            limit,
            offset
        });

        res.json(records);
    } catch (error) {
        next(error);
    }
};

/**
 * Run reconciliation against on-chain events and mined transactions.
 * POST /api/reconciliation/reconcile
 */
exports.runReconcile = async (req, res, next) => {
    try {
        const fromBlock = req.body.fromBlock !== undefined ? parseInt(req.body.fromBlock, 10) : undefined;
        const toBlock = req.body.toBlock || 'latest';
        const requestId = req.body.requestId ? parseInt(req.body.requestId, 10) : undefined;

        const result = await reconciliationService.runReconciliation({
            fromBlock,
            toBlock,
            requestId
        });

        res.json(result);
    } catch (error) {
        next(error);
    }
};
