const express = require('express');
const router = express.Router();
const reconciliationController = require('../controllers/reconciliation.controller');
const { requireSettlementAuth } = require('../middleware/auth.middleware');
const { createRateLimiter } = require('../middleware/rateLimit.middleware');

const reconcileTriggerLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Reconciliation trigger limit exceeded. Please wait before triggering another run.'
});

// Read-only status and audit endpoints
router.get('/status', reconciliationController.getStatus);
router.get('/records', reconciliationController.getRecords);

// Trigger reconciliation sweep (protected)
router.post('/reconcile', reconcileTriggerLimiter, requireSettlementAuth, reconciliationController.runReconcile);

module.exports = router;
