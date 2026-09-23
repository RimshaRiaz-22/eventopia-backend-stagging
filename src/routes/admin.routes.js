const express = require("express");
const router = express.Router();
const { requireAuth, requireFounderOrAdmin, requireRole } = require("../middlewares/auth.middleware");
const {
  approvePromoterApplication,
  getEventAuditLogs,
  getEventMetrics,
  createPromoterInvite,
  activateGuru,
  updateGuruLevel,
  attachPromoterToGuru,
  detachPromoterFromGuru,
  completeEvent,
  cancelEvent,
  approveCancellationRequest,
  listPromoters,
  getPromoter,
  approvePendingEvent,
  listPendingApprovalEvents,
  listRefundRequests,
  approveRefundRequest,
  rejectRefundRequest,
  listEvents,
  getEvent,
  listCharityApplications,
  getCharityApplication,
  approveCharityApplication,
  partialApproveCharityApplication,
  rejectCharityApplication,
  executeCharityPayout,
  markCharityExecutionCompleted,
  completeCharityApplication,
  getCharityLedger,
  getCharityBalance,
  getKingsAccountOverview,
  getLedger,
  getObligations,
  getSignupFees,
  exportLedgerCsv,
  exportObligationsCsv,
  exportPotsCsv,
  exportSignupFeesCsv,
  listTerritories,
  getTerritory,
  createTerritory,
  updateTerritory,
  getReferralPool,
  approveReferralPayoutByAdmin,
} = require("../controllers/admin.controller");

const {
  listGurus,
  getGuruDetails,
  getGuruApplication,
  updateGuru,
  blockGuru,
  unblockGuru,
  deleteGuru,
  updateApplicationStatus,
} = require("../controllers/adminGuru.controller");

const {
  getHealthSummary,
  getJobRuns,
  getAuditLogs
} = require("../controllers/adminHealth.controller");

// All admin routes require authentication and founder or admin role
router.use(requireAuth);

// King's Account pending approval event review
router.get("/kings-account/events/pending-approval", requireRole("kings_account", "founder", "admin"), listPendingApprovalEvents);
router.get("/kings-account/refunds", requireRole("kings_account", "founder", "admin"), listRefundRequests);
router.post("/kings-account/refunds/:id/approve", requireRole("kings_account", "founder", "admin"), approveRefundRequest);
router.post("/kings-account/refunds/:id/reject", requireRole("kings_account", "founder", "admin"), rejectRefundRequest);
router.post("/kings-account/events/:eventId/approve", requireRole("kings_account", "founder", "admin"), approvePendingEvent);
router.post("/kings-account/events/:eventId/cancel", requireRole("kings_account", "founder", "admin"), cancelEvent);
router.post("/kings-account/events/:eventId/cancel/approve", requireRole("kings_account", "founder", "admin"), approveCancellationRequest);
// Promoter -> Promoter referral payout admin APIs (Flow 1)
router.get("/referral-pool", requireRole("kings_account", "founder", "admin"), getReferralPool);
router.post("/referrals/:id/approve-payout", requireRole("kings_account", "founder", "admin"), approveReferralPayoutByAdmin);

// Territories (King's Account / founder / admin)
router.get("/territories", requireRole("kings_account", "founder", "admin"), listTerritories);
router.get("/territories/:id", requireRole("kings_account", "founder", "admin"), getTerritory);
router.post("/territories", requireRole("kings_account", "founder", "admin"), createTerritory);
router.patch("/territories/:id", requireRole("kings_account", "founder", "admin"), updateTerritory);

// Guru module (King's Account / founder / admin)
// Add a Guru by invite: POST /auth/gurus/invites. Order matters: fixed paths before "/gurus/:guruId".
const guruAdmin = requireRole("kings_account", "founder", "admin");
router.post("/gurus/create-invite", guruAdmin, createPromoterInvite);
router.get("/gurus", guruAdmin, listGurus);
router.get("/gurus/:guruId", guruAdmin, getGuruDetails);
router.patch("/gurus/:guruId", guruAdmin, updateGuru);
router.patch("/gurus/:guruId/application-status", guruAdmin, updateApplicationStatus);
router.delete("/gurus/:guruId", guruAdmin, deleteGuru);
router.post("/gurus/:guruId/block", guruAdmin, blockGuru);
router.post("/gurus/:guruId/unblock", guruAdmin, unblockGuru);
router.post("/gurus/:guruId/level", guruAdmin, updateGuruLevel);
router.post("/gurus/:guruId/promoters/:promoterId/attach", guruAdmin, attachPromoterToGuru);
router.post("/gurus/:guruId/promoters/:promoterId/detach", guruAdmin, detachPromoterFromGuru);
router.post("/gurus/:guruId/activate", guruAdmin, activateGuru);

router.use(requireFounderOrAdmin);

// Promoter application approval
router.post("/promoters/:applicationId/approve", approvePromoterApplication);

// Event audit and metrics
router.get("/events/audit-logs", getEventAuditLogs);
router.get("/events/metrics", getEventMetrics);

// Event completion and cancellation
router.post("/events/:eventId/complete", completeEvent);
router.post("/events/:eventId/cancel", cancelEvent);

// Promoter management routes (admin only)
router.get("/promoters", listPromoters);
router.get("/promoters/:promoterId", getPromoter);

// Event management routes (admin only)
router.get("/events", listEvents);
router.get("/events/:eventId", getEvent);

// Charity management routes (admin only)
router.get("/charity/applications", listCharityApplications);
router.get("/charity/applications/:id", getCharityApplication);
router.post("/charity/applications/:id/approve", approveCharityApplication);
router.post("/charity/applications/:id/partial-approve", partialApproveCharityApplication);
router.post("/charity/applications/:id/reject", rejectCharityApplication);
router.post("/charity/applications/:id/execute", executeCharityPayout);
router.patch("/charity/executions/:id", markCharityExecutionCompleted);
router.post("/charity/applications/:id/complete", completeCharityApplication);
router.get("/charity/ledger", getCharityLedger);
router.get("/charity/balance", getCharityBalance);

// Health monitoring routes
router.get("/health/summary", getHealthSummary);
router.get("/health/jobs", getJobRuns);
router.get("/audit", getAuditLogs);

// King's Account (Phase 10)
router.get("/kings-account/overview", getKingsAccountOverview);
router.get("/ledger", getLedger);
router.get("/obligations", getObligations);
router.get("/signup-fees", getSignupFees);
router.get("/exports/ledger.csv", exportLedgerCsv);
router.get("/exports/obligations.csv", exportObligationsCsv);
router.get("/exports/pots.csv", exportPotsCsv);
router.get("/exports/signup-fees.csv", exportSignupFeesCsv);

module.exports = router;
