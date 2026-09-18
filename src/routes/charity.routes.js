/**
 * Charity route definitions.
 * Applies authentication and promoter role checks before charity endpoints.
 */

const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middlewares/auth.middleware");
const { requirePromoter } = require("../middlewares/auth.middleware");

const {
  createApplication,
  listMyApplications,
  getApplication,
  updateApplication,
  submitApplication,
  payApplicationFee,
  getApplicationStatus,
  getExecutions
} = require("../controllers/charity.controller");

// Charity routes require an authenticated promoter.
router.use(requireAuth);
router.use(requirePromoter);

module.exports = router;