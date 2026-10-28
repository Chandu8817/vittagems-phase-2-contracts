const rwaService = require('../services/rwa.service');

/**
 * List RWA assets with filtering and pagination.
 * GET /api/rwa/assets
 * GET /api/assets
 */
exports.listAssets = async (req, res, next) => {
    try {
        const { page, limit, status, assetClass, owner, sort } = req.query;
        const result = await rwaService.listAssets({
            page,
            limit,
            status,
            assetClass,
            owner,
            sort
        });
        res.json(result);
    } catch (error) {
        next(error);
    }
};

/**
 * Get a specific RWA asset by numeric ID.
 * GET /api/rwa/assets/:id
 * GET /api/assets/:id
 */
exports.getAssetById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const asset = await rwaService.getAssetById(id);
        res.json({
            success: true,
            asset
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get an RWA asset by external reference (certificate number, asset code).
 * GET /api/rwa/assets/ref/:ref
 * GET /api/assets/ref/:ref
 */
exports.getAssetByRef = async (req, res, next) => {
    try {
        const { ref } = req.params;
        const asset = await rwaService.getAssetByRef(ref);
        res.json({
            success: true,
            asset
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get summary overview of RWA asset registry.
 * GET /api/rwa/summary
 * GET /api/assets/summary
 */
exports.getSummary = async (req, res, next) => {
    try {
        const summary = await rwaService.getSummary();
        res.json(summary);
    } catch (error) {
        next(error);
    }
};
