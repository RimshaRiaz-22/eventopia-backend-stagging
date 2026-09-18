const express = require("express");
const router = express.Router();
const { requireAuth, requireRole, requireNotPendingNetworkManager, requireNetworkManagerApplicant } = require("../middlewares/auth.middleware");
const {
  createApplication,
  getMyApplication,
  updateMyApplication,
  submitApplicationWithoutAuth,
  setupAccount,
  listGurus,
  listGuruApplications,
  approveGuruApplication,
  rejectGuruApplication,
  listAvailableNetworkManagers,
  payLicence,
} = require("../controllers/network-managers.controller");
const {
  getDashboardSummary,
  getDashboardGurus,
  getDashboardGuruPromoters,
  exportGurusCsv,
  exportPromotersCsv,
  exportCommissionsCsv,
} = require("../controllers/network-managers-dashboard.controller");
const {
  listGurus: listLicenceGurus,
  getGuruDetail,
  addNote,
  addFlag,
  createReplacementRequest,
  listReplacementRequests,
} = require("../controllers/network-manager-gurus.controller");
const { requireLicenceAccess } = require("../middlewares/licenceAccess.middleware");

// Public endpoints - no authentication required
// Must come BEFORE the requireAuth middleware
router.get("/available", listAvailableNetworkManagers);

// Special endpoint for application submission (works without full login)
// Must come BEFORE the requireAuth middleware
router.post("/applications/submit", submitApplicationWithoutAuth);

// All other routes require authentication
router.use(requireAuth);

// Account setup route - allows Network Manager applicants to setup their account
router.post("/setup-account", requireNetworkManagerApplicant, setupAccount);

// Network Manager application routes
router.post("/applications", createApplication);
router.get("/applications/me", getMyApplication);
router.patch("/applications/me", updateMyApplication);

// Licence payment (simulated) - NM or applicant who holds the licence
router.post("/licences/:licenceId/pay", requireRole("network_manager", "network_manager_applicant"), payLicence);

// Guru management routes (Network Manager only)
// Block access for users with pending Network Manager applications
router.get("/gurus", requireNotPendingNetworkManager, requireRole('network_manager'), listGurus);

// My Gurus - licence-scoped routes
router.get(
  "/licences/:licenceId/gurus",
  requireNotPendingNetworkManager,
  requireRole("network_manager"),
  requireLicenceAccess,
  listLicenceGurus
);
router.get(
  "/licences/:licenceId/gurus/:guruId",
  requireNotPendingNetworkManager,
  requireRole("network_manager"),
  requireLicenceAccess,
  getGuruDetail
);
router.post(
  "/licences/:licenceId/gurus/:guruId/notes",
  requireNotPendingNetworkManager,
  requireRole("network_manager"),
  requireLicenceAccess,
  addNote
);
router.post(
  "/licences/:licenceId/gurus/:guruId/flags",
  requireNotPendingNetworkManager,
  requireRole("network_manager"),
  requireLicenceAccess,
  addFlag
);
router.post(
  "/licences/:licenceId/gurus/:guruId/replacement-requests",
  requireNotPendingNetworkManager,
  requireRole("network_manager"),
  requireLicenceAccess,
  createReplacementRequest
);
router.get(
  "/licences/:licenceId/replacement-requests",
  requireNotPendingNetworkManager,
  requireRole("network_manager"),
  requireLicenceAccess,
  listReplacementRequests
);
router.get("/gurus/applications", requireNotPendingNetworkManager, requireRole('network_manager'), listGuruApplications);
router.post("/gurus/:applicationId/approve", requireNotPendingNetworkManager, requireRole('network_manager'), approveGuruApplication);
router.post("/gurus/:applicationId/reject", requireNotPendingNetworkManager, requireRole('network_manager'), rejectGuruApplication);

// Dashboard routes (Phase 10 – reporting, commission from ledger)
router.get("/dashboard/summary", requireNotPendingNetworkManager, requireRole('network_manager'), getDashboardSummary);
router.get("/dashboard/gurus", requireNotPendingNetworkManager, requireRole('network_manager'), getDashboardGurus);
router.get("/dashboard/gurus/:guruId/promoters", requireNotPendingNetworkManager, requireRole('network_manager'), getDashboardGuruPromoters);
router.get("/dashboard/exports/gurus.csv", requireNotPendingNetworkManager, requireRole('network_manager'), exportGurusCsv);
router.get("/dashboard/exports/promoters.csv", requireNotPendingNetworkManager, requireRole('network_manager'), exportPromotersCsv);
router.get("/dashboard/exports/commissions.csv", requireNotPendingNetworkManager, requireRole('network_manager'), exportCommissionsCsv);

module.exports = router;
