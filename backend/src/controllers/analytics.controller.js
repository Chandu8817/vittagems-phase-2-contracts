const analyticsService = require('../services/analytics.service');

/**
 * Get VGUSD supply analytics.
 * GET /api/analytics/supply
 */
exports.getSupply = async (req, res, next) => {
    try {
        const supply = await analyticsService.getSupplyAnalytics();
        res.json(supply);
    } catch (error) {
        next(error);
    }
};

/**
 * Get reserve valuation and pool analytics.
 * GET /api/analytics/reserves
 */
exports.getReserves = async (req, res, next) => {
    try {
        const reserves = await analyticsService.getReserveAnalytics();
        res.json(reserves);
    } catch (error) {
        next(error);
    }
};

/**
 * Get combined supply, reserve, and collateral ratio overview.
 * GET /api/analytics/overview
 */
exports.getOverview = async (req, res, next) => {
    try {
        const overview = await analyticsService.getOverviewAnalytics();
        res.json(overview);
    } catch (error) {
        next(error);
    }
};
