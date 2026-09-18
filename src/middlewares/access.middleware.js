/**
 * Access Grant Middleware
 *
 * Validates access grants for private link events and hidden ticket types
 */

const { hasEventAccess } = require('../services/access.service');
const { fail } = require('../utils/standardResponse');

/**
 * Require event access grant
 * Checks if the user has a valid access grant for the event
 */
async function requireEventAccess(req, res, next) {
  try {
    const eventId = req.params.eventId || req.body.eventId || req.query.eventId;

    if (!eventId) {
      return fail(res, req, 400, "MISSING_EVENT_ID", "Event ID is required");
    }

    // Get access grant from cookie
    const accessGrant = req.cookies?.event_access_grant;

    if (!accessGrant) {
      return fail(res, req, 403, "ACCESS_DENIED", "Access grant required. Please access this event through the private link.");
    }

    // Verify access grant
    if (!hasEventAccess(accessGrant, eventId, req.user?.id)) {
      return fail(res, req, 403, "ACCESS_DENIED", "Invalid or expired access grant. Please access this event through the private link.");
    }

    // Store the access grant for use in order creation
    req.eventAccessGrant = accessGrant;

    next();
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Optional: Check if event requires access grant (private_link or has hidden ticket types)
 * Returns true if the event requires special access
 */
async function checkEventRequiresAccess(req, res, next) {
  try {
    const { eventId } = req.params;

    // Import pool dynamically to avoid circular dependency
    const { pool } = require('../db/index');

    const result = await pool.query(
      `SELECT e.visibility AS visibility_mode, COUNT(*)::int as hidden_count
       FROM events e
       LEFT JOIN ticket_types tt ON tt.event_id = e.id AND tt.visibility = 'hidden'
       WHERE e.id = $1
       GROUP BY e.id, e.visibility`,
      [eventId]
    );

    if (result.rows.length === 0) {
      return fail(res, req, 404, "EVENT_NOT_FOUND", "Event not found");
    }

    const { visibility_mode, hidden_count } = result.rows[0];

    // Event requires access if it's private_link or has hidden ticket types
    req.eventRequiresAccess = visibility_mode === 'private_link' || parseInt(hidden_count) > 0;

    next();
  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

module.exports = {
  requireEventAccess,
  checkEventRequiresAccess
};
