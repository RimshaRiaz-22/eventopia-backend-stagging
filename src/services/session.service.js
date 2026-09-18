const pool = require("../db");
const { generateToken, hashToken, generateAccessToken, generateRefreshToken } = require("../utils/crypto");

/**
 * Create a session with JWT access token and refresh token
 * Returns both tokens and session info
 */
async function createSession({ userId, deviceId, ip, userAgent, roles, rolesVersion }) {
  // Generate refresh token (long-lived)
  const refreshToken = generateToken();
  const refreshTokenHash = hashToken(refreshToken);
  
  // Refresh token expires in 30 days (or from env)
  const refreshExpiresAt = new Date(
    Date.now() + (parseInt(process.env.JWT_REFRESH_EXPIRE_DAYS || "30") * 24 * 60 * 60 * 1000)
  );

  // Create session record
  const sessionResult = await pool.query(
    `
    INSERT INTO sessions (user_id, device_id, refresh_token_hash, expires_at, ip, user_agent)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
    `,
    [userId, deviceId || null, refreshTokenHash, refreshExpiresAt, ip, userAgent]
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

  // Generate JWT access token (short-lived, 30 minutes)
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
    refreshToken,
    sessionId,
    expiresAt: refreshExpiresAt,
  };
}
/**
 * Validate JWT access token and check session
 * This is used by the auth middleware
 */
async function validateAccessToken(accessToken) {
  const { verifyAccessToken } = require("../utils/crypto");
  
  // Verify JWT signature and expiration
  const decoded = verifyAccessToken(accessToken);
  
  // Check session exists and is valid
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
    throw new Error("Session not found");
  }

  const session = result.rows[0];

  // Check if session is revoked
  if (session.revoked_at) {
    throw new Error("Session revoked");
  }

  // Check if refresh token is expired (session expired)
  if (new Date(session.expires_at) < new Date()) {
    throw new Error("Session expired");
  }

  // Check if user is active
  if (session.status !== "active") {
    throw new Error("User is not active");
  }

  // Check roles version - if roles changed, token is invalid
  if (decoded.rolesVersion !== session.roles_version) {
    throw new Error("Token invalidated due to role changes");
  }

  return {
    userId: session.user_id,
    sessionId: session.id,
    roles: decoded.roles || (session.role ? [session.role] : []),
    rolesVersion: decoded.rolesVersion,
  };
}

/**
 * Validate refresh token and return session info
 */
async function validateRefreshToken(refreshToken) {
  const refreshTokenHash = hashToken(refreshToken);

  const result = await pool.query(
    `
    SELECT s.*, u.status, u.roles_version, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.refresh_token_hash = $1
    `,
    [refreshTokenHash]
  );

  if (result.rowCount === 0) {
    throw new Error("Invalid refresh token");
  }

  const session = result.rows[0];

  // Check if session is revoked
  if (session.revoked_at) {
    throw new Error("Refresh token revoked");
  }

  // Check if refresh token is expired
  if (new Date(session.expires_at) < new Date()) {
    throw new Error("Refresh token expired");
  }

  // Check if user is active
  if (session.status !== "active") {
    throw new Error("User is not active");
  }

  return {
    userId: session.user_id,
    sessionId: session.id,
    role: session.role,
    rolesVersion: session.roles_version,
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

/**
 * Refresh access token using refresh token
 * Implements token rotation (creates new refresh token)
 */
async function refreshAccessToken(refreshToken, ip, userAgent) {
  // Validate refresh token
  const sessionInfo = await validateRefreshToken(refreshToken);

  // Rotate refresh token (generate new one, revoke old)
  const newRefreshToken = generateToken();
  const newRefreshTokenHash = hashToken(newRefreshToken);
  
  const refreshExpiresAt = new Date(
    Date.now() + (parseInt(process.env.JWT_REFRESH_EXPIRE_DAYS || "30") * 24 * 60 * 60 * 1000)
  );

  // Revoke old refresh token and update with new one
  await pool.query(
    `
    UPDATE sessions
    SET refresh_token_hash = $1,
        expires_at = $2,
        ip = COALESCE($3, ip),
        user_agent = COALESCE($4, user_agent)
    WHERE id = $5
    `,
    [newRefreshTokenHash, refreshExpiresAt, ip, userAgent, sessionInfo.sessionId]
  );

  // Generate new access token
  const accessTokenJti = generateToken();
  const accessToken = generateAccessToken({
    sub: sessionInfo.userId,
    sid: sessionInfo.sessionId,
    jti: accessTokenJti,
    roles: sessionInfo.role ? [sessionInfo.role] : [],
    rolesVersion: sessionInfo.rolesVersion,
  });

  // Update session with new access token JTI
  await pool.query(
    `
    UPDATE sessions
    SET access_token_jti = $1
    WHERE id = $2
    `,
    [accessTokenJti, sessionInfo.sessionId]
  );

  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt: refreshExpiresAt,
  };
}

module.exports = {
  createSession,
  validateAccessToken,
  validateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
  refreshAccessToken,
};
