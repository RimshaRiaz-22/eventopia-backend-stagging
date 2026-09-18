const pool = require("../db");
const { generateOtp, hashOtp } = require("../utils/crypto");
const { sendOtpEmail } = require("./email.service");

async function createOtp({ email, purpose }) {
  // Use 4-digit OTP for Network Manager signup, 6-digit for others
  const otpLength = purpose === "signup" ? 4 : 6;
  const otp = generateOtp(otpLength);
  const otpHash = hashOtp(otp);

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const result = await pool.query(
    `
    INSERT INTO otps (email, purpose, code_hash, expires_at)
    VALUES ($1, $2, $3, $4)
    RETURNING id
    `,
    [email, purpose, otpHash, expiresAt]
  );

  // Send OTP email
  try {
    await sendOtpEmail(email, otp, purpose, 600);
  } catch (error) {
    console.error("Failed to send OTP email:", error);
    // Don't throw error - still return OTP for development
    console.log("DEV OTP:", otp);
  }

  return {
    challengeId: result.rows[0].id,
    otp,
    expiresIn: 600,
  };
}

async function verifyOtp({ challengeId, email, otp }) {
  const result = await pool.query(
    `
    SELECT *
    FROM otps
    WHERE id = $1 AND email = $2
    `,
    [challengeId, email]
  );

  if (result.rowCount === 0) {
    throw new Error("Invalid OTP request");
  }

  const record = result.rows[0];

  if (record.consumed_at) {
    throw new Error("OTP already used");
  }

  if (new Date(record.expires_at) < new Date()) {
    throw new Error("OTP expired");
  }

  if (record.attempt_count >= 5) {
    throw new Error("Too many wrong attempts");
  }

  const incomingHash = hashOtp(otp);

  if (incomingHash !== record.code_hash) {
    await pool.query(
      `
      UPDATE otps
      SET attempt_count = attempt_count + 1
      WHERE id = $1
      `,
      [challengeId]
    );

    throw new Error("Invalid OTP");
  }

  await pool.query(
    `
    UPDATE otps
    SET consumed_at = NOW()
    WHERE id = $1
    `,
    [challengeId]
  );

  return true;
}

async function resendOtp({ email, purpose }) {
  const latestOtp = await pool.query(
    `
    SELECT *
    FROM otps
    WHERE email = $1 AND purpose = $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [email, purpose]
  );

  if (latestOtp.rowCount > 0) {
    const record = latestOtp.rows[0];

    const secondsSinceLastSend =
      (Date.now() - new Date(record.last_sent_at).getTime()) / 1000;

    if (secondsSinceLastSend < 60) {
      throw new Error("Please wait before requesting another OTP");
    }
  }

  const resendCount = await pool.query(
    `
    SELECT COUNT(*)
    FROM otps
    WHERE email = $1
      AND purpose = $2
      AND created_at > NOW() - INTERVAL '1 hour'
    `,
    [email, purpose]
  );

  if (parseInt(resendCount.rows[0].count) >= 3) {
    throw new Error("Too many OTP requests. Try again later.");
  }

  await pool.query(
    `
    UPDATE otps
    SET expires_at = NOW()
    WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL
    `,
    [email, purpose]
  );

  return createOtp({ email, purpose });
}

module.exports = {
  createOtp,
  verifyOtp,
  resendOtp,
};
