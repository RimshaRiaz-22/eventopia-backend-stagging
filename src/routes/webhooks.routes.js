const express = require("express");
const router = express.Router();
const { handlePaymentWebhook, handleCharityPaymentWebhook } = require("../controllers/webhooks.controller");

/**
 * Webhook Routes
 * Base path: /api/webhooks
 * No authentication required - signature verification is done in controller
 */

// Payment provider webhooks
router.post("/payment", handlePaymentWebhook);

// Charity payment webhooks
router.post("/charity-payment", handleCharityPaymentWebhook);

module.exports = router;