const express = require("express");
const router = express.Router();
const { requireAuth, requireFounderOrAdmin, requireRole } = require("../middlewares/auth.middleware");
const {
  approveGuruApplication,
  approveNetworkManagerApplication,
  rejectNetworkManagerApplication,
  approvePromoterApplication,
  getEventAuditLogs,
  getEventMetrics,
  createGuruInvite,
  listGurus,
  getGuruDetails,
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
  getTerritoryLicences,
  listTerritoryApplications,
  approveTerritoryApplication,
  rejectTerritoryApplication,
  updateTerritory,
  suspendTerritoryLicence,
  getReferralPool,
  approveReferralPayoutByAdmin,
} = require("../controllers/admin.controller");

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

// Territory licence inventory (King's Account / founder / admin)
router.get("/territories", requireRole("kings_account", "founder", "admin"), listTerritories);
router.get("/territories/:id/licences", requireRole("kings_account", "founder", "admin"), getTerritoryLicences);
router.get("/territories/:id", requireRole("kings_account", "founder", "admin"), getTerritory);
router.post("/territories", requireRole("kings_account", "founder", "admin"), createTerritory);
router.patch("/territories/:id", requireRole("kings_account", "founder", "admin"), updateTerritory);

// Territory applications (waitlist) (King's Account / founder / admin)
router.get("/territory-applications", requireRole("kings_account", "founder", "admin"), listTerritoryApplications);
router.post("/territory-applications/:id/approve", requireRole("kings_account", "founder", "admin"), approveTerritoryApplication);
router.post("/territory-applications/:id/reject", requireRole("kings_account", "founder", "admin"), rejectTerritoryApplication);

// Territory licences (King's Account / founder / admin)
router.post("/territory-licences/:id/suspend", requireRole("kings_account", "founder", "admin"), suspendTerritoryLicence);

// Network Manager approval / reject (King's Account / founder)
router.post(
  "/network-managers/:applicationId/approve",
  requireRole("kings_account", "founder"),
  approveNetworkManagerApplication
);
router.post(
  "/network-managers/:applicationId/reject",
  requireRole("kings_account", "founder"),
  rejectNetworkManagerApplication
);

router.use(requireFounderOrAdmin);

// Guru application approval
router.post("/gurus/:applicationId/approve", approveGuruApplication);

// Promoter application approval
router.post("/promoters/:applicationId/approve", approvePromoterApplication);

// Event audit and metrics
router.get("/events/audit-logs", getEventAuditLogs);
router.get("/events/metrics", getEventMetrics);

// Event completion and cancellation
router.post("/events/:eventId/complete", completeEvent);
router.post("/events/:eventId/cancel", cancelEvent);

// Guru management routes (admin only)
router.get("/gurus", listGurus);
router.get("/gurus/:guruId", getGuruDetails);
router.post("/gurus/create-invite", createGuruInvite);
router.post("/gurus/:guruId/activate", activateGuru);
router.post("/gurus/:guruId/level", updateGuruLevel);
router.post("/gurus/:guruId/promoters/:promoterId/attach", attachPromoterToGuru);
router.post("/gurus/:guruId/promoters/:promoterId/detach", detachPromoterFromGuru);

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
