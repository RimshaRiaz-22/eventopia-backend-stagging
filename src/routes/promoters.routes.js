const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { requireActivePromoter, requireEventOwnership, requireTicketTypeOwnership } = require("../middlewares/auth.middleware");
const { upload } = require("../middlewares/upload.middleware");
const { createEventLimiter, updateEventLimiter, /* statusChangeLimiter, */ updateTicketTypeLimiter, createOrderLimiter } = require("../middlewares/rateLimiter.middleware");
const {
  createReferralLink,
  listPromoterReferrals,
} = require("../controllers/promoterReferrals.controller");

// Promoter account management routes
const {
  setupAccount,
  createApplication,
  getMyApplication,
  getMyProfile,
  payActivationFee,
  editApplication,
} = require("../controllers/promoters.controller");

// Rewards and dashboard routes
const { getMyRewards, getDashboardOverview } = require("../controllers/promoter.controller");

// Event management routes
const {
  createEvent,
  updateEvent,
  getPromoterEvents,
  getPromoterEventDetail,
  uploadEventImage,
  setEventCategory,
  setEventTags,
  submitEvent,
  publishEvent,
  pauseEvent,
  cancelEvent,
  republishEvent,
  getEventPerformance,
  completeEvent,
  deleteEventCover,
  deleteEventGalleryImage,
  reorderGalleryImages,
  deleteEvent,
} = require("../controllers/events.controller");

// Ticket management routes
const {
  getTicketTypes,
  createTicketType,
  updateTicketType,
  duplicateTicketType,
  pauseTicketType,
  resumeTicketType,
  deleteTicketType,
} = require("../controllers/tickets.controller");

// Ticket access control routes
const ticketAccessController = require("../controllers/ticketAccess.controller");

// Scanner routes
const scannerController = require("../controllers/scanner.controller");

// Charity routes
const {
  createCharityApplication,
  listMyApplications,
  getApplication,
  updateApplication,
  submitApplication,
  payApplicationFee,
  getApplicationStatus,
  getExecutions
} = require("../controllers/charity.controller");

const requireActivePromoterOrKingsAccount = (req, res, next) => {
  if (req.user?.role === "kings_account") {
    return next();
  }
  return requireActivePromoter(req, res, next);
};

const requireEventOwnershipOrKingsAccount = (req, res, next) => {
  if (req.user?.role === "kings_account") {
    return next();
  }
  return requireEventOwnership(req, res, next);
};

// All promoter routes require authentication
router.use(requireAuth);

/**
 * Promoter Account Management
 * Routes under /api/promoter
 */

router.put("/setup-account", setupAccount);

router.post("/applications", createApplication);
router.get("/applications/me", getMyApplication);
router.patch("/applications/me", editApplication);

router.get("/me", getMyProfile);

router.post("/applications/:id/payments", payActivationFee);

// Promoter -> Promoter referral APIs (Flow 1)
router.get("/referral/link", requireActivePromoter, createReferralLink);
router.get("/referrals", requireActivePromoter, listPromoterReferrals);

/**
 * Promoter Dashboard Overview
 * GET /api/promoters/dashboard/overview
 */
router.get("/dashboard/overview", requireActivePromoter, getDashboardOverview);

/**
 * Promoter Event Management Routes
 * Routes under /api/promoter/events
 */

// Create event
router.post("/events", requireActivePromoter,
  // createEventLimiter,
  createEvent);
// Get promoter's events
router.get("/events", requireActivePromoter, getPromoterEvents);
// Get single event detail for promoter
router.get("/events/:eventId", requireActivePromoter, requireEventOwnership, getPromoterEventDetail);
// Update event
router.patch("/events/:eventId", requireActivePromoter, requireEventOwnership, updateEventLimiter, updateEvent);
// Delete event
router.delete("/events/:eventId", requireActivePromoter, requireEventOwnership, deleteEvent);
// Upload image - cover or gallery
router.post("/events/:eventId/images", requireActivePromoter, requireEventOwnership, upload.single("image"), uploadEventImage);
// Set event category
router.put("/events/:eventId/category", requireActivePromoter, requireEventOwnership, setEventCategory);
// Set event tags
router.put("/events/:eventId/tags", requireActivePromoter, requireEventOwnership, setEventTags);
// Submit event for admin approval
router.post("/events/:eventId/submit", requireActivePromoterOrKingsAccount, requireEventOwnershipOrKingsAccount, /* statusChangeLimiter, */ submitEvent);
// Publish event
router.post("/events/:eventId/publish", requireActivePromoterOrKingsAccount, requireEventOwnershipOrKingsAccount, /* statusChangeLimiter, */ publishEvent);
// Pause event
router.post("/events/:eventId/pause", requireActivePromoterOrKingsAccount, requireEventOwnershipOrKingsAccount, /* statusChangeLimiter, */ pauseEvent);
// Cancel event
router.post("/events/:eventId/cancel", requireActivePromoterOrKingsAccount, requireEventOwnershipOrKingsAccount, /* statusChangeLimiter, */ cancelEvent);
// Republish event
router.post("/events/:eventId/republish", requireActivePromoterOrKingsAccount, requireEventOwnershipOrKingsAccount, /* statusChangeLimiter, */ republishEvent);
// Complete event
router.post("/events/:eventId/complete", requireActivePromoterOrKingsAccount, requireEventOwnershipOrKingsAccount, completeEvent);
// Delete event cover image
router.delete("/events/:eventId/cover", requireActivePromoter, requireEventOwnership, deleteEventCover);
// Delete gallery image
router.delete("/events/:eventId/gallery/:imageId", requireActivePromoter, requireEventOwnership, deleteEventGalleryImage);
// Reorder gallery images
router.patch("/events/:eventId/images/reorder", requireActivePromoter, requireEventOwnership, reorderGalleryImages);
// Get event performance
router.get("/events/:eventId/performance", requireActivePromoter, requireEventOwnership, getEventPerformance);

