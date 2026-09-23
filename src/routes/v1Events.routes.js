/**
 * Day 7 v1 Events API. Mounted at /v1/events (base /api/v1/events).
 */

const express = require("express");
const router = express.Router();
const { requireAuth, optionalAuth, requireRole } = require("../middlewares/auth.middleware");
const { createEventV1, getEventDetailV1, getMyEventsV1, exportMyEventsV1 } = require("../controllers/v1Events.controller");

// POST /api/v1/events — create event (promoter only)
router.post("/", requireAuth, requireRole("promoter"), createEventV1);

// GET /api/v1/events/my — promoter's events (search, sort, filter, pagination)
router.get("/my", requireAuth, requireRole("promoter"), getMyEventsV1);

// GET /api/v1/events/my/export — promoter's events as CSV download (same filters)
router.get("/my/export", requireAuth, requireRole("promoter"), exportMyEventsV1);

// GET /api/v1/events/:id — event detail (public for published; draft only for owner; optional auth)
router.get("/:id", optionalAuth, getEventDetailV1);

module.exports = router;
