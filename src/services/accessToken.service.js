const crypto = require('crypto');
const pool = require('../db');
const { fail, ok } = require('../utils/standardResponse');

/**
 * Generate a cryptographically secure random token
 * @returns {string} Base64URL encoded token
 */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Hash a token for storage
 * @param {string} token - Raw token
 * @returns {string} SHA-256 hash
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Check if a ticket is eligible for access
 * @param {Object} ticket - Ticket data
 * @param {Object} event - Event data
 * @param {Object} ticketType - Ticket type data
 * @param {Date} now - Current time
 * @returns {Object} { allowed: boolean, reason_code: string, available_at: Date|null }
 */
async function checkAccessEligibility(ticket, event, ticketType, now = new Date()) {
  // Check ticket status
  if (['REFUNDED', 'CANCELLED', 'VOID'].includes(ticket.status)) {
    return {
      allowed: false,
      reason_code: 'TICKET_INVALID',
      available_at: null
    };
  }

  // Allow access for ACTIVE or USED tickets
  if (!['ACTIVE', 'USED'].includes(ticket.status)) {
    return {
      allowed: false,
      reason_code: 'TICKET_INVALID',
      available_at: null
    };
  }

  // Check access mode
  switch (ticketType.access_mode) {
    case 'IN_PERSON':
      return {
        allowed: false,
        reason_code: 'IN_PERSON_ONLY',
        available_at: null
      };

    case 'ONLINE_LIVE':
      const eventStart = new Date(event.start_at);
      const revealRule = ticketType.reveal_rule;

      if (revealRule === 'AT_PURCHASE') {
        return {
          allowed: true,
          reason_code: 'AVAILABLE',
          available_at: null
        };
      } else if (revealRule === 'ONE_HOUR_BEFORE') {
        const availableAt = new Date(eventStart.getTime() - 60 * 60 * 1000);
        return {
          allowed: now >= availableAt,
          reason_code: now >= availableAt ? 'AVAILABLE' : 'LOCKED',
          available_at: availableAt
        };
      } else if (revealRule === 'AT_START') {
        const availableAt = eventStart;
        return {
          allowed: now >= availableAt,
          reason_code: now >= availableAt ? 'AVAILABLE' : 'LOCKED',
          available_at: availableAt
        };
      }
      break;

    case 'ON_DEMAND':
      const windowStart = ticketType.on_demand_start_at ? new Date(ticketType.on_demand_start_at) : null;
      const windowEnd = ticketType.on_demand_end_at ? new Date(ticketType.on_demand_end_at) : null;

      if (!windowStart || !windowEnd) {
        return {
          allowed: false,
          reason_code: 'WINDOW_NOT_SET',
          available_at: null
        };
      }

      if (now < windowStart) {
        return {
          allowed: false,
          reason_code: 'WINDOW_NOT_STARTED',
          available_at: windowStart
        };
      } else if (now > windowEnd) {
        return {
          allowed: false,
          reason_code: 'WINDOW_ENDED',
          available_at: null
        };
      } else {
        return {
          allowed: true,
          reason_code: 'AVAILABLE',
          available_at: null
        };
      }

    default:
      return {
        allowed: false,
        reason_code: 'UNKNOWN_MODE',
        available_at: null
      };
  }
}

/**
 * Create a new access token for a ticket
 * @param {number} ticketId - Ticket ID
 * @param {string} purpose - LIVE_JOIN or ONDEMAND_VIEW
 * @param {number} expiresInMinutes - Token lifetime in minutes
 * @param {Object} metadata - Additional metadata (ip, userAgent, userId)
 * @returns {Object} { token: string, expires_at: Date }
 */
