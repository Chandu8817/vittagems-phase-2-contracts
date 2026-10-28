const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contract.controller');

router.get('/info', contractController.getContractInfo);
router.get('/reserves', contractController.getReserveValue);

module.exports = router;
