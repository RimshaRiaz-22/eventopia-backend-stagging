/**
 * Mounted at /api/v1/credit (via v1.routes)
 */
const express = require("express");
const router = express.Router();
const { requireAuth, requireKingsAccount } = require("../middlewares/auth.middleware");
const { createWallet, getWallet } = require("../controllers/creditWallets.controller");
const { getCreditTier } = require("../controllers/creditTier.controller");

// GET /api/v1/credit/tier — Contract 23 (all authenticated roles)
router.get("/tier", requireAuth, getCreditTier);

// POST /api/v1/credit/wallets/create — internal (JWT with kings_account role)
router.post("/wallets/create", requireAuth, requireKingsAccount, createWallet);

// GET /api/v1/credit/wallets/:promoter_id — promoter dashboard (own wallet only)
router.get("/wallets/:promoter_id", requireAuth, getWallet);

module.exports = router;
