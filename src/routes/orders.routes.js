// orders.routes.js
// Registers ONLY the 5 routes defined in Module 3 — Ticket Purchase Flow

const express = require("express");
const router = express.Router();

const { requireAuth, requireRole } = require("../middlewares/auth.middleware");
const { createOrderLimiter } = require("../middlewares/rateLimiter.middleware");

const {
  createOrder,
  confirmOrder,
  getBuyerTickets,
  getBuyerCancelledEventTickets,
  submitBuyerRefund,
  getTicketQR,
  scanTicket
} = require("../controllers/orders.controller");

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE 1 — POST /api/orders
// Create a new order in pending status
// Auth: buyer
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireRole("buyer"),
  createOrderLimiter,
  createOrder
);

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE 2 — POST /api/orders/:id/confirm
// Confirm payment success / failure (called by PaymentService stub or webhook)
// Auth: system call — no role restriction; auth middleware validates the token
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/confirm",
  requireAuth,
  confirmOrder
);

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE 3 — GET /api/buyer/tickets
// Return all tickets for the authenticated buyer, grouped by event
// Auth: buyer
//
// NOTE: This route MUST be registered before /:id/confirm to prevent Express
//       matching "buyer" as an :id param. Mount this router at /api in app.js:
//         app.use("/api/orders", ordersRouter);
//         app.use("/api/buyer",  buyerRouter);   ← preferred alternative
//       OR keep all routes here and ensure /buyer/* comes before /:id/*
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/buyer/tickets",
  requireAuth,
  requireRole("buyer"),
  getBuyerTickets
);

// Refund Centre: buyer cancelled-event tickets with refund windows
router.get(
  "/buyer/tickets/cancelled-events",
  requireAuth,
  requireRole("buyer"),
  getBuyerCancelledEventTickets
);

router.post(
  "/buyer/refunds",
  requireAuth,
  requireRole("buyer"),
  submitBuyerRefund
);

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE 4 — GET /api/buyer/tickets/:itemId/qr
// Return QR code image + signed hash for a specific ticket item
// Auth: buyer (must own the ticket)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/buyer/tickets/:itemId/qr",
  requireAuth,
  requireRole("buyer"),
  getTicketQR
);

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE 5 — POST /api/events/:id/scan
// Validate QR code at event entry; mark ticket as used if valid
// Auth: promoter or admin
// Response is always 200 — use valid: false for rejection (never 4xx)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/events/:id/scan",
  requireAuth,
  requireRole("promoter", "admin"),
  scanTicket
);

module.exports = router;