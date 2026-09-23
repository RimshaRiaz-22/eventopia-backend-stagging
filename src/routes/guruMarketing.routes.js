const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middlewares/auth.middleware");
const { validateInvite } = require("../controllers/inviteValidation.controller");
const { getLicenseInfo } = require("../controllers/guruLicense.controller");
const {
  getMarketingHub,
  getOnboardingChecklist,
  submitContent,
  getMySubmissions,
  requestCampaign,
  getMyCampaignRequests,
  getLeaderboard,
  getLevelInfo,
  getSprintMode
} = require("../controllers/guruMarketingHub.controller");

/* ========== PUBLIC ENDPOINTS ========== */

// Invite validation (no auth required - accessed from invite link)
router.get("/invites/validate/:inviteToken", validateInvite);

/* ========== PROTECTED GURU ENDPOINTS ========== */

router.use(requireAuth);
router.use(requireRole('guru'));

// License information
router.get("/license/info", getLicenseInfo);

// Marketing Hub
router.get("/marketing-hub", getMarketingHub);

// Onboarding
router.get("/onboarding/checklist", getOnboardingChecklist);

// Content submissions
router.post("/marketing-hub/submissions", submitContent);
router.get("/marketing-hub/submissions", getMySubmissions);

// Campaign requests
router.post("/marketing-hub/campaign-requests", requestCampaign);
router.get("/marketing-hub/campaign-requests", getMyCampaignRequests);

// Leaderboard
router.get("/leaderboard", getLeaderboard);

// Level information
router.get("/levels/info", getLevelInfo);

// Sprint mode (Level 2+)
router.get("/sprint-mode", getSprintMode);

module.exports = router;
