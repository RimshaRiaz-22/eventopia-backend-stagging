/**
 * Audit Logging Service for Tickets
 *
 * Provides append-only audit trail for all ticket status changes
 */

const pool = require('../db/index');

/**
 * Log a ticket action to the audit trail
 * @param {number|string|null} actorUserId - ID of user performing the action (null for system)
 * @param {number|string} ticketId - Ticket ID
 * @param {number|string} eventId - Event ID
 * @param {string} action - Action type (MINTED, VALIDATED, CHECKED_IN, UNDO_CHECKIN, REFUNDED, CANCELLED)
 * @param {string|null} beforeStatus - Previous status (null if none)
 * @param {string|null} afterStatus - New status (null if none)
 * @param {object} metadata - Additional metadata (optional)
 */
async function logTicketAudit(
  actorUserId,
  ticketId,
  eventId,
  action,
  beforeStatus = null,
  afterStatus = null,
  metadata = {},
  options = {}
) {
  try {
    const db = options.client || pool;
    const query = `
      INSERT INTO ticket_audit_logs (ticket_id, event_id, actor_user_id, action, before_status, after_status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    await db.query(query, [
      ticketId,
      eventId,
      actorUserId,
      action,
      beforeStatus,
      afterStatus,
      metadata
    ]);
  } catch (err) {
    console.error('Failed to log ticket audit:', err);
    // Don't throw - audit logging shouldn't break the main flow
  }
}

/**
 * Get audit logs for a ticket
 * @param {number|string} ticketId - Ticket ID
 * @returns {Promise<Array>} Array of audit log entries
 */
async function getTicketAuditLogs(ticketId) {
  try {
    const query = `
      SELECT
        tal.*,
        u.name as actor_name,
        u.email as actor_email
      FROM ticket_audit_logs tal
      LEFT JOIN users u ON u.id = tal.actor_user_id
      WHERE tal.ticket_id = $1
      ORDER BY tal.created_at DESC
    `;

    const result = await pool.query(query, [ticketId]);
    return result.rows;
  } catch (err) {
    console.error('Failed to get ticket audit logs:', err);
    return [];
  }
}

/**
 * Get audit logs for an event
 * @param {number|string} eventId - Event ID
 * @param {number} limit - Maximum number of logs to return (default: 100)
 * @returns {Promise<Array>} Array of audit log entries
 */
async function getEventAuditLogs(eventId, limit = 100) {
  try {
    const query = `
      SELECT
        tal.*,
        u.name as actor_name,
        u.email as actor_email,
        t.ticket_code
      FROM ticket_audit_logs tal
      LEFT JOIN users u ON u.id = tal.actor_user_id
      LEFT JOIN tickets t ON t.id = tal.ticket_id
      WHERE tal.event_id = $1
      ORDER BY tal.created_at DESC
      LIMIT $2
    `;

    const result = await pool.query(query, [eventId, limit]);
    return result.rows;
  } catch (err) {
    console.error('Failed to get event audit logs:', err);
    return [];
  }
}

module.exports = {
  logTicketAudit,
  getTicketAuditLogs,
  getEventAuditLogs
};
