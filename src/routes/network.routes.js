const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middlewares/auth.middleware");
const {
  getTerritories,
  getTerritoryLicenceSummary,
  reserveTerritory,
  applyForTerritory,
  activateTerritoryLicence,
  getMyLicences,
} = require("../controllers/network.controller");

router.use(requireAuth);

router.get("/territories", getTerritories);
router.post("/territories/:territoryId/reserve", reserveTerritory);
router.post("/territories/:territoryId/apply", applyForTerritory);
router.get("/territory-licence/summary", getTerritoryLicenceSummary);
router.post("/territory-licence/activate", requireRole("network_manager", "network_manager_applicant"), activateTerritoryLicence);
router.get("/territory-licence/me", requireRole("network_manager", "network_manager_applicant"), getMyLicences);

module.exports = router;
