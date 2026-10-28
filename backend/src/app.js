const express = require('express');
const getCorsMiddleware = require('./middleware/cors.middleware');
const { createRateLimiter } = require('./middleware/rateLimit.middleware');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler.middleware');
const { verifyConnectivity } = require('./services/blockchain.service');
const { getSanitizedConfig } = require('./config/config');

const contractRoutes = require('./routes/contract.routes');
const settlementRoutes = require('./routes/settlement.routes');
const reconciliationRoutes = require('./routes/reconciliation.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const rwaRoutes = require('./routes/rwa.routes');

const app = express();

// Security & Parsing Middleware
app.use(getCorsMiddleware());
app.use(express.json());

// Global Rate Limiter: 300 requests per minute per IP
app.use(createRateLimiter({
    windowMs: 60 * 1000,
    max: 300,
    message: 'Global rate limit exceeded.'
}));

// Health Check Endpoint (backward compatible + enriched diagnostic info)
app.get('/health', async (req, res) => {
    let blockchainStatus = { connected: false };
    try {
        blockchainStatus = await verifyConnectivity();
    } catch (err) {
        blockchainStatus = { connected: false, error: err.message };
    }

    const isHealthy = blockchainStatus.connected;

    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'OK' : 'DEGRADED',
        timestamp: new Date().toISOString(),
        blockchain: blockchainStatus,
        config: getSanitizedConfig()
    });
});

// Mount Routes
app.use('/api/contracts', contractRoutes);
app.use('/api/settlement', settlementRoutes);
app.use('/api/reconciliation', reconciliationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/rwa', rwaRoutes);
app.use('/api/assets', rwaRoutes);

// 404 and Centralized Error Handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
