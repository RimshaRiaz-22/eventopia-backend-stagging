const express = require("express");
const router = express.Router();
const { requireAuth, requireFounderOrAdmin, requireRole } = require("../middlewares/auth.middleware");
const {
  approvePromoterApplication,
  getEventAuditLogs,
  getEventMetrics,
  completeEvent,
  cancelEvent,
  approveCancellationRequest,
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
  listPromoters,
  getPromoterDetails,
  updatePromoter,
  blockPromoter,
  unblockPromoter,
  deletePromoter,
  updateApplicationStatus,
} = require("../controllers/adminPromoter.controller");

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

// Promoter module (King's Account / founder / admin)
// Invite a Promoter by email: POST /auth/promoters/invites (accepted invites need no approval).
// Self-registered Promoters wait for approval: PATCH /admin/promoters/:promoterId/application-status
const promoterAdmin = requireRole("kings_account", "founder", "admin");
router.get("/promoters", promoterAdmin, listPromoters);
router.get("/promoters/:promoterId", promoterAdmin, getPromoterDetails);
router.patch("/promoters/:promoterId", promoterAdmin, updatePromoter);
router.patch("/promoters/:promoterId/application-status", promoterAdmin, updateApplicationStatus);
router.post("/promoters/:promoterId/block", promoterAdmin, blockPromoter);
router.post("/promoters/:promoterId/unblock", promoterAdmin, unblockPromoter);
router.delete("/promoters/:promoterId", promoterAdmin, deletePromoter);
router.post("/promoters/:applicationId/approve", promoterAdmin, approvePromoterApplication);

router.use(requireFounderOrAdmin);

// Event audit and metrics
router.get("/events/audit-logs", getEventAuditLogs);
router.get("/events/metrics", getEventMetrics);

// Event completion and cancellation
router.post("/events/:eventId/complete", completeEvent);
router.post("/events/:eventId/cancel", cancelEvent);

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
