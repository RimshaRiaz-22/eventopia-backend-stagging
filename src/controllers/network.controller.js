const TerritoryLicenceInventoryService = require("../services/territoryLicenceInventory.service");
const TerritoryReservationService = require("../services/territoryReservation.service");
const TerritoryApplicationService = require("../services/territoryApplication.service");
const TerritoryLicenceService = require("../services/territoryLicence.service");

/**
 * GET /api/network/territories
 * Query: country, status (all|ACTIVE|LOCKED), search
 */
async function getTerritories(req, res) {
  try {
    const { country, status, search } = req.query;
    const territories = await TerritoryLicenceInventoryService.getTerritoriesWithAvailability({
      country: country || undefined,
      status: status || "all",
      search: search || "",
    });
    return res.json({
      error: false,
      message: "Territories retrieved successfully.",
      data: { territories, count: territories.length },
    });
  } catch (err) {
    console.error("Network getTerritories error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve territories.",
      data: null,
    });
  }
}

/**
 * GET /api/network/territory-licence/summary?territoryId=
 */
async function getTerritoryLicenceSummary(req, res) {
  try {
    const territoryId = req.query.territoryId;
    if (!territoryId) {
      return res.status(400).json({
        error: true,
        message: "territoryId is required.",
        data: null,
      });
    }
    const row = await TerritoryLicenceInventoryService.getTerritoryRow(territoryId);
    if (!row) {
      return res.status(404).json({
        error: true,
        message: "Territory not found.",
        data: null,
      });
    }
    return res.json({
      error: false,
      message: "Summary retrieved.",
      data: {
        selected_territory: {
          id: row.id,
          name: row.region_name,
          country: row.country_code,
          region_slug: row.region_slug,
        },
        licence_fee: row.licence_fee_amount,
        contract_duration: row.contract_duration_months,
        renewal_clause: row.renewal_type === "AUTO" ? "Auto-renewal" : "Manual renewal",
        important_notes: "Licence is per territory and non-transferable. Service fee starts at 20% until licence is cleared, then 15%. Service fee is calculated monthly on earned credit; it is deducted before any licence balance reduction.",
        initial_total: row.licence_fee_amount,
      },
    });
  } catch (err) {
    console.error("Network getTerritoryLicenceSummary error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve summary.",
      data: null,
    });
  }
}

/**
 * POST /api/network/territories/:territoryId/reserve
 */
async function reserveTerritory(req, res) {
  try {
    const territoryId = parseInt(req.params.territoryId, 10);
    if (isNaN(territoryId) || territoryId <= 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid territory ID.",
        data: null,
      });
    }
    const userId = req.user.id;
    const result = await TerritoryReservationService.createReservation(territoryId, userId);
    return res.status(201).json({
      error: false,
      message: "Territory reserved. Complete your application before the reservation expires.",
      data: result,
    });
  } catch (err) {
    if (err.message === "TERRITORY_NOT_FOUND") {
      return res.status(404).json({ error: true, message: "Territory not found.", data: null });
    }
    if (err.message === "TERRITORY_LOCKED") {
      return res.status(400).json({ error: true, message: "This territory is not available yet.", data: null });
    }
    if (err.message === "TERRITORY_FULL") {
      return res.status(400).json({ error: true, message: "No slots remaining. You can request access (waitlist).", data: null });
    }
    if (err.message === "ALREADY_LICENSED") {
      return res.status(400).json({ error: true, message: "You already hold an active licence for this territory.", data: null });
    }
    console.error("Network reserveTerritory error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to reserve territory.",
      data: null,
    });
  }
}

/**
 * POST /api/network/territories/:territoryId/apply (waitlist)
 * Body: application_type (WAITLIST), message optional
 */
