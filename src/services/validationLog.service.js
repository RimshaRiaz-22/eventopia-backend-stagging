/**
 * Validation Log Service
 *
 * Handles logging of QR code validation attempts for tickets
 * Stores hashed QR values to avoid storing raw QR data
 */

const pool = require('../db/index');

/**
 * Log a ticket validation attempt
 * @param {Object} params - Validation log parameters
 * @param {number} params.eventId - Event ID
 * @param {number|null} params.ticketId - Ticket ID (null if not found)
 * @param {string} params.qrHash - SHA256 hash of QR payload
 * @param {string} params.resultStatus - Validation result status
 * @param {number|null} params.scannedByUserId - User ID who scanned (optional)
 * @param {Object} params.metadata - Additional metadata
 * @returns {Promise<number>} - ID of the created validation log entry
 */
async function logValidationAttempt({
  eventId,
  ticketId,
  qrHash,
  resultStatus,
  scannedByUserId = null,
  metadata = {}
}, options = {}) {
  try {
    const db = options.client || pool;
    const query = `
      INSERT INTO ticket_validation_logs (
        event_id,
        ticket_id,
        qr_hash,
        result_status,
        scanned_by_user_id,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;

    const values = [
      eventId,
      ticketId,
      qrHash,
      resultStatus,
      scannedByUserId,
      metadata
    ];

    const result = await db.query(query, values);
    return result.rows[0].id;
  } catch (err) {
    console.error('Error logging validation attempt:', err);
    throw err;
  }
}

/**
 * Get validation logs for a ticket
 * @param {number} ticketId - Ticket ID
 * @returns {Promise<Array>} - Array of validation log entries
 */
async function getValidationLogsByTicket(ticketId) {
  try {
    const query = `
      SELECT
        tvl.*,
        u.name as scanner_name,
        u.email as scanner_email
      FROM ticket_validation_logs tvl
      LEFT JOIN users u ON u.id = tvl.scanned_by_user_id
      WHERE tvl.ticket_id = $1
      ORDER BY tvl.scanned_at DESC
    `;

    const result = await pool.query(query, [ticketId]);
    return result.rows;
  } catch (err) {
    console.error('Error fetching validation logs:', err);
    throw err;
  }
}

/**
 * Get validation logs for an event
 * @param {number} eventId - Event ID
 * @param {Object} options - Query options
 * @param {string} options.status - Filter by result status
 * @param {number} options.scannedByUserId - Filter by scanner user ID
 * @param {Date} options.dateFrom - Filter from date
 * @param {Date} options.dateTo - Filter to date
 * @param {number} options.page - Page number
 * @param {number} options.pageSize - Page size
 * @returns {Promise<Object>} - Object with logs and pagination info
 */
async function getValidationLogsByEvent(eventId, options = {}) {
  const {
    status,
    scannedByUserId,
    dateFrom,
    dateTo,
    page = 1,
    pageSize = 100
  } = options;

  try {
    let whereClause = 'WHERE tvl.event_id = $1';
    const params = [eventId];
    let paramCount = 1;

    if (status) {
      paramCount++;
      whereClause += ` AND tvl.result_status = $${paramCount}`;
      params.push(status);
    }

    if (scannedByUserId) {
      paramCount++;
      whereClause += ` AND tvl.scanned_by_user_id = $${paramCount}`;
      params.push(scannedByUserId);
    }

    if (dateFrom) {
      paramCount++;
      whereClause += ` AND tvl.scanned_at >= $${paramCount}`;
      params.push(dateFrom);
    }

    if (dateTo) {
      paramCount++;
      whereClause += ` AND tvl.scanned_at <= $${paramCount}`;
      params.push(dateTo);
    }

    const offset = (page - 1) * pageSize;
    paramCount++;
    const limitClause = `LIMIT $${paramCount}`;
    params.push(pageSize);

    paramCount++;
    const offsetClause = `OFFSET $${paramCount}`;
    params.push(offset);

    const query = `
      SELECT
        tvl.*,
        t.ticket_code,
        u.name as scanner_name,
        u.email as scanner_email
      FROM ticket_validation_logs tvl
      LEFT JOIN tickets t ON t.id = tvl.ticket_id
      LEFT JOIN users u ON u.id = tvl.scanned_by_user_id
      ${whereClause}
      ORDER BY tvl.scanned_at DESC
      ${limitClause} ${offsetClause}
    `;

    const result = await pool.query(query, params);

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM ticket_validation_logs tvl
      ${whereClause}
    `;

    const countResult = await pool.query(countQuery, params.slice(0, -2)); // Remove limit and offset params
    const total = parseInt(countResult.rows[0].total, 10);

    return {
      logs: result.rows,
      pagination: {
        page,
        pageSize,
        total
      }
    };
  } catch (err) {
    console.error('Error fetching validation logs:', err);
    throw err;
  }
}

/**
 * Get validation statistics for an event
 * @param {number} eventId - Event ID
 * @returns {Promise<Object>} - Validation statistics
 */
async function getValidationStatsByEvent(eventId) {
  try {
    const query = `
      SELECT
        result_status,
        COUNT(*) as count
      FROM ticket_validation_logs
      WHERE event_id = $1
      GROUP BY result_status
      ORDER BY count DESC
    `;

    const result = await pool.query(query, [eventId]);
    return result.rows;
  } catch (err) {
    console.error('Error fetching validation stats:', err);
    throw err;
  }
}

module.exports = {
  logValidationAttempt,
  getValidationLogsByTicket,
  getValidationLogsByEvent,
  getValidationStatsByEvent
};
