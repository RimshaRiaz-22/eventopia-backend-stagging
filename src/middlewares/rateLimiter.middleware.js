const rateLimit = require("express-rate-limit");
const { fail } = require("../utils/standardResponse");

const createEventLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 event creation requests per windowMs
  message: (req, res) => fail(res, req, 429, "RATE_LIMIT", "Too many event creation attempts, please try again later"),
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

const updateEventLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 event update requests per windowMs
  message: (req, res) => fail(res, req, 429, "RATE_LIMIT", "Too many event update attempts, please try again later"),
  standardHeaders: true,
  legacyHeaders: false,
});


const createOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each user to 10 order creation requests per windowMs
  keyGenerator: (req) => req.user?.id || req.ip, // Rate limit by user ID if authenticated, else by IP
  message: (req, res) => fail(res, req, 429, "RATE_LIMIT", "Too many order attempts, please try again later"),
  standardHeaders: true,
  legacyHeaders: false,
});

const updateTicketTypeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 ticket type update requests per windowMs
  message: (req, res) => fail(res, req, 429, "RATE_LIMIT", "Too many ticket type update attempts"),
  standardHeaders: true,
  legacyHeaders: false,
});

const cancelOrderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each user to 5 order cancellations per hour
  keyGenerator: (req) => req.user?.id || req.ip,
  message: (req, res) => fail(res, req, 429, "RATE_LIMIT", "Too many cancellation attempts, please try again later"),
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  createEventLimiter,
  updateEventLimiter,
  // statusChangeLimiter,
  createOrderLimiter,
  updateTicketTypeLimiter,
  cancelOrderLimiter,
};