async function applyForTerritory(req, res) {
  try {
    const territoryId = parseInt(req.params.territoryId, 10);
    if (isNaN(territoryId) || territoryId <= 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid territory ID.",
        data: null,
      });
    }
    const { application_type, message } = req.body || {};
    const type = application_type === "REQUEST_ACCESS" ? "REQUEST_ACCESS" : "WAITLIST";
    const userId = req.user.id;

    const TerritoryLicenceInventoryService = require("../services/territoryLicenceInventory.service");
    const territory = await TerritoryLicenceInventoryService.getTerritoryById(territoryId);
    if (!territory) {
      return res.status(404).json({ error: true, message: "Territory not found.", data: null });
    }

    const application = await TerritoryApplicationService.submitWaitlistApplication(
      territoryId,
      userId,
      type,
      message || null
    );
    return res.status(201).json({
      error: false,
      message: "Application submitted. You will be notified when a slot becomes available.",
      data: {
        application_id: application.id,
        territory_id: territoryId,
        status: application.status,
      },
    });
  } catch (err) {
    console.error("Network applyForTerritory error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to submit application.",
      data: null,
    });
  }
}

/**
 * POST /api/network/territory-licence/activate
 * Body: reservation_id?, territory_id?, payment_mode (PAY_NOW|CLEAR_FROM_EARNINGS), terms_accepted
 */
async function activateTerritoryLicence(req, res) {
  try {
    const { reservation_id, territory_id, payment_mode, terms_accepted } = req.body || {};
    if (!terms_accepted) {
      return res.status(400).json({
        error: true,
        message: "You must accept the terms.",
        data: null,
      });
    }
    const userId = req.user.id;
    const result = await TerritoryLicenceService.activateLicence({
      userId,
      territoryId: territory_id || null,
      reservationId: reservation_id ? parseInt(reservation_id, 10) : null,
      payment_mode: payment_mode || "PAY_NOW",
      terms_accepted: true,
    });
    return res.status(201).json({
      error: false,
      message: "Licence activated successfully.",
      data: {
        licence_id: result.licence_id,
        territory_id: result.territory_id,
        payment_required: result.payment_required,
        next_step: result.payment_required
          ? "Complete payment via POST /api/network-managers/licences/:licenceId/pay"
          : "Go to Territory Dashboard",
      },
    });
  } catch (err) {
    if (err.message === "TERMS_REQUIRED") {
      return res.status(400).json({ error: true, message: "Terms acceptance is required.", data: null });
    }
    if (err.message === "RESERVATION_INVALID") {
      return res.status(400).json({ error: true, message: "Reservation expired or invalid.", data: null });
    }
    if (err.message === "TERRITORY_NOT_FOUND") {
      return res.status(404).json({ error: true, message: "Territory not found.", data: null });
    }
    if (err.message === "NO_APPROVED_APPLICATION") {
      return res.status(400).json({
        error: true,
        message: "No approved application for this territory. Please get approved first.",
        data: null,
      });
    }
    if (err.message === "RESERVATION_OR_TERRITORY_REQUIRED") {
      return res.status(400).json({
        error: true,
        message: "Either reservation_id or territory_id is required.",
        data: null,
      });
    }
    if (err.message === "ALREADY_LICENSED") {
      return res.status(400).json({
        error: true,
        message: "You already have an active licence for this territory.",
        data: null,
      });
    }
    if (err.message === "NO_SLOTS_AVAILABLE") {
      return res.status(400).json({
        error: true,
        message: "No slots available for this territory.",
        data: null,
      });
    }
    console.error("Network activateTerritoryLicence error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to activate licence.",
      data: null,
    });
  }
}


/**
 * GET /api/network/territory-licence/me
 */
async function getMyLicences(req, res) {
  try {
    const licences = await TerritoryLicenceService.getMyLicences(req.user.id);
    return res.json({
      error: false,
      message: "Licences retrieved.",
      data: { licences },
    });
  } catch (err) {
    console.error("Network getMyLicences error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve licences.",
      data: null,
    });
  }
}

module.exports = {
  getTerritories,
  getTerritoryLicenceSummary,
  reserveTerritory,
  applyForTerritory,
  activateTerritoryLicence,
  getMyLicences,
};
