/**
 * Day 7 v1 Tickets API. Mounted at /v1/tickets (base /api/v1/tickets).
 */

const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middlewares/auth.middleware");
const { purchaseTicketsV1, getMyTicketsV1 } = require("../controllers/v1Tickets.controller");

router.use(requireAuth);
router.use(requireRole("buyer"));

// POST /api/v1/tickets/purchase — purchase tickets (no payment, immediate confirm)
router.post("/purchase", purchaseTicketsV1);

// GET /api/v1/tickets/my — buyer's tickets
router.get("/my", getMyTicketsV1);

module.exports = router;
