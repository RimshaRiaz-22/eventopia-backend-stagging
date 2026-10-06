const express = require('express');
const router = express.Router();

const { requireAuth, requireKingsAccount } = require('../middlewares/auth.middleware');
const { getBalance } = require('../controllers/rewards.controller');
const { createRedemption } = require('../controllers/rewards.controller');
const { getRedemptions } = require('../controllers/rewards.controller');
const { approveRedemption, rejectRedemption, completeRedemption } = require('../controllers/rewards.controller');

// GET /api/rewards/balance
router.get('/balance', requireAuth, getBalance);
router.post('/redemptions', requireAuth, createRedemption);
router.get('/redemptions', requireAuth, getRedemptions);

router.post('/admin/reward-shop/requests/:id/approve', requireAuth, requireKingsAccount, approveRedemption);
router.post('/admin/reward-shop/requests/:id/reject', requireAuth, requireKingsAccount, rejectRedemption);
router.post('/admin/reward-shop/requests/:id/complete', requireAuth, requireKingsAccount, completeRedemption);

module.exports = router;
