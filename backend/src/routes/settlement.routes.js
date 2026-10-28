const express = require('express');
const router = express.Router();
const settlementController = require('../controllers/settlement.controller');
const { requireSettlementAuth } = require('../middleware/auth.middleware');
const { createRateLimiter } = require('../middleware/rateLimit.middleware');

// Write limiter for settlement submission (30 requests per minute)
const settlementWriteLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Settlement request limit exceeded. Please wait before submitting more settlement transactions.'
});

// Read-only inspection endpoints
router.get('/redemptions', settlementController.listRedemptions);
router.get('/redemptions/:id', settlementController.inspectRedemption);

// Protected settlement execution endpoints
router.post('/settle', settlementWriteLimiter, requireSettlementAuth, settlementController.settle);
router.post('/redemptions/:id/settle', settlementWriteLimiter, requireSettlementAuth, settlementController.settle);

module.exports = router;
