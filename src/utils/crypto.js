const crypto = require("crypto");
const jwt = require("jsonwebtoken");

function generateOtp(length = 4) {
  // Default to 4 digits for Network Manager, but allow customization
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

/**
 * Generate JWT access token (24 hours by default)
 */
function generateAccessToken(payload) {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_ACCESS_EXPIRE || "24h";

  return jwt.sign(payload, secret, { expiresIn });
}

/**
 * Generate JWT refresh token (long-lived, 7-30 days)
 */
function generateRefreshToken(payload) {
  const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || "default-secret-change-in-production";
  const expiresIn = process.env.JWT_REFRESH_EXPIRE || "30d"; // 30 days default
  
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
 * Verify JWT refresh token
 */
function verifyRefreshToken(token) {
  const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || "default-secret-change-in-production";
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
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  generateEmailVerificationToken,
  generatePasswordResetToken,
};