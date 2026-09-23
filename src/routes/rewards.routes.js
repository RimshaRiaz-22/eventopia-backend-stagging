const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middlewares/auth.middleware');
const { getBalance } = require('../controllers/rewards.controller');
const { createRedemption } = require('../controllers/rewards.controller');
const { getRedemptions } = require('../controllers/rewards.controller');
const { approveRedemption, rejectRedemption, completeRedemption } = require('../controllers/rewards.controller');

// GET /api/rewards/balance
router.get('/balance', requireAuth, getBalance);
router.post('/redemptions', requireAuth, createRedemption);
router.get('/redemptions', requireAuth, getRedemptions);

router.post('/admin/reward-shop/requests/:id/approve', requireAuth, approveRedemption);
router.post('/admin/reward-shop/requests/:id/reject', requireAuth, rejectRedemption);
router.post('/admin/reward-shop/requests/:id/complete', requireAuth, completeRedemption);

module.exports = router;
