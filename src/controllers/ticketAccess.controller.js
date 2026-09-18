const pool = require('../db');
const asyncHandler = require('express-async-handler');
const accessService = require('../services/accessToken.service');
const { fail, ok } = require('../utils/standardResponse');

/**
 * Get access state for a ticket
 * GET /api/tickets/:ticketId/access
 */
const getTicketAccessState = asyncHandler(async (req, res) => {
  const { ticketId } = req.params;

  // Verify ticket ownership
  const ownershipResult = await pool.query(
    `SELECT t.*, o.buyer_user_id
     FROM tickets t
     JOIN orders o ON t.order_id = o.id
     WHERE t.id = $1 AND o.buyer_user_id = $2`,
    [ticketId, req.user.id]
  );

  if (ownershipResult.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Ticket not found");
  }

  const ticket = ownershipResult.rows[0];

  // Get event and ticket type data
  const result = await pool.query(
    `SELECT e.*, tt.access_mode, tt.reveal_rule, tt.on_demand_start_at, tt.on_demand_end_at
     FROM events e
     JOIN ticket_types tt ON e.id = tt.event_id AND tt.id = $2
     WHERE e.id = $1`,
    [ticket.event_id, ticket.ticket_type_id]
  );

  if (result.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Event or ticket type not found");
  }

  const { event, ticket_type } = {
    event: result.rows[0],
    ticket_type: result.rows[0]
  };

  // Check access eligibility
  const eligibility = await accessService.checkAccessEligibility(
    ticket,
    event,
    ticket_type,
    new Date()
  );

  // Determine button label
  let button_label = null;
  if (eligibility.allowed) {
    if (ticket_type.access_mode === 'ONLINE_LIVE') {
      button_label = 'Join live';
    } else if (ticket_type.access_mode === 'ON_DEMAND') {
      button_label = 'Watch now';
    }
  }

  return ok(res, req, {
    message: "Access state retrieved",
    access_mode: ticket_type.access_mode,
    allowed: eligibility.allowed,
    reason_code: eligibility.reason_code,
    available_at: eligibility.available_at,
    button_label
  });
});

/**
 * Create an access session for a ticket
 * POST /api/tickets/:ticketId/access-session
 */
const createAccessSession = asyncHandler(async (req, res) => {
  const { ticketId } = req.params;
  const { purpose } = req.body;

  if (!purpose || !['LIVE_JOIN', 'ONDEMAND_VIEW'].includes(purpose)) {
    return fail(res, req, 400, "INVALID_INPUT", "Purpose must be LIVE_JOIN or ONDEMAND_VIEW");
  }

  // Verify ticket ownership
  const ownershipResult = await pool.query(
    `SELECT t.*, o.buyer_user_id, tt.access_mode
     FROM tickets t
     JOIN orders o ON t.order_id = o.id
     JOIN ticket_types tt ON t.ticket_type_id = tt.id
     WHERE t.id = $1 AND o.buyer_user_id = $2`,
    [ticketId, req.user.id]
  );

  if (ownershipResult.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Ticket not found");
  }

  const ticket = ownershipResult.rows[0];

  // Validate purpose matches access mode
  if (ticket.access_mode === 'ONLINE_LIVE' && purpose !== 'LIVE_JOIN') {
    return fail(res, req, 400, "INVALID_INPUT", "Invalid purpose for ONLINE_LIVE ticket");
  }

  if (ticket.access_mode === 'ON_DEMAND' && purpose !== 'ONDEMAND_VIEW') {
    return fail(res, req, 400, "INVALID_INPUT", "Invalid purpose for ON_DEMAND ticket");
  }

  if (ticket.access_mode === 'IN_PERSON') {
    return fail(res, req, 400, "INVALID_INPUT", "IN_PERSON tickets do not have access links");
  }

  // Get event and ticket type for eligibility check
  const result = await pool.query(
    `SELECT e.*, tt.access_mode, tt.reveal_rule, tt.on_demand_start_at, tt.on_demand_end_at
     FROM events e
     JOIN ticket_types tt ON e.id = tt.event_id AND tt.id = $2
     WHERE e.id = $1`,
    [ticket.event_id, ticket.ticket_type_id]
  );

  const { event, ticket_type } = {
    event: result.rows[0],
    ticket_type: result.rows[0]
  };

  // Check access eligibility
  const eligibility = await accessService.checkAccessEligibility(
    ticket,
    event,
    ticket_type,
    new Date()
  );

  if (!eligibility.allowed) {
    return fail(res, req, 403, "ACCESS_DENIED", `Access not available: ${eligibility.reason_code}`);
  }

  // Create access token
  const expiresInMinutes = purpose === 'LIVE_JOIN' ? 15 : 60; // Live links expire faster
  const tokenData = await accessService.createAccessToken(
    ticketId,
    purpose,
    expiresInMinutes,
    {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      userId: req.user.id
    }
  );

  const accessSessionUrl = `${req.protocol}://${req.get('host')}/api/access/${tokenData.token}`;

  return ok(res, req, {
    message: "Access session created",
    access_session_url: accessSessionUrl,
    expires_at: tokenData.expires_at
  });
});