async function createAccessToken(ticketId, purpose, expiresInMinutes = 15, metadata = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get ticket, event, and ticket type info
    const ticketResult = await client.query(
      `SELECT t.*, e.id as event_id, e.access_link_version, e.live_access_url, e.ondemand_access_url,
              tt.access_mode, tt.reveal_rule, tt.on_demand_start_at, tt.on_demand_end_at
       FROM tickets t
       JOIN events e ON t.event_id = e.id
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       WHERE t.id = $1`,
      [ticketId]
    );

    if (ticketResult.rowCount === 0) {
      throw new Error('TICKET_NOT_FOUND');
    }

    const { event_id, access_link_version } = ticketResult.rows[0];

    // Generate token
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

    // Insert token
    const tokenResult = await client.query(
      `INSERT INTO access_tokens
       (ticket_id, event_id, token_hash, purpose, expires_at, version_at_issue, ip_address, user_agent, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        ticketId,
        event_id,
        tokenHash,
        purpose,
        expiresAt,
        access_link_version,
        metadata.ip || null,
        metadata.userAgent || null,
        metadata.userId || null
      ]
    );

    await client.query('COMMIT');

    return {
      token: rawToken,
      tokenId: tokenResult.rows[0].id,
      expires_at: expiresAt
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Validate and resolve an access token
 * @param {string} token - Raw token to validate
 * @returns {Object|null} Access token data or null if invalid
 */
async function resolveAccessToken(token) {
  const tokenHash = hashToken(token);

  const result = await pool.query(
    `SELECT at.*, e.live_access_url, e.ondemand_access_url, e.access_link_version,
            t.status as ticket_status, t.event_id
     FROM access_tokens at
     JOIN events e ON at.event_id = e.id
     JOIN tickets t ON at.ticket_id = t.id
     WHERE at.token_hash = $1`,
    [tokenHash]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const tokenData = result.rows[0];

  // Check if token is revoked
  if (tokenData.revoked_at) {
    return null;
  }

  // Check if token is expired
  if (new Date() > new Date(tokenData.expires_at)) {
    return null;
  }

  // Check if ticket is valid
  if (['REFUNDED', 'CANCELLED', 'VOID'].includes(tokenData.ticket_status)) {
    return null;
  }

  // Check if access link has been rotated
  if (tokenData.version_at_issue !== tokenData.access_link_version) {
    return null;
  }

  // Update access count and last accessed
  await pool.query(
    `UPDATE access_tokens
     SET access_count = access_count + 1, last_accessed_at = NOW()
     WHERE id = $1`,
    [tokenData.id]
  );

  // Return the appropriate URL
  const redirectUrl = tokenData.purpose === 'LIVE_JOIN'
    ? tokenData.live_access_url
    : tokenData.ondemand_access_url;

  return {
    redirectUrl,
    purpose: tokenData.purpose,
    ticketId: tokenData.ticket_id
  };
}

/**
 * Rotate access links for an event (invalidate all existing tokens)
 * @param {number} eventId - Event ID
 * @param {number} userId - User performing the rotation
 * @returns {Promise<number>} Number of tokens revoked
 */
async function rotateAccessLinks(eventId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Increment access_link_version
    const versionResult = await client.query(
      `UPDATE events
       SET access_link_version = access_link_version + 1
       WHERE id = $1
       RETURNING access_link_version`,
      [eventId]
    );

    if (versionResult.rowCount === 0) {
      throw new Error('EVENT_NOT_FOUND');
    }

    const newVersion = versionResult.rows[0].access_link_version;

    // Revoke all active tokens
    const revokeResult = await client.query(
      `UPDATE access_tokens
       SET revoked_at = NOW()
       WHERE event_id = $1 AND revoked_at IS NULL`,
      [eventId]
    );

    await client.query('COMMIT');

    return revokeResult.rowCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get access settings for an event
 * @param {number} eventId - Event ID
 * @returns {Object} Event access settings
 */
async function getAccessSettings(eventId) {
  const result = await pool.query(
    `SELECT e.id, e.live_access_url, e.ondemand_access_url, e.access_link_version,
            tt.id as ticket_type_id, tt.name, tt.access_mode, tt.reveal_rule,
            tt.on_demand_start_at, tt.on_demand_end_at
     FROM events e
     LEFT JOIN ticket_types tt ON e.id = tt.event_id
     WHERE e.id = $1`,
    [eventId]
  );

  if (result.rowCount === 0) {
    throw new Error('EVENT_NOT_FOUND');
  }

  const eventData = result.rows[0];

  const ticketTypes = result.rows
    .filter(row => row.ticket_type_id !== null)
    .map(row => ({
      id: row.ticket_type_id,
      name: row.name,
      access_mode: row.access_mode,
      reveal_rule: row.reveal_rule,
      on_demand_start_at: row.on_demand_start_at,
      on_demand_end_at: row.on_demand_end_at
    }));

  return {
    eventId: eventData.id,
    live_access_url: eventData.live_access_url,
    ondemand_access_url: eventData.ondemand_access_url,
    access_link_version: eventData.access_link_version,
    ticket_types: ticketTypes
  };
}

/**
 * Update access settings for an event
 * @param {number} eventId - Event ID
 * @param {Object} settings - Settings to update
 * @returns {Promise<void>}
 */
async function updateAccessSettings(eventId, settings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update event-level settings
    if (settings.live_access_url !== undefined || settings.ondemand_access_url !== undefined) {
      const updateFields = [];
      const updateValues = [];
      let paramCount = 1;

      if (settings.live_access_url !== undefined) {
        updateFields.push(`live_access_url = $${paramCount++}`);
        updateValues.push(settings.live_access_url);
      }

      if (settings.ondemand_access_url !== undefined) {
        updateFields.push(`ondemand_access_url = $${paramCount++}`);
        updateValues.push(settings.ondemand_access_url);
      }

      updateValues.push(eventId);

      await client.query(
        `UPDATE events SET ${updateFields.join(', ')} WHERE id = $${paramCount}`,
        updateValues
      );
    }

    // Update ticket type settings
    if (settings.ticket_types && settings.ticket_types.length > 0) {
      for (const tt of settings.ticket_types) {
        const updateFields = [];
        const updateValues = [];
        let paramCount = 1;

        if (tt.access_mode !== undefined) {
          updateFields.push(`access_mode = $${paramCount++}`);
          updateValues.push(tt.access_mode);
        }

        if (tt.reveal_rule !== undefined) {
          updateFields.push(`reveal_rule = $${paramCount++}`);
          updateValues.push(tt.reveal_rule);
        }

        if (tt.on_demand_start_at !== undefined) {
          updateFields.push(`on_demand_start_at = $${paramCount++}`);
          updateValues.push(tt.on_demand_start_at);
        }

        if (tt.on_demand_end_at !== undefined) {
          updateFields.push(`on_demand_end_at = $${paramCount++}`);
          updateValues.push(tt.on_demand_end_at);
        }

        updateValues.push(eventId, tt.id);

        await client.query(
          `UPDATE ticket_types SET ${updateFields.join(', ')} WHERE id = $${paramCount} AND event_id = $${paramCount + 1}`,
          updateValues
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  generateToken,
  hashToken,
  checkAccessEligibility,
  createAccessToken,
  resolveAccessToken,
  rotateAccessLinks,
  getAccessSettings,
  updateAccessSettings
};
