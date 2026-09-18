const express = require("express");
const router = express.Router();
const {
  getEventsList,
  getEventDetail,
  getEventByShareToken,
} = require("../controllers/events.controller");

/**
 * Public routes (buyer-facing)
 * Routes under /api/events
 */

// Public event listing
router.get("/", getEventsList);
router.get("/:id", getEventDetail);

// Private link event detail
router.get("/share/:shareToken", getEventByShareToken);

module.exports = router;
