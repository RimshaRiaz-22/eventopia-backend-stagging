const pool = require("../db");
const { validateAccessToken } = require("../services/session.service");
const { fail } = require("../utils/standardResponse");

async function requireAuth(req, res, next) {
  try {
    // 1. Require Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({
        error: true,
        message: "Authorization header required",
        data: null,
      });
    }

    // 2. Require Bearer token
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({
        error: true,
        message: "Invalid Authorization format. Use: Bearer <token>",
        data: null,
      });
    }

    const accessToken = parts[1];

    // 3. Validate JWT access token and session
    const sessionInfo = await validateAccessToken(accessToken);

    // 4. Load full user data
    const userResult = await pool.query(
      `
      SELECT u.*
      FROM users u
      WHERE u.id = $1
      `,
      [sessionInfo.userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(401).json({
        error: true,
        message: "User not found",
        data: null,
      });
    }

    const user = userResult.rows[0];

    // Filter out NULL roles and use session roles or fallback to user.role
    const sessionRoles = sessionInfo.roles || [];
    const userRoles = sessionRoles.filter(role => role !== null && role !== undefined) || (user.role ? [user.role] : []);

    // 5a. For promoter users, look up their promoter_profile.id from user.id
    let promoterId = null;
    if (userRoles.includes('promoter')) {
      const profileResult = await pool.query(
        'SELECT id FROM promoter_profiles WHERE user_id = $1',
        [user.id]
      );
      if (profileResult.rowCount > 0) {
        promoterId = profileResult.rows[0].id;
      }
    }

    // 5b. Attach user and session info to request
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      city: user.city,
      avatar_url: user.avatar_url,
      status: user.status,
      role: user.role,
      account_status: user.account_status,
      roles_version: user.roles_version || 1,
      promoter_id: promoterId,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };

    req.userRoles = userRoles;
    req.sessionId = sessionInfo.sessionId;

    next();
  } catch (err) {
    return res.status(401).json({
      error: true,
      message: err.message || "Authentication failed",
      data: null,
    });
  }
}

/**
 * RBAC Middleware - Check if user has required role
 * Usage: requireRole('admin'), requireRole('promoter'), etc.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.userRoles || req.userRoles.length === 0) {
      return res.status(403).json({
        error: true,
        message: "Access denied. No roles assigned.",
        data: null,
      });
    }

    // Check if user has at least one of the required roles
    const hasRole = allowedRoles.some((role) => req.userRoles.includes(role));

    if (!hasRole) {
      return res.status(403).json({
        error: true,
        message: `Access denied. Required role: ${allowedRoles.join(" or ")}`,
        data: null,
      });
    }

    next();
  };
}

/**
 * Middleware to check if user has admin role
 */
function requireAdmin(req, res, next) {
  if (!req.userRoles || !req.userRoles.includes("admin")) {
    return res.status(403).json({
      error: true,
      message: "Access denied. Admin role required.",
      data: null,
    });
  }
  next();
}

/**
 * Middleware to check if user has founder or admin role (Phase 10 King's Account)
 */
function requireFounderOrAdmin(req, res, next) {
  if (!req.userRoles || req.userRoles.length === 0) {
    return res.status(403).json({
      error: true,
      message: "Access denied. Founder or admin role required.",
      data: null,
    });
  }
  const hasAccess = req.userRoles.includes("founder") || req.userRoles.includes("admin");
  if (!hasAccess) {
    return res.status(403).json({
      error: true,
      message: "Access denied. Founder or admin role required.",
      data: null,
    });
  }
  next();
}

/**
 * Middleware for King's Account ledger APIs: requires kings_account role.
 * Returns 403 with code WRONG_ROLE if user does not have kings_account.
 */
function requireKingsAccount(req, res, next) {
  if (!req.userRoles || req.userRoles.length === 0) {
    return fail(res, req, 403, "WRONG_ROLE", "King's Account role required");
  }
  if (!req.userRoles.includes("kings_account")) {
    return fail(res, req, 403, "WRONG_ROLE", "King's Account role required");
  }
  next();
}

/**
 * Middleware to check if user has promoter role
 */
function requirePromoter(req, res, next) {
  if (!req.userRoles || !req.userRoles.includes('promoter')) {
    return res.status(403).json({
      error: true,
      message: "Promoter role required",
      data: null,
    });
  }
  next();
}

/**
 * Middleware to check if user is an active promoter
 */
async function requireActivePromoter(req, res, next) {
  if (!req.userRoles || !req.userRoles.includes('promoter')) {
    return res.status(403).json({
      error: true,
      message: "Promoter role required",
      data: null,
    });
  }
  if (req.user.account_status !== 'active') {
    return res.status(403).json({
      error: true,
      message: "Active promoter account required",
      data: null,
    });
  }
  next();
}

/**
 * Middleware to verify event ownership
 */
