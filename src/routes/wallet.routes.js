/**
 * Contract 24 — wallet summary (mounted at /api/v1/wallet)
 */
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { getWalletMe } = require("../controllers/walletMe.controller");
const { getWalletTransactionsHandler } = require("../controllers/walletTransactions.controller");

router.get("/me", requireAuth, getWalletMe);
router.get("/transactions", requireAuth, getWalletTransactionsHandler);

module.exports = router;
