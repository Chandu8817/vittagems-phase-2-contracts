const config = require('../config/config');

/**
 * Middleware to require authentication for settlement write operations.
 */
function requireSettlementAuth(req, res, next) {
    if (!config.SETTLEMENT_API_KEY) {
        return res.status(503).json({
            error: {
                code: 'SETTLEMENT_DISABLED',
                message: 'SETTLEMENT_API_KEY is not configured on the server. Settlement write operations are disabled.'
            }
        });
    }

    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['x-api-key'];

    let providedKey = null;

    if (apiKeyHeader) {
        providedKey = apiKeyHeader;
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
        providedKey = authHeader.substring(7).trim();
    }

    if (!providedKey) {
        return res.status(401).json({
            error: {
                code: 'UNAUTHORIZED',
                message: 'Authentication required. Provide a valid API key via "x-api-key" or "Authorization: Bearer <key>".'
            }
        });
    }

    if (providedKey !== config.SETTLEMENT_API_KEY) {
        return res.status(403).json({
            error: {
                code: 'FORBIDDEN',
                message: 'Invalid API key.'
            }
        });
    }

    next();
}

module.exports = {
    requireSettlementAuth
};
