/**
 * QR Code Signing Service
 *
 * Provides JWT-based QR payload signing and verification for tickets.
 * QR codes contain signed claims to prevent forgery and tampering.
 */

const jwt = require('jsonwebtoken');

// Use dedicated QR secret or fallback to main JWT secret
const QR_SECRET = process.env.QR_JWT_SECRET || process.env.JWT_SECRET;

/**
 * Generate a signed QR payload for a ticket
 * @param {string|number} ticketId - Ticket ID (internal)
 * @param {string|number} eventId - Event ID
 * @param {object} options - Additional options
 * @param {number} options.expiresIn - Expiration in seconds (default: 24 hours)
 * @returns {string} Signed JWT payload
 */
function generateTicketQR(ticketId, eventId, options = {}) {
  const expiresIn = options.expiresIn || 86400; // 24 hours in seconds

  const payload = {
    sub: String(ticketId), // Subject: ticket ID
    event_id: String(eventId), // Event ID for validation (snake_case for consistency)
    iat: Math.floor(Date.now() / 1000), // Issued at
    exp: Math.floor(Date.now() / 1000) + expiresIn, // Expiration
    typ: 'ticket' // Type indicator
  };

  const token = jwt.sign(payload, QR_SECRET, {
    algorithm: 'HS256',
    jwtid: `qr_${ticketId}_${Date.now()}`,
    header: {
      typ: 'JWT',
      alg: 'HS256'
    }
  });

  return token;
}

/**
 * Verify a QR payload and return decoded claims
 * @param {string} qrPayload - The QR payload string
 * @returns {object|null} Decoded claims if valid, null otherwise
 */
function verifyTicketQR(qrPayload) {
  try {
    const decoded = jwt.verify(qrPayload, QR_SECRET, {
      algorithms: ['HS256']
    });

    // Additional validation
    if (!decoded.sub || !decoded.event_id) {
      return null;
    }

    return decoded;
  } catch (err) {
    // Log verification failure (without logging sensitive data)
    console.log('QR verification failed:', err.message);
    return null;
  }
}

/**
 * Check if a QR payload is expired (without full verification)
 * @param {string} qrPayload - The QR payload string
 * @returns {boolean} True if expired, false otherwise
 */
function isQRExpired(qrPayload) {
  try {
    const decoded = jwt.decode(qrPayload);
    if (!decoded || !decoded.exp) {
      return true;
    }

    const currentTime = Math.floor(Date.now() / 1000);
    return decoded.exp < currentTime;
  } catch (err) {
    return true;
  }
}

/**
 * Get remaining time for a QR payload in seconds
 * @param {string} qrPayload - The QR payload string
 * @returns {number} Seconds remaining (0 if expired or invalid)
 */
function getQRTimeRemaining(qrPayload) {
  try {
    const decoded = jwt.decode(qrPayload);
    if (!decoded || !decoded.exp) {
      return 0;
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const remaining = decoded.exp - currentTime;

    return Math.max(0, remaining);
  } catch (err) {
    return 0;
  }
}

module.exports = {
  generateTicketQR,
  verifyTicketQR,
  isQRExpired,
  getQRTimeRemaining
};
