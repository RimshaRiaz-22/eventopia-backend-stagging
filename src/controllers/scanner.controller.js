/**
 * Scanner Controller
 *
 * Handles QR code validation and check-in for tickets
 * Used by promoters to scan and validate tickets at events
 */

const pool = require('../db/index');
const crypto = require('crypto');
const { ok, fail } = require('../utils/standardResponse');
const { generateTicketQR, verifyTicketQR } = require('../services/qr.service');
const { logTicketAudit } = require('../services/audit.service');
const { logValidationAttempt } = require('../services/validationLog.service');

/**
 * Validate a ticket QR code
 * POST /api/scanner/validate
 */
async function validateTicket(req, res) {
  const client = await pool.connect();
  try {
    const { qrPayload } = req.body;

    if (!qrPayload) {
      return fail(res, req, 400, "MISSING_PAYLOAD", "QR payload is required");
    }

    // Verify QR signature
    const decoded = verifyTicketQR(qrPayload);

    if (!decoded) {
      // Log failed validation
      await logTicketAudit(req.user?.id, null, null, 'VALIDATE_FAIL', null, null, { reason: 'invalid_signature' });
      return fail(res, req, 400, "INVALID_QR", "Invalid or tampered QR code");
    }

    const { sub: ticketId, event_id } = decoded;

    // Fetch ticket with buyer info
    const query = `
      SELECT
        t.*,
        tt.name as "ticketTypeName",
        u.name as "buyerName",
        u.email as "buyerEmail"
      FROM tickets t
      LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
      LEFT JOIN users u ON u.id = t.user_id
      WHERE t.id = $1
    `;

    const result = await pool.query(query, [ticketId]);

    if (result.rows.length === 0) {
      await logTicketAudit(req.user?.id, ticketId, event_id, 'VALIDATE_FAIL', null, null, { reason: 'not_found' });
      return fail(res, req, 404, "TICKET_NOT_FOUND", "Ticket not found");
    }

    const ticket = result.rows[0];

    // Validate ticket belongs to event (compare as strings)
    if (String(ticket.event_id) !== event_id) {
      await logTicketAudit(req.user?.id, ticketId, ticket.event_id, 'VALIDATE_FAIL', null, null, { reason: 'wrong_event', expected: event_id, actual: ticket.event_id });
      return fail(res, req, 400, "WRONG_EVENT", "This ticket is not for this event");
    }

    // Check status - allow ACTIVE and USED (for showing "already used")
    if (!['ACTIVE', 'USED'].includes(ticket.status)) {
      await logTicketAudit(req.user?.id, ticketId, ticket.event_id, 'VALIDATE_FAIL', ticket.status, null, { reason: 'invalid_status', status: ticket.status });
      return fail(res, req, 400, "INVALID_STATUS", `Ticket status is ${ticket.status}`);
    }

    // Log validation
    await logTicketAudit(req.user?.id, ticketId, ticket.event_id, 'VALIDATED', ticket.status, null);

    return ok(res, req, {
      valid: true,
      status: ticket.status,
      ticket: {
        id: ticket.id,
        ticketCode: ticket.ticket_code,
        typeName: ticket.ticketTypeName,
        buyerName: ticket.buyerName || ticket.buyer_name,
        buyerEmail: ticket.buyerEmail || ticket.buyer_email,
        usedAt: ticket.used_at
      }
    });

  } catch (err) {
    console.error('Scanner validation error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Check-in a ticket (mark as USED)
 * POST /api/scanner/checkin
 */
async function checkInTicket(req, res) {
  const client = await pool.connect();

  try {
    const { qrPayload } = req.body;

    if (!qrPayload) {
      return fail(res, req, 400, "MISSING_PAYLOAD", "QR payload is required");
    }

    // Verify QR signature
    const decoded = verifyTicketQR(qrPayload);

    if (!decoded) {
      return fail(res, req, 400, "INVALID_QR", "Invalid or tampered QR code");
    }

    const { sub: ticketId, event_id } = decoded;

    await client.query('BEGIN');

    // Lock ticket row for update (prevents race condition)
    const lockQuery = `
      SELECT id, status, used_at, event_id, ticket_code
      FROM tickets
      WHERE id = $1
      FOR UPDATE
    `;

    const lockResult = await client.query(lockQuery, [ticketId]);

    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return fail(res, req, 404, "TICKET_NOT_FOUND", "Ticket not found");
    }

    const ticket = lockResult.rows[0];

    // Validate event match (compare as strings)
    if (String(ticket.event_id) !== event_id) {
      await client.query('ROLLBACK');
      await logTicketAudit(req.user?.id, ticketId, ticket.event_id, 'VALIDATE_FAIL', null, null, { reason: 'wrong_event' });
      return fail(res, req, 400, "WRONG_EVENT", "This ticket is not for this event");
    }

    // Check if already used
    if (ticket.status === 'USED') {
      await client.query('COMMIT');
      return ok(res, req, {
        success: false,
        message: "Ticket already used",
        ticket: {
          id: ticket.id,
          ticketCode: ticket.ticket_code,
          status: ticket.status,
          usedAt: ticket.used_at
        }
      });
    }

    // Check if ACTIVE
    if (ticket.status !== 'ACTIVE') {
      await client.query('COMMIT');
      return fail(res, req, 400, "INVALID_STATUS", `Cannot check-in ticket with status ${ticket.status}`);
    }

    // Update ticket to USED
    const updateQuery = `
      UPDATE tickets
      SET status = 'USED', used_at = NOW()
      WHERE id = $1
      RETURNING status, used_at
    `;

    const updateResult = await client.query(updateQuery, [ticketId]);
    const updatedTicket = updateResult.rows[0];

    // Insert checkin record
    const checkinQuery = `
      INSERT INTO checkins (ticket_id, event_id, promoter_user_id, scanned_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING *
    `;

    await client.query(checkinQuery, [ticketId, ticket.event_id, req.user.id]);

    // Log audit trail
    await logTicketAudit(req.user?.id, ticketId, ticket.event_id, 'CHECKED_IN', 'ACTIVE', 'USED');

    await client.query('COMMIT');

    return ok(res, req, {
      success: true,
      ticket: {
        id: ticket.id,
        ticketCode: ticket.ticket_code,
        status: updatedTicket.status,
        usedAt: updatedTicket.used_at
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Check-in error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Get check-in history for a ticket
 * GET /api/scanner/tickets/:ticketId/checkins
 */
async function getTicketCheckins(req, res) {
  try {
    const { ticketId } = req.params;
    const ticketIdNum = parseInt(ticketId, 10);

    if (isNaN(ticketIdNum) || ticketIdNum <= 0) {
      return fail(res, req, 404, "INVALID_TICKET_ID", "Invalid ticket ID");
    }

    const query = `
      SELECT
        c.*,
        u.name as "promoterName",
        u.email as "promoterEmail"
      FROM checkins c
      LEFT JOIN users u ON u.id = c.promoter_user_id
      WHERE c.ticket_id = $1
      ORDER BY c.scanned_at DESC
    `;

    const result = await pool.query(query, [ticketIdNum]);

    return ok(res, req, {
      checkins: result.rows.map(row => ({
        id: row.id,
        scannedAt: row.scanned_at,
        gateId: row.gate_id,
        promoter: {
          name: row.promoterName,
          email: row.promoterEmail
        }
      }))
    });

  } catch (err) {
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get attendees for an event (with filtering and search)
 * GET /api/promoter/events/:eventId/attendees
 */
async function getEventAttendees(req, res) {
  const client = await pool.connect();
  try {
    const { eventId } = req.params;
    const eventIdNum = parseInt(eventId, 10);

    if (isNaN(eventIdNum) || eventIdNum <= 0) {
      return fail(res, req, 404, "INVALID_EVENT_ID", "Invalid event ID");
    }

    const {
      ticket_type_id,
      status,
      search,
      page = 1,
      page_size = 50
    } = req.query;

    const pageNum = parseInt(page, 10);
    const sizeNum = Math.min(parseInt(page_size, 10), 100);
    const offset = (pageNum - 1) * sizeNum;

    let whereClause = 'WHERE t.event_id = $1';
    const queryParams = [eventIdNum];
    let paramCount = 1;

    // Filter by ticket type
    if (ticket_type_id && ticket_type_id !== 'all') {
      paramCount++;
      whereClause += ` AND t.ticket_type_id = $${paramCount}`;
      queryParams.push(parseInt(ticket_type_id, 10));
    }

    // Filter by status
    if (status && status !== 'all') {
      paramCount++;
      whereClause += ` AND t.status = $${paramCount}`;
      queryParams.push(status.toUpperCase());
    }

    // Search filter (name, email, order ID, ticket ID)
    if (search && search.trim()) {
      paramCount++;
      const searchTerm = `%${search.trim()}%`;
      whereClause += ` AND (
        t.buyer_name ILIKE $${paramCount} OR
        t.buyer_email ILIKE $${paramCount} OR
        o.order_number ILIKE $${paramCount} OR
        t.ticket_code ILIKE $${paramCount}
      )`;
      queryParams.push(searchTerm);
    }

    // Main query
    const query = `
      SELECT
        t.id,
        t.ticket_code as "ticketCode",
        t.buyer_name as "buyerName",
        t.buyer_email as "buyerEmail",
        t.status,
        t.used_at as "usedAt",
        tt.name as "ticketType",
        o.order_number as "orderId"
      FROM tickets t
      LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
      LEFT JOIN orders o ON o.id = t.order_id
      LEFT JOIN users u ON u.id = t.user_id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    queryParams.push(sizeNum, offset);

    const result = await client.query(query, queryParams);

    // Summary counts
    const summaryQuery = `
      SELECT
        COUNT(*) as "soldCount",
        SUM(CASE WHEN t.status = 'USED' THEN 1 ELSE 0 END) as "checkedInCount",
        SUM(CASE WHEN t.status = 'ACTIVE' THEN 1 ELSE 0 END) as "activeCount",
        SUM(CASE WHEN t.status IN ('REFUNDED', 'CANCELLED') THEN 1 ELSE 0 END) as "refundedCount"
      FROM tickets t
      ${whereClause}
    `;

    const summaryParams = queryParams.slice(0, -2);
    const summaryResult = await client.query(summaryQuery, summaryParams);

    return ok(res, req, {
      attendees: result.rows,
      summary: summaryResult.rows[0],
      pagination: {
        page: pageNum,
        pageSize: sizeNum,
        total: parseInt(summaryResult.rows[0].soldCount, 10)
      }
    });

  } catch (err) {
    console.error('Get attendees error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Validate a ticket for an event (event-scoped)
 * POST /api/promoter/events/:eventId/validate
 */
async function validateEventTicket(req, res) {
  const client = await pool.connect();
  try {
    const { eventId } = req.params;
    const eventIdNum = parseInt(eventId, 10);

    if (isNaN(eventIdNum) || eventIdNum <= 0) {
      return fail(res, req, 404, "INVALID_EVENT_ID", "Invalid event ID");
    }

    const { qrPayload, ticketCode, method = 'CAMERA' } = req.body;

    if (!qrPayload && !ticketCode) {
      return fail(res, req, 400, "MISSING_PAYLOAD", "QR payload or ticket code is required");
    }

    let ticketId;
    let decoded;
    const clientIp = req.ip || req.connection.remoteAddress;
    const deviceId = req.headers['x-device-id'] || req.headers['x-device-id'.toLowerCase()];

    // Handle QR payload
    if (qrPayload) {
      decoded = verifyTicketQR(qrPayload);
      if (!decoded) {
        const validationLogId = await logValidationAttempt({
          eventId: eventIdNum,
          ticketId: null,
          qrHash: crypto.createHash('sha256').update(qrPayload).digest('hex'),
          resultStatus: 'INVALID_QR',
          scannedByUserId: req.user?.id,
          metadata: { method, deviceId }
        });
        await logTicketAudit(req.user?.id, null, eventIdNum, 'VALIDATE_FAIL', null, null, { reason: 'invalid_signature', method });
        return fail(res, req, 400, "INVALID_QR", "Invalid or tampered QR code");
      }
      ticketId = parseInt(decoded.sub, 10);
    } else if (ticketCode) {
      // Look up ticket by code
      const ticketQuery = `SELECT id FROM tickets WHERE ticket_code = $1 AND event_id = $2`;
      const ticketResult = await client.query(ticketQuery, [ticketCode, eventIdNum]);

      if (ticketResult.rows.length === 0) {
        const validationLogId = await logValidationAttempt({
          eventId: eventIdNum,
          ticketId: null,
          qrHash: crypto.createHash('sha256').update(ticketCode).digest('hex'),
          resultStatus: 'NOT_FOUND',
          scannedByUserId: req.user?.id,
          metadata: { method, deviceId }
        });
        await logTicketAudit(req.user?.id, null, eventIdNum, 'VALIDATE_FAIL', null, null, { reason: 'not_found', ticketCode, method });
        return fail(res, req, 404, "TICKET_NOT_FOUND", "Ticket not found");
      }
      ticketId = ticketResult.rows[0].id;
    }

    // Fetch ticket with buyer info
    const query = `
      SELECT
        t.*,
        tt.name as "ticketTypeName",
        u.name as "buyerName",
        u.email as "buyerEmail"
      FROM tickets t
      LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
      LEFT JOIN users u ON u.id = t.user_id
      WHERE t.id = $1 AND t.event_id = $2
    `;

    const result = await client.query(query, [ticketId, eventIdNum]);

    if (result.rows.length === 0) {
      const validationLogId = await logValidationAttempt({
        eventId: eventIdNum,
        ticketId: ticketId,
        qrHash: crypto.createHash('sha256').update(qrPayload || ticketCode).digest('hex'),
        resultStatus: 'NOT_FOUND',
        scannedByUserId: req.user?.id,
        metadata: { method, deviceId }
      });
      await logTicketAudit(req.user?.id, ticketId, eventIdNum, 'VALIDATE_FAIL', null, null, { reason: 'not_found', method });
      return fail(res, req, 404, "TICKET_NOT_FOUND", "Ticket not found");
    }

    const ticket = result.rows[0];

    // Check if event is cancelled
    const eventCheck = await client.query(
      'SELECT status FROM events WHERE id = $1',
      [eventIdNum]
    );
    if (eventCheck.rows[0]?.status === 'cancelled') {
      const validationLogId = await logValidationAttempt({
        eventId: eventIdNum,
        ticketId: ticketId,
        qrHash: crypto.createHash('sha256').update(qrPayload || ticketCode).digest('hex'),
        resultStatus: 'CANCELLED_EVENT',
        scannedByUserId: req.user?.id,
        metadata: { method, deviceId }
      });
      await logTicketAudit(req.user?.id, ticketId, eventIdNum, 'VALIDATE_FAIL', ticket.status, null, { reason: 'cancelled_event', status: ticket.status, method });
      return fail(res, req, 400, "CANCELLED_EVENT", "Event has been cancelled");
    }

    // Check status - allow ACTIVE and USED (for showing "already used")
    if (!['ACTIVE', 'USED'].includes(ticket.status)) {
      const validationLogId = await logValidationAttempt({
        eventId: eventIdNum,
        ticketId: ticketId,
        qrHash: crypto.createHash('sha256').update(qrPayload || ticketCode).digest('hex'),
        resultStatus: ticket.status === 'USED' ? 'ALREADY_USED' : 'INVALID_STATUS',
        scannedByUserId: req.user?.id,
        metadata: { method, deviceId }
      });
      await logTicketAudit(req.user?.id, ticketId, eventIdNum, 'VALIDATE_FAIL', ticket.status, null, { reason: 'invalid_status', status: ticket.status, method });
      return fail(res, req, 400, "INVALID_STATUS", `Ticket status is ${ticket.status}`);
    }

    // Log validation
    const validationLogId = await logValidationAttempt({
      eventId: eventIdNum,
      ticketId: ticketId,
      qrHash: crypto.createHash('sha256').update(qrPayload || ticketCode).digest('hex'),
      resultStatus: ticket.status === 'USED' ? 'ALREADY_USED' : 'VALID',
      scannedByUserId: req.user?.id,
      metadata: { method, deviceId }
    });
    await logTicketAudit(req.user?.id, ticketId, eventIdNum, 'VALIDATED', ticket.status, null, { method, validationLogId });

    return ok(res, req, {
      valid: true,
      status: ticket.status === 'USED' ? 'ALREADY_USED' : 'VALID',
      ticket: {
        id: ticket.id,
        ticketCode: ticket.ticket_code,
        typeName: ticket.ticketTypeName,
        buyerName: ticket.buyerName || ticket.buyer_name,
        buyerEmail: ticket.buyerEmail || ticket.buyer_email,
        usedAt: ticket.used_at
      }
    });

  } catch (err) {
    console.error('Event ticket validation error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Check-in a ticket for an event (event-scoped)
 * POST /api/promoter/events/:eventId/checkin
 */
async function checkInEventTicket(req, res) {
  const client = await pool.connect();

  try {
    const { eventId } = req.params;
    const eventIdNum = parseInt(eventId, 10);

    if (isNaN(eventIdNum) || eventIdNum <= 0) {
      return fail(res, req, 404, "INVALID_EVENT_ID", "Invalid event ID");
    }

    const { qrPayload, ticketCode, method = 'CAMERA' } = req.body;

    if (!qrPayload && !ticketCode) {
      return fail(res, req, 400, "MISSING_PAYLOAD", "QR payload or ticket code is required");
    }

    let ticketId;
    let decoded;
    const deviceId = req.headers['x-device-id'] || req.headers['x-device-id'.toLowerCase()];

    // Handle QR payload
    if (qrPayload) {
      decoded = verifyTicketQR(qrPayload);
      if (!decoded) {
        const validationLogId = await logValidationAttempt({
          eventId: eventIdNum,
          ticketId: null,
          qrHash: crypto.createHash('sha256').update(qrPayload).digest('hex'),
          resultStatus: 'INVALID_QR',
          scannedByUserId: req.user?.id,
          metadata: { method, deviceId }
        });
        return fail(res, req, 400, "INVALID_QR", "Invalid or tampered QR code");
      }
      ticketId = parseInt(decoded.sub, 10);
    } else if (ticketCode) {
      // Look up ticket by code
      const ticketQuery = `SELECT id FROM tickets WHERE ticket_code = $1 AND event_id = $2`;
      const ticketResult = await client.query(ticketQuery, [ticketCode, eventIdNum]);

      if (ticketResult.rows.length === 0) {
        const validationLogId = await logValidationAttempt({
          eventId: eventIdNum,
          ticketId: null,
          qrHash: crypto.createHash('sha256').update(ticketCode).digest('hex'),
          resultStatus: 'NOT_FOUND',
          scannedByUserId: req.user?.id,
          metadata: { method, deviceId }
        });
        return fail(res, req, 404, "TICKET_NOT_FOUND", "Ticket not found");
      }
      ticketId = ticketResult.rows[0].id;
    }

    await client.query('BEGIN');

    // Lock ticket row for update (prevents race condition)
    const lockQuery = `
      SELECT id, status, used_at, event_id, ticket_code
      FROM tickets
      WHERE id = $1
      FOR UPDATE
    `;

    const lockResult = await client.query(lockQuery, [ticketId]);

    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      const validationLogId = await logValidationAttempt({
        eventId: eventIdNum,
        ticketId: ticketId,
        qrHash: crypto.createHash('sha256').update(qrPayload || ticketCode).digest('hex'),
        resultStatus: 'NOT_FOUND',
        scannedByUserId: req.user?.id,
        metadata: { method, deviceId }
      });
      return fail(res, req, 404, "TICKET_NOT_FOUND", "Ticket not found");
    }

    const ticket = lockResult.rows[0];

    // Validate event match (compare as strings)
    if (String(ticket.event_id) !== String(eventIdNum)) {
      await client.query('ROLLBACK');
      const validationLogId = await logValidationAttempt({
        eventId: eventIdNum,
        ticketId: ticketId,
        qrHash: crypto.createHash('sha256').update(qrPayload || ticketCode).digest('hex'),
        resultStatus: 'WRONG_EVENT',
        scannedByUserId: req.user?.id,
        metadata: { method, deviceId }
      });
      return fail(res, req, 400, "WRONG_EVENT", "This ticket is not for this event");
    }

    // Check if already used
    if (ticket.status === 'USED') {
      await client.query('COMMIT');
      // Log validation attempt
      await logValidationAttempt({
        eventId: eventIdNum,
        ticketId: ticketId,
        qrHash: crypto.createHash('sha256').update(qrPayload || ticketCode).digest('hex'),
        resultStatus: 'ALREADY_USED',
        scannedByUserId: req.user?.id,
        metadata: { method, deviceId }
      });
      return ok(res, req, {
        success: false,
        status: 'ALREADY_USED',
        message: "Ticket already used",
        ticket: {
          id: ticket.id,
          ticketCode: ticket.ticket_code,
          status: ticket.status,
          usedAt: ticket.used_at
        }
      });
    }

    // Check if ACTIVE
    if (ticket.status !== 'ACTIVE') {
      await client.query('COMMIT');
      // Log validation attempt
      await logValidationAttempt({
        eventId: eventIdNum,
        ticketId: ticketId,
        qrHash: crypto.createHash('sha256').update(qrPayload || ticketCode).digest('hex'),
        resultStatus: 'INVALID_STATUS',
        scannedByUserId: req.user?.id,
        metadata: { method, deviceId }
      });
      return fail(res, req, 400, "INVALID_STATUS", `Cannot check-in ticket with status ${ticket.status}`);
    }

    // Log validation before check-in
    const validationLogId = await logValidationAttempt({
      eventId: eventIdNum,
      ticketId: ticketId,
      qrHash: crypto.createHash('sha256').update(qrPayload || ticketCode).digest('hex'),
      resultStatus: 'VALID',
      scannedByUserId: req.user?.id,
      metadata: { method, deviceId }
    });

    // Update ticket to USED with scanner info and validation log
    const updateQuery = `
      UPDATE tickets
      SET status = 'USED', used_at = NOW(), used_by_user_id = $2, validation_log_id = $3
      WHERE id = $1
      RETURNING status, used_at, used_by_user_id, validation_log_id
    `;

    const updateResult = await client.query(updateQuery, [ticketId, req.user.id, validationLogId]);
    const updatedTicket = updateResult.rows[0];

    // Get client IP and device info
    const clientIp = req.ip || req.connection.remoteAddress;

    // Insert checkin record with method and device info
    const checkinQuery = `
      INSERT INTO checkins (ticket_id, event_id, promoter_user_id, scanned_at, method, device_id, ip)
      VALUES ($1, $2, $3, NOW(), $4, $5, $6)
      RETURNING *
    `;

    await client.query(checkinQuery, [ticketId, eventIdNum, req.user.id, method, deviceId, clientIp]);

    // Log audit trail
    await logTicketAudit(req.user?.id, ticketId, eventIdNum, 'CHECKED_IN', 'ACTIVE', 'USED', { method, deviceId, validationLogId });

    await client.query('COMMIT');

    return ok(res, req, {
      success: true,
      status: 'VALID',
      ticket: {
        id: ticket.id,
        ticketCode: ticket.ticket_code,
        status: updatedTicket.status,
        usedAt: updatedTicket.used_at
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Event check-in error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Undo check-in for a ticket (promoter owner only)
 * POST /api/promoter/events/:eventId/checkin/undo
 */
async function undoCheckIn(req, res) {
  const client = await pool.connect();

  try {
    const { eventId } = req.params;
    const eventIdNum = parseInt(eventId, 10);

    if (isNaN(eventIdNum) || eventIdNum <= 0) {
      return fail(res, req, 404, "INVALID_EVENT_ID", "Invalid event ID");
    }

    const { ticketId, ticketCode } = req.body;

    if (!ticketId && !ticketCode) {
      return fail(res, req, 400, "MISSING_PAYLOAD", "Ticket ID or ticket code is required");
    }

    let ticketQuery = `
      SELECT id, status, event_id, ticket_code
      FROM tickets
      WHERE id = $1 AND event_id = $2
    `;
    let queryParams = [parseInt(ticketId, 10), eventIdNum];

    if (ticketCode) {
      ticketQuery = `
        SELECT id, status, event_id, ticket_code
        FROM tickets
        WHERE ticket_code = $1 AND event_id = $2
      `;
      queryParams = [ticketCode, eventIdNum];
    }

    await client.query('BEGIN');

    // Lock ticket row for update
    const lockResult = await client.query(ticketQuery, queryParams);

    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return fail(res, req, 404, "TICKET_NOT_FOUND", "Ticket not found");
    }

    const ticket = lockResult.rows[0];

    // Verify event match
    if (String(ticket.event_id) !== String(eventIdNum)) {
      await client.query('ROLLBACK');
      return fail(res, req, 400, "WRONG_EVENT", "This ticket is not for this event");
    }

    // Check if USED (can only undo if used)
    if (ticket.status !== 'USED') {
      await client.query('COMMIT');
      return fail(res, req, 400, "INVALID_STATUS", `Cannot undo check-in for ticket with status ${ticket.status}`);
    }

    // Update ticket back to ACTIVE
    const updateQuery = `
      UPDATE tickets
      SET status = 'ACTIVE', used_at = NULL
      WHERE id = $1
      RETURNING status, used_at
    `;

    const updateResult = await client.query(updateQuery, [ticket.id]);
    const updatedTicket = updateResult.rows[0];

    // Log audit trail
    await logTicketAudit(req.user?.id, ticket.id, eventIdNum, 'UNDO_CHECKIN', 'USED', 'ACTIVE');

    await client.query('COMMIT');

    return ok(res, req, {
      success: true,
      ticket: {
        id: ticket.id,
        ticketCode: ticket.ticket_code,
        status: updatedTicket.status,
        usedAt: updatedTicket.used_at
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Undo check-in error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
}

/**
 * Get audit logs for an event
 * GET /api/promoter/events/:eventId/logs
 */
async function getEventLogs(req, res) {
  try {
    const { eventId } = req.params;
    const eventIdNum = parseInt(eventId, 10);

    if (isNaN(eventIdNum) || eventIdNum <= 0) {
      return fail(res, req, 404, "INVALID_EVENT_ID", "Invalid event ID");
    }

    const {
      action,
      operator_user_id,
      date_from,
      date_to,
      page = 1,
      page_size = 100
    } = req.query;

    const pageNum = parseInt(page, 10);
    const sizeNum = Math.min(parseInt(page_size, 10), 200);
    const offset = (pageNum - 1) * sizeNum;

    let whereClause = 'WHERE tal.event_id = $1';
    const queryParams = [eventIdNum];
    let paramCount = 1;

    // Filter by action
    if (action && action !== 'all') {
      paramCount++;
      whereClause += ` AND tal.action = $${paramCount}`;
      queryParams.push(action.toUpperCase());
    }

    // Filter by operator
    if (operator_user_id) {
      paramCount++;
      whereClause += ` AND tal.actor_user_id = $${paramCount}`;
      queryParams.push(parseInt(operator_user_id, 10));
    }

    // Filter by date range
    if (date_from) {
      paramCount++;
      whereClause += ` AND tal.created_at >= $${paramCount}`;
      queryParams.push(new Date(date_from));
    }

    if (date_to) {
      paramCount++;
      whereClause += ` AND tal.created_at <= $${paramCount}`;
      queryParams.push(new Date(date_to));
    }

    // Main query
    const query = `
      SELECT
        tal.created_at as "time",
        tal.action,
        tal.ticket_id as "ticketId",
        t.ticket_code,
        COALESCE(u.name, tal.metadata->>'buyerName') as "buyer",
        u2.name as "operator",
        tal.metadata
      FROM ticket_audit_logs tal
      LEFT JOIN tickets t ON t.id = tal.ticket_id
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN users u2 ON u2.id = tal.actor_user_id
      ${whereClause}
      ORDER BY tal.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    queryParams.push(sizeNum, offset);

    const result = await pool.query(query, queryParams);

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM ticket_audit_logs tal
      ${whereClause}
    `;

    const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
    const total = parseInt(countResult.rows[0].total, 10);

    return ok(res, req, {
      logs: result.rows,
      pagination: {
        page: pageNum,
        pageSize: sizeNum,
        total: total
      }
    });

  } catch (err) {
    console.error('Get event logs error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

module.exports = {
  validateTicket,
  checkInTicket,
  getTicketCheckins,
  getEventAttendees,
  validateEventTicket,
  checkInEventTicket,
  undoCheckIn,
  getEventLogs
};
