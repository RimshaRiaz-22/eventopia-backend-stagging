const pool = require("../db");
const { generateToken, generateAccessToken, verifyAccessToken, getAccessTokenTtlMs } = require("../utils/crypto");

const SESSION_EXPIRED_CODE = "SESSION_EXPIRED";
const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please log in again to continue.";

/**
 * Error that tells the client its login is no longer valid and the user must log in again.
 * The `code` lets the frontend tell this apart from other 401 responses (e.g. a wrong password).
 */
function sessionError(message = SESSION_EXPIRED_MESSAGE) {
  const err = new Error(message);
  err.code = SESSION_EXPIRED_CODE;
  return err;
}

/**
 * Create a session and its JWT access token.
 * The session and the token expire together (JWT_ACCESS_EXPIRE, 24h by default).
 */
async function createSession({ userId, deviceId, ip, userAgent, roles, rolesVersion }) {
  const expiresAt = new Date(Date.now() + getAccessTokenTtlMs());

  const sessionResult = await pool.query(
    `
    INSERT INTO sessions (user_id, device_id, expires_at, ip, user_agent)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [userId, deviceId || null, expiresAt, ip, userAgent]
  );

  const sessionId = sessionResult.rows[0].id;

  // Upsert device if deviceId provided
  if (deviceId) {
    await pool.query(
      `
      INSERT INTO devices (user_id, device_id, device_type, last_seen_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, device_id)
      DO UPDATE SET last_seen_at = NOW()
      `,
      [userId, deviceId, userAgent ? (userAgent.includes('iOS') ? 'ios' : userAgent.includes('Android') ? 'android' : 'web') : 'web']
    );
  }

  const accessTokenJti = generateToken(); // JWT ID for access token
  const accessToken = generateAccessToken({
    sub: userId,
    sid: sessionId,
    jti: accessTokenJti,
    roles: roles || [],
    rolesVersion: rolesVersion || 1,
  });

  // Update session with access token JTI
  await pool.query(
    `
    UPDATE sessions
    SET access_token_jti = $1
    WHERE id = $2
    `,
    [accessTokenJti, sessionId]
  );

  return {
    accessToken,
    sessionId,
    expiresAt,
  };
}

/**
 * Validate JWT access token and check session
 * This is used by the auth middleware
 */
async function validateAccessToken(accessToken) {
  let decoded;
  try {
    decoded = verifyAccessToken(accessToken);
  } catch (err) {
    // Expired, malformed or tampered token: the user has to log in again.
    throw sessionError();
  }

  const result = await pool.query(
    `
    SELECT s.*, u.status, u.roles_version, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = $1
    `,
    [decoded.sid]
  );

  if (result.rowCount === 0) {
    throw sessionError();
  }

  const session = result.rows[0];

  if (session.revoked_at) {
    throw sessionError();
  }

  if (new Date(session.expires_at) < new Date()) {
    throw sessionError();
  }

  if (session.status !== "active") {
    throw sessionError("Your account is not active. Please contact support.");
  }

  // If roles changed since this token was issued, the user must log in again to get the new roles
  if (decoded.rolesVersion !== session.roles_version) {
    throw sessionError("Your account permissions have changed. Please log in again to continue.");
  }

  return {
    userId: session.user_id,
    sessionId: session.id,
    roles: decoded.roles || (session.role ? [session.role] : []),
    rolesVersion: decoded.rolesVersion,
  };
}

/**
 * Revoke a session by session ID
 */
async function revokeSession(sessionId, reason = "logout") {
  const result = await pool.query(
    `
    UPDATE sessions
    SET revoked_at = NOW(),
        revoked_reason = $2
    WHERE id = $1
      AND revoked_at IS NULL
    `,
    [sessionId, reason]
  );

  if (result.rowCount === 0) {
    throw new Error("Session already revoked or invalid");
  }

  return true;
}

/**
 * Revoke all sessions for a user (logout from all devices)
 * Optionally keep one current session active.
 */
async function revokeAllUserSessions(userId, reason = "logout_all", keepSessionId = null) {
  if (keepSessionId) {
    await pool.query(
      `
      UPDATE sessions
      SET revoked_at = NOW(),
          revoked_reason = $2
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND id <> $3
      `,
      [userId, reason, keepSessionId]
    );

    return true;
  }

  await pool.query(
    `
    UPDATE sessions
    SET revoked_at = NOW(),
        revoked_reason = $2
    WHERE user_id = $1
      AND revoked_at IS NULL
    `,
    [userId, reason]
  );

  return true;
}

module.exports = {
  SESSION_EXPIRED_CODE,
  SESSION_EXPIRED_MESSAGE,
  createSession,
  validateAccessToken,
  revokeSession,
  revokeAllUserSessions,
};
