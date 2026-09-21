const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middlewares/auth.middleware");
const { requireGuru, requireActiveGuru, requirePromoterOwnership } = require("../middlewares/guru.middleware");
const {
  createApplication,
  getMyApplication,
  updateMyApplication,
  commitActivationFee,
  getMyProfile,
  setupAccount,
  listPromoterApplications,
  approvePromoterApplication,
  activatePendingPromoter,
  rejectPromoterApplication,
  getDashboardSummary,
  getReferralInfo,
  getInvitePromotersReferralLink,
  getReferralStats,
  getAttachedPromoters,
  getGuruReferralSignupsPromoters,
  getPromoterPerformance,
  getPromoterDetails,
  getPromoterCharts,
  getPromoterStats,
  getPromoterHistory,
  exportPromotersCsv,
  exportPerformanceCsv,
  getMyRewards,
  listAvailableGurus,
} = require("../controllers/gurus.controller");
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
const { getLicenseInfo, getLicenseBalance } = require("../controllers/guruLicense.controller");
const { validateInvite } = require("../controllers/inviteValidation.controller");

// Public endpoint - no authentication required
router.get("/available", listAvailableGurus);

// PUBLIC: Invite validation
router.get("/invites/validate/:inviteToken", validateInvite);

router.use(requireAuth);

router.put("/setup-account", setupAccount);

router.post("/applications", createApplication);
router.get("/applications/me", getMyApplication);
router.patch("/applications/me", updateMyApplication);
router.post("/activation-fee/commit", commitActivationFee);

router.get("/me", getMyProfile);

// Promoter management routes (Guru only)
router.get("/promoters/invite/referral-link", requireGuru, getInvitePromotersReferralLink);
router.post("/promoters/invite/referral-link", requireGuru, getInvitePromotersReferralLink);
router.get("/promoters/applications", requireRole('guru'), listPromoterApplications);
router.post("/promoters/:applicationId/approve", requireRole('guru'), approvePromoterApplication);
router.post("/dashboard/promoters/:promoterId/activate", requireRole('guru'), activatePendingPromoter);
router.post("/promoters/:applicationId/reject", requireRole('guru'), rejectPromoterApplication);

// Dashboard routes (require active Guru)
router.get("/dashboard/summary", requireGuru, getDashboardSummary);
router.get("/dashboard/referral", requireGuru, getReferralInfo);
router.get("/dashboard/promoters", requireGuru, getAttachedPromoters);
router.get("/dashboard/promoters/referral-signups", requireGuru, getGuruReferralSignupsPromoters);
router.get(
  "/dashboard/promoters/:promoterId/details",
  requireGuru,
  requirePromoterOwnership,
  getPromoterDetails
);
router.get(
  "/dashboard/promoters/:promoterId/charts",
  requireGuru,
  requirePromoterOwnership,
  getPromoterCharts
);
router.get(
  "/dashboard/promoters/:promoterId/stats",
  requireGuru,
  requirePromoterOwnership,
  getPromoterStats
);
router.get(
  "/dashboard/promoters/:promoterId/history",
  requireGuru,
  requirePromoterOwnership,
  getPromoterHistory
);
router.get("/dashboard/promoters/:promoterId", requireGuru, requirePromoterOwnership, getPromoterPerformance);

// Referral stats
router.get("/referral/stats", requireGuru, getReferralStats);

// Export routes
router.get("/exports/promoters.csv", requireGuru, exportPromotersCsv);
router.get("/exports/performance.csv", requireGuru, exportPerformanceCsv);

// Get my rewards
router.get("/rewards", requireGuru, getMyRewards);

/* ========== NEW: Marketing Hub & Onboarding Routes ========== */

// License information
router.get("/license/info", getLicenseInfo);
router.get("/license/balance", getLicenseBalance);

// Marketing Hub
router.get("/marketing-hub", requireRole('guru'), getMarketingHub);

// Onboarding
router.get("/onboarding/checklist", getOnboardingChecklist);

// Content submissions
router.post("/marketing-hub/submissions", requireRole('guru'), submitContent);
router.get("/marketing-hub/submissions", requireRole('guru'), getMySubmissions);

// Campaign requests
router.post("/marketing-hub/campaign-requests", requireRole('guru'), requestCampaign);
router.get("/marketing-hub/campaign-requests", requireRole('guru'), getMyCampaignRequests);

// Leaderboard
router.get("/leaderboard", requireRole('guru'), getLeaderboard);

// Level information
router.get("/levels/info", getLevelInfo);

// Sprint mode (Level 2+)
router.get("/sprint-mode", requireRole('guru'), getSprintMode);

module.exports = router;