/**
 * Promoter Ticket Management Routes
 * Routes under /api/promoter
 */

// Get ticket types for an event
router.get(
  "/events/:eventId/ticket-types",
  requireActivePromoter,
  requireEventOwnership,
  getTicketTypes
);

// Create a new ticket type
router.post(
  "/events/:eventId/ticket-types",
  requireActivePromoter,
  requireEventOwnership,
  updateTicketTypeLimiter,
  createTicketType
);

// Update a ticket type
router.patch(
  "/ticket-types/:ticketTypeId",
  requireActivePromoter,
  requireTicketTypeOwnership,
  updateTicketTypeLimiter,
  updateTicketType
);

// Duplicate a ticket type
router.post(
  "/ticket-types/:ticketTypeId/duplicate",
  requireActivePromoter,
  requireTicketTypeOwnership,
  createOrderLimiter,
  duplicateTicketType
);

// Pause a ticket type
router.post(
  "/ticket-types/:ticketTypeId/pause",
  requireActivePromoter,
  requireTicketTypeOwnership,
  // statusChangeLimiter,
  pauseTicketType
);

// Resume a ticket type
router.post(
  "/ticket-types/:ticketTypeId/resume",
  requireActivePromoter,
  requireTicketTypeOwnership,
  // statusChangeLimiter,
  resumeTicketType
);

// Delete a ticket type
router.delete(
  "/ticket-types/:ticketTypeId",
  requireActivePromoter,
  requireTicketTypeOwnership,
  // statusChangeLimiter,
  deleteTicketType
);

// Get my rewards
router.get("/rewards", requireActivePromoter, getMyRewards);

/**
 * Promoter Event Operations - Attendees, Scanner, Logs
 * Routes under /api/promoter/events/:eventId
 */

// Get attendees for an event
router.get(
  "/events/:eventId/attendees",
  requireActivePromoter,
  requireEventOwnership,
  scannerController.getEventAttendees
);

// Validate a ticket for an event
router.post(
  "/events/:eventId/validate",
  requireActivePromoter,
  requireEventOwnership,
  scannerController.validateEventTicket
);

// Check-in a ticket for an event
router.post(
  "/events/:eventId/checkin",
  requireActivePromoter,
  requireEventOwnership,
  scannerController.checkInEventTicket
);

// Undo check-in for a ticket
router.post(
  "/events/:eventId/checkin/undo",
  requireActivePromoter,
  requireEventOwnership,
  scannerController.undoCheckIn
);

// Get audit logs for an event
router.get(
  "/events/:eventId/logs",
  requireActivePromoter,
  requireEventOwnership,
  scannerController.getEventLogs
);

// Access settings routes
router.get(
  "/events/:eventId/access-settings",
  requireActivePromoter,
  requireEventOwnership,
  ticketAccessController.getAccessSettings
);

router.patch(
  "/events/:eventId/access-settings",
  requireActivePromoter,
  requireEventOwnership,
  ticketAccessController.updateAccessSettings
);

router.post(
  "/events/:eventId/rotate-access",
  requireActivePromoter,
  requireEventOwnership,
  ticketAccessController.rotateAccessLinks
);

/**
 * Promoter Charity Management Routes
 * Routes under /api/promoter/charity
 */

// Charity application routes
router.post("/charity/applications", createApplication);
router.get("/charity/applications", listMyApplications);
router.get("/charity/applications/:id", getApplication);
router.put("/charity/applications/:id", updateApplication);
router.post("/charity/applications/:id/submit", submitApplication);
router.post("/charity/applications/:id/pay-fee", payApplicationFee);
router.get("/charity/applications/:id/status", getApplicationStatus);
router.get("/charity/applications/:id/executions", getExecutions);

module.exports = router;