async function requireEventOwnership(req, res, next) {
  const { eventId } = req.params;

  // Convert eventId to number, return 404 if invalid
  const eventIdNum = parseInt(eventId, 10);
  if (isNaN(eventIdNum) || eventIdNum <= 0) {
    return res.status(404).json({
      error: true,
      message: "Event not found",
      data: null,
    });
  }

  const result = await pool.query(
    `SELECT promoter_id FROM events WHERE id = $1`,
    [eventIdNum]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({
      error: true,
      message: "Event not found",
      data: null,
    });
  }
  if (result.rows[0].promoter_id !== req.user.id) {
    return res.status(403).json({
      error: true,
      message: "You cannot access this event",
      data: null,
    });
  }
  next();
}

/**
 * Middleware to verify ticket type ownership (for promoters)
 */
async function requireTicketTypeOwnership(req, res, next) {
  const { ticketTypeId } = req.params;

  // Convert ticketTypeId to number, return 404 if invalid
  const ticketTypeIdNum = parseInt(ticketTypeId, 10);
  if (isNaN(ticketTypeIdNum) || ticketTypeIdNum <= 0) {
    return res.status(404).json({
      error: true,
      message: "Ticket type not found",
      data: null,
    });
  }

  const result = await pool.query(
    `SELECT e.promoter_id FROM ticket_types tt
     JOIN events e ON e.id = tt.event_id
     WHERE tt.id = $1`,
    [ticketTypeIdNum]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({
      error: true,
      message: "Ticket type not found",
      data: null,
    });
  }

  if (result.rows[0].promoter_id !== req.user.id) {
    return res.status(403).json({
      error: true,
      message: "You cannot access this ticket type",
      data: null,
    });
  }

  next();
}

/**
 * Middleware to verify order ownership (for buyers)
 */
async function requireOrderOwnership(req, res, next) {
  const { orderId } = req.params;

  // Convert orderId to number, return 404 if invalid
  const orderIdNum = parseInt(orderId, 10);
  if (isNaN(orderIdNum) || orderIdNum <= 0) {
    return res.status(404).json({
      error: true,
      message: "Order not found",
      data: null,
    });
  }

  const result = await pool.query(
    `SELECT buyer_user_id FROM orders WHERE id = $1`,
    [orderIdNum]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({
      error: true,
      message: "Order not found",
      data: null,
    });
  }

  if (result.rows[0].buyer_user_id !== req.user.id) {
    return res.status(403).json({
      error: true,
      message: "You cannot access this order",
      data: null,
    });
  }

  next();
}

/**
 * Middleware to check if user has a pending Network Manager application
 * Blocks access to Network Manager module routes for pending applicants
 * Allows: /auth/me, /network-managers/applications/me, profile updates
 */
async function requireNotPendingNetworkManager(req, res, next) {
  try {
    // Check if user has a pending Network Manager application
    const result = await pool.query(
      `
      SELECT account_status
      FROM network_manager_applications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [req.user.id]
    );

    if (result.rowCount > 0) {
      const application = result.rows[0];
      if (application.account_status === 'pending') {
        return res.status(403).json({
          error: true,
          message: "Your Network Manager application is pending approval. You cannot access this feature until your application is approved.",
          data: null,
        });
      }
    }

    next();
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Unable to verify application status.",
      data: null,
    });
  }
}

/**
 * Middleware to verify ticket ownership
 */
async function requireTicketOwnership(req, res, next) {
  const { ticketId } = req.params;

  // Convert ticketId to number, return 404 if invalid
  const ticketIdNum = parseInt(ticketId, 10);
  if (isNaN(ticketIdNum) || ticketIdNum <= 0) {
    return res.status(404).json({
      error: true,
      message: "Ticket not found",
      data: null,
    });
  }

  const result = await pool.query(
    `SELECT o.buyer_user_id FROM tickets t
     JOIN order_items oi ON oi.id = t.order_item_id
     JOIN orders o ON o.id = oi.order_id
     WHERE t.id = $1`,
    [ticketIdNum]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({
      error: true,
      message: "Ticket not found",
      data: null,
    });
  }

  if (result.rows[0].buyer_user_id !== req.user.id) {
    return res.status(403).json({
      error: true,
      message: "You cannot access this ticket",
      data: null,
    });
  }

  next();
}

/**
 * Middleware to allow Network Manager applicants to access account setup and application routes
 * Users with NULL role who have verified their email can access these routes
 */
async function requireNetworkManagerApplicant(req, res, next) {
  try {
    // Check if user has NULL role (Network Manager applicant)
    if (req.user.role !== null && req.user.role !== undefined) {
      return res.status(403).json({
        error: true,
        message: "This endpoint is only for Network Manager applicants.",
        data: null,
      });
    }

    // Check if email is verified
    if (req.user.email_status !== 'verified') {
      return res.status(403).json({
        error: true,
        message: "Please verify your email first.",
        data: null,
      });
    }

    next();
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Unable to verify applicant status.",
      data: null,
    });
  }
}

module.exports = {
  requireAuth,
  requireRole,
  requireAdmin,
  requireFounderOrAdmin,
  requireKingsAccount,
  requirePromoter,
  requireActivePromoter,
  requireEventOwnership,
  requireTicketTypeOwnership,
  requireOrderOwnership,
  requireTicketOwnership,
  requireNotPendingNetworkManager,
  requireNetworkManagerApplicant,
};
