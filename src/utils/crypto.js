const crypto = require("crypto");
const jwt = require("jsonwebtoken");

function generateOtp(length = 4) {
  // Default to 4 digits, but allow customization
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return Math.floor(min + Math.random() * (max - min + 1)).toString();
}

function hashOtp(otp) {
  return crypto
    .createHash("sha256")
    .update(otp)
    .digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

const DURATION_UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

/**
 * Access token lifetime in ms, read from JWT_ACCESS_EXPIRE (e.g. "24h", "30m", "7d"). Default 24h.
 * The session row and the JWT both use this value, so they always expire together.
 */
function getAccessTokenTtlMs() {
  const raw = String(process.env.JWT_ACCESS_EXPIRE || "24h").trim();
  const match = /^(\d+)\s*([smhd])$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid JWT_ACCESS_EXPIRE "${raw}". Use a number plus s, m, h or d (e.g. 24h).`);
  }
  return Number(match[1]) * DURATION_UNIT_MS[match[2]];
}

/**
 * Generate JWT access token. This is the only token issued on login; when it expires the user logs in again.
 */
function generateAccessToken(payload) {
  const secret = process.env.JWT_SECRET;
  const expiresIn = Math.floor(getAccessTokenTtlMs() / 1000);

  return jwt.sign(payload, secret, { expiresIn });
}

/**
 * Verify JWT access token
 */
function verifyAccessToken(token) {
  const secret = process.env.JWT_SECRET || "default-secret-change-in-production";
  return jwt.verify(token, secret);
}

/**
 * Generate email verification token
 */
function generateEmailVerificationToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Generate password reset token
 */
function generatePasswordResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = {
  generateOtp,
  hashOtp,
  generateToken,
  hashToken,
  getAccessTokenTtlMs,
  generateAccessToken,
  verifyAccessToken,
  generateEmailVerificationToken,
  generatePasswordResetToken,
};