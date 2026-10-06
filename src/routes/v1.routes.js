/**
 * API v1 namespace. Mounted at /v1
 */

const express = require("express");
const router = express.Router();
const ledgerRoutes = require("./ledger.routes");
const settingsRoutes = require("./settings.routes");
const authRoutes = require("./auth.routes");
const creditRoutes = require("./credit.routes");
const walletRoutes = require("./wallet.routes");

// Mount all v1 routes
router.use("/auth", authRoutes); // This mounts all auth routes at /v1/auth
router.use("/ledger", ledgerRoutes);
router.use("/credit", creditRoutes);
router.use("/wallet", walletRoutes);
router.use(settingsRoutes); // Mount settings routes directly at /v1 level

module.exports = router;
