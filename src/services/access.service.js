/**
 * Event Access Grant Service
 *
 * Handles short-lived access grants for private link events and hidden ticket types
 */

const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_SECRET;

/**
 * Generate an access grant for an event
 * @param {string|number} eventId - Event ID
 * @param {string|number} userId - User ID (optional, null for anonymous)
 * @param {object} options - Options
 * @param {number} options.expiresIn - Expiration in minutes (default: 30 minutes)
 * @returns {string} Signed JWT token
 */
function generateAccessGrant(eventId, userId = null, options = {}) {
  const expiresIn = options.expiresIn || 1800; // 30 minutes in seconds

  const payload = {
    sub: 'event_access',
    eventId: String(eventId),
    userId: userId ? String(userId) : null,
    typ: 'event_access_grant',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresIn
  };

  const token = jwt.sign(payload, ACCESS_SECRET, {
    algorithm: 'HS256',
    jwtid: `grant_${eventId}_${Date.now()}`
  });

  return token;
}

/**
 * Verify an access grant token
 * @param {string} token - Access grant token
 * @returns {object|null} Decoded claims if valid, null otherwise
 */
function verifyAccessGrant(token) {
  try {
    const decoded = jwt.verify(token, ACCESS_SECRET, {
      algorithms: ['HS256']
    });

    // Verify it's an event access grant
    if (decoded.typ !== 'event_access_grant' || decoded.sub !== 'event_access') {
      return null;
    }

    return decoded;
  } catch (err) {
    return null;
  }
}

/**
 * Check if a user has access to an event
 * @param {string} token - Access grant token
 * @param {string|number} eventId - Event ID to check
 * @param {string|number} userId - User ID (optional)
 * @returns {boolean} True if access is granted
 */
function hasEventAccess(token, eventId, userId = null) {
  const decoded = verifyAccessGrant(token);
  if (!decoded) {
    return false;
  }

  // Check event ID matches
  if (decoded.eventId !== String(eventId)) {
    return false;
  }

  // Check user ID matches (if provided)
  if (userId && decoded.userId && decoded.userId !== String(userId)) {
    return false;
  }

  return true;
}

module.exports = {
  generateAccessGrant,
  verifyAccessGrant,
  hasEventAccess
};
