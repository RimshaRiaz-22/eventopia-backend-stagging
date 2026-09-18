const express = require("express");
const router = express.Router();
const authRoutes = require("./auth.routes");
const userRoutes = require("./users.routes");
const adminRoutes = require("./admin.routes");
const v1Routes = require("./v1.routes");
const eventsRoutes = require("./events.routes");
const categoriesRoutes = require("./categories.routes");
const territoriesRoutes = require("./territories.routes");
const filesRoutes = require("./files.routes");
const networkManagersRoutes = require("./network-managers.routes");
const networkRoutes = require("./network.routes");
const gurusRoutes = require("./gurus.routes");
const promotersRoutes = require("./promoters.routes");
const tagsRoutes = require("./tags.routes");
const ticketsRoutes = require("./tickets.routes");
const ordersRoutes = require("./orders.routes");
const module3TicketingAliasRoutes = require("./module3.ticketing.alias.routes");
const webhooksRoutes = require("./webhooks.routes");
const avatarRoutes = require("./files.routes");
const ticketAccessRoutes = require("./ticketAccess.routes");
const rewardsRoutes = require("./rewards.routes");
const escrowRoutes = require("./escrow.routes");

// Mount route modules
router.use("/auth", authRoutes);
router.use("/files", avatarRoutes);
router.use("/users", userRoutes);
router.use("/admin", adminRoutes);
router.use("/v1", v1Routes);
router.use("/events", eventsRoutes);
router.use("/categories", categoriesRoutes);
router.use("/tags", tagsRoutes);
router.use("/territories", territoriesRoutes);
router.use("/files", filesRoutes);
router.use("/network-managers", networkManagersRoutes);
router.use("/network", networkRoutes);
router.use("/gurus", gurusRoutes);
router.use("/promoters", promotersRoutes);
router.use("/tickets", ticketsRoutes);
router.use("/orders", ordersRoutes);
router.use("/webhooks", webhooksRoutes);
router.use("/rewards", rewardsRoutes);

// Escrow system routes (Contracts 15, 16, 17)
router.use("/v1/escrow", escrowRoutes);

// Escrow system routes (Contracts 15, 16, 17)
router.use("/v1/escrow", escrowRoutes);

// Ticket access control routes
router.use("/", ticketAccessRoutes);

// Module 3 — Ticket Purchase Flow URL aliases
// Document expects routes like:
//   /api/buyer/tickets
//   /api/buyer/tickets/:itemId/qr
//   /api/events/:id/scan
router.use("/", module3TicketingAliasRoutes);

module.exports = router;