/**
 * Resolve an access token and redirect to the real URL
 * GET /api/access/:token
 */
const resolveAccessToken = asyncHandler(async (req, res) => {
  const { token } = req.params;

  const tokenData = await accessService.resolveAccessToken(token);

  if (!tokenData) {
    return fail(res, req, 401, "INVALID_TOKEN", "Access token is invalid or expired");
  }

  if (!tokenData.redirectUrl) {
    return fail(res, req, 400, "NO_REDIRECT_URL", "No redirect URL configured for this access type");
  }

  // Log the access (optional - already updated in service)
  console.log(`Access granted: Ticket ${tokenData.ticketId}, Purpose: ${tokenData.purpose}`);

  // Redirect to the actual access URL
  return res.redirect(302, tokenData.redirectUrl);
});

/**
 * Get access settings for an event (Promoter)
 * GET /api/promoter/events/:eventId/access-settings
 */
const getAccessSettings = asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  // Verify event ownership
  const eventResult = await pool.query(
    `SELECT id FROM events WHERE id = $1 AND promoter_id = $2`,
    [eventId, req.user.id]
  );

  if (eventResult.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Event not found");
  }

  const settings = await accessService.getAccessSettings(eventId);

  // return ok(res, req, "Access settings retrieved", settings);
  return ok(res, req, {
    message: "Access settings retrieved",
    settings,
  });

});

/**
 * Update access settings for an event (Promoter)
 * PATCH /api/promoter/events/:eventId/access-settings
 */
const updateAccessSettings = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const settings = req.body;

  // Verify event ownership
  const eventResult = await pool.query(
    `SELECT id FROM events WHERE id = $1 AND promoter_id = $2`,
    [eventId, req.user.id]
  );

  if (eventResult.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Event not found");
  }

  // Validate settings
  if (settings.live_access_url !== undefined && settings.live_access_url !== null) {
    try {
      new URL(settings.live_access_url);
    } catch {
      return fail(res, req, 400, "INVALID_INPUT", "live_access_url must be a valid URL");
    }
  }

  if (settings.ondemand_access_url !== undefined && settings.ondemand_access_url !== null) {
    try {
      new URL(settings.ondemand_access_url);
    } catch {
      return fail(res, req, 400, "INVALID_INPUT", "ondemand_access_url must be a valid URL");
    }
  }

  // Update settings
  await accessService.updateAccessSettings(eventId, settings);

  // return ok(res, req, "Access settings updated", { eventId, settings });
  return ok(res, req, {
    message: "Access settings updated",
    eventId,
    settings,
  });

});

/**
 * Rotate access links for an event (Promoter)
 * POST /api/promoter/events/:eventId/rotate-access
 */
const rotateAccessLinks = asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  // Verify event ownership
  const eventResult = await pool.query(
    `SELECT id FROM events WHERE id = $1 AND promoter_id = $2`,
    [eventId, req.user.id]
  );

  if (eventResult.rowCount === 0) {
    return fail(res, req, 404, "NOT_FOUND", "Event not found");
  }

  // Rotate links
  const revokedCount = await accessService.rotateAccessLinks(eventId, req.user.id);

  return ok(res, req, {
    message: "Access links rotated",
    eventId,
    revoked_tokens: revokedCount,
    rotated_at: new Date()
  });
});

module.exports = {
  getTicketAccessState,
  createAccessSession,
  resolveAccessToken,
  getAccessSettings,
  updateAccessSettings,
  rotateAccessLinks
};
