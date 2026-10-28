const settlementService = require('../services/settlement.service');

/**
 * Inspect a redemption request on-chain.
 * GET /api/settlement/redemptions/:id
 */
exports.inspectRedemption = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await settlementService.inspectRedemption(id);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

/**
 * List redemption requests on-chain.
 * GET /api/settlement/redemptions
 */
exports.listRedemptions = async (req, res, next) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
        const status = req.query.status || null;

        const result = await settlementService.listRedemptions({ limit, offset, status });
        res.json(result);
    } catch (error) {
        next(error);
    }
};

/**
 * Trigger settlement for an approved redemption request.
 * POST /api/settlement/settle
 * or POST /api/settlement/redemptions/:id/settle
 */
exports.settle = async (req, res, next) => {
    try {
        const requestId = req.params.id || req.body.requestId;
        const settlementRef = req.body.settlementRef;
        const idempotencyKey = req.body.idempotencyKey || req.headers['idempotency-key'];

        if (!requestId) {
            return res.status(400).json({
                error: {
                    code: 'MISSING_REQUEST_ID',
                    message: 'requestId is required in URL or request body.'
                }
            });
        }

        const result = await settlementService.settleRedemption({
            requestId,
            settlementRef,
            idempotencyKey
        });

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};
