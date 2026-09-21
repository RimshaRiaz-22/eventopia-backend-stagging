const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { getMyRewards } = require("../controllers/promoter.controller");

// All promoter routes require authentication
router.use(requireAuth);

// Get my rewards
router.get("/rewards", getMyRewards);

module.exports = router;
