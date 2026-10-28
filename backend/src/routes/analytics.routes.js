const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analytics.controller');

router.get('/supply', analyticsController.getSupply);
router.get('/reserves', analyticsController.getReserves);
router.get('/overview', analyticsController.getOverview);
router.get('/ratio', analyticsController.getOverview);

module.exports = router;
