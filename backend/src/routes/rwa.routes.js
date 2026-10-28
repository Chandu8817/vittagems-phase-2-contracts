const express = require('express');
const router = express.Router();
const rwaController = require('../controllers/rwa.controller');

// Overview / metrics
router.get('/summary', rwaController.getSummary);

// Reference lookup
router.get('/assets/ref/:ref', rwaController.getAssetByRef);
router.get('/ref/:ref', rwaController.getAssetByRef);

// Asset listings
router.get('/assets', rwaController.listAssets);

// Specific asset by ID
router.get('/assets/:id', rwaController.getAssetById);
router.get('/:id', rwaController.getAssetById);

// Root path lists assets
router.get('/', rwaController.listAssets);

module.exports = router;
