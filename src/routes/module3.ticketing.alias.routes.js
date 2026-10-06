// module3.ticketing.alias.routes.js
// Route aliases to match "Module 3 — Ticket Purchase Flow" URL spec.
//
// This project’s existing routes are mounted under `/api/orders`, but the
// document expects:
//   /api/buyer/tickets
//   /api/buyer/tickets/:itemId/qr
//   /api/events/:id/scan
//
// Since `orders.routes.js` (mounted at `/api/orders`) already implements the
// controllers, these aliases simply forward to those same handlers.

const express = require("express");
const router = express.Router();

const { requireAuth, requireRole } = require("../middlewares/auth.middleware");

const { getBuyerTickets, getTicketQR, scanTicket } = require("../controllers/orders.controller");

// Service 3 — GET /api/buyer/tickets
router.get("/buyer/tickets", requireAuth, requireRole("buyer"), getBuyerTickets);

// Service 4 — GET /api/buyer/tickets/:itemId/qr
router.get(
  "/buyer/tickets/:itemId/qr",
  requireAuth,
  requireRole("buyer"),
  getTicketQR
);

// Service 5 — POST /api/events/:id/scan
router.post(
  "/events/:id/scan",
  requireAuth,
  requireRole("promoter", "admin"),
  scanTicket
);

module.exports = router;

