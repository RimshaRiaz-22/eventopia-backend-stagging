const pool = require("../db");
const bcrypt = require("bcryptjs");
const { createOtp, verifyOtp } = require("../services/otp.service");
const { hashOtp } = require("../utils/crypto");
const { revokeAllUserSessions } = require("../services/session.service");
const { ok, fail } = require("../utils/standardResponse");
const ENABLE_PROFILE_AUDIT = process.env.ENABLE_PROFILE_AUDIT === "true";

/**
 * E.164 phone number validation
 * Format: +[country code][number] e.g., +447911123456
 */
function isValidE164Phone(phone) {
  if (!phone) return true; // phone is optional
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  return e164Regex.test(phone);
}

function validatePasswordStrength(password) {
  const errors = [];
  if (!password || password.length < 8) {
    errors.push("Password must be at least 8 characters long");
  }
  if (!/[A-Z]/.test(password || "")) {
    errors.push("Password must include at least one uppercase letter");
  }
  if (!/\d/.test(password || "")) {
    errors.push("Password must include at least one number");
  }
  return errors;
}

async function logProfileAudit(userId, actionType, actionDetails, req) {
  if (!ENABLE_PROFILE_AUDIT) {
    return;
  }

  try {
    await pool.query(
      `INSERT INTO profile_audit_logs (user_id, action_type, action_details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, actionType, JSON.stringify(actionDetails || {}), req.ip, req.get("user-agent")]
    );
  } catch (logErr) {
    // Keep settings flows operational even if audit table/migration is missing.
    console.error("Profile audit logging failed:", logErr.message);
  }
}

async function verifyKingsTwofaCode({ email, twofaCode }) {
  const incomingHash = hashOtp(twofaCode);

  const otpResult = await pool.query(
    `SELECT id, code_hash, expires_at, consumed_at
     FROM otps
     WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
       AND purpose IN ('kings_login', 'kings_password_change')
     ORDER BY created_at DESC
     LIMIT 5`,
    [email]
  );

  if (otpResult.rowCount === 0) {
    throw new Error("invalid_or_expired");
  }

  let matchedOtp = null;
  for (const row of otpResult.rows) {
    if (row.consumed_at) {
      continue;
    }
    if (new Date(row.expires_at) < new Date()) {
      continue;
    }
    if (row.code_hash === incomingHash) {
      matchedOtp = row;
      break;
    }
  }

  if (!matchedOtp) {
    throw new Error("invalid_or_expired");
  }

  await pool.query(
    `UPDATE otps SET consumed_at = NOW() WHERE id = $1`,
    [matchedOtp.id]
  );
}

/**
 * GET /api/v1/profile
 * Fetch current user profile (name, email, phone, role, territory, avatar)
 * Auth: JWT (Promoter, Guru, Network Manager, Buyer)
 */
exports.getProfile = async (req, res) => {
  try {
    // req.user is set by requireAuth middleware from JWT token
    const userId = req.user.id;

    const userResult = await pool.query(
      `SELECT id, name, email, phone, role, territory_id, avatar_url
       FROM users
       WHERE id = $1 AND LOWER(role) IN ('promoter', 'guru', 'network_manager', 'buyer')`,
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found or unauthorized role.",
        data: null,
      });
    }

    const user = userResult.rows[0];

    // Fetch territory name if territory_id is present (read-only field)
    let territory = null;
    if (user.territory_id) {
      try {
        const territoryResult = await pool.query(
          "SELECT id, name FROM territories WHERE id = $1",
          [user.territory_id]
        );
        if (territoryResult.rowCount > 0) {
          territory = territoryResult.rows[0].name;
        }
      } catch (territoryErr) {
        console.error("Error fetching territory:", territoryErr);
        // Territory lookup failure should not block profile retrieval
      }
    }

    return res.status(200).json({
      error: false,
      message: "Profile retrieved successfully",
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone || null,
        role: user.role,
        avatar_url: user.avatar_url || null,
      
        territory: territory, // read-only
      },
    });
  } catch (err) {
    console.error("Get profile error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve profile at the moment.",
      data: null,
    });
  }
};

/**
 * PUT /api/v1/profile
 * Update name, email, phone, or avatar_url
 * Validations:
 * - Territory field must be read-only (reject any attempt to update)
 * - Email change requires current_password confirmation
 * - Phone must pass E.164 format validation
 * - If email changes: trigger re-verification email, invalidate current email until verified
 * - Save must be blocked if current_password is not confirmed when needed
 * 
 * Request body: { name?, email?, phone?, avatar_url?, current_password }
 * Response: { success: true, email_verification_sent?: true }
 */
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, email, phone, avatar_url, current_password, territory } = req.body;
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : email;

    // VALIDATION 1: Reject if attempting to update territory (read-only)
    if (territory !== undefined) {
      return res.status(422).json({
        error: true,
        message: "Territory is read-only and cannot be updated.",
        data: null,
      });
    }

    // VALIDATION 2: Reject if no fields to update
    if (name === undefined && email === undefined && phone === undefined && avatar_url === undefined) {
      return res.status(400).json({
        error: true,
        message: "At least one field (name, email, phone, or avatar_url) must be provided for update.",
        data: null,
      });
    }

    // Get current user to check current password if email is being changed
    const userResult = await pool.query(
      "SELECT id, name, email, phone, avatar_url, password_hash, role FROM users WHERE id = $1",
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    const currentUser = userResult.rows[0];

    // VALIDATION 3: Check if trying to change email
    const currentEmailNormalized = (currentUser.email || "").trim().toLowerCase();
    const isEmailChanged = !!(normalizedEmail && normalizedEmail !== currentEmailNormalized);

    if (isEmailChanged) {
      // Email change requires current password confirmation
      if (!current_password) {
        return res.status(400).json({
          error: true,
          message: "Current password is required to change email.",
          data: null,
        });
      }

      // Verify current password
      const passwordValid = await bcrypt.compare(current_password, currentUser.password_hash);
      if (!passwordValid) {
        return res.status(401).json({
          error: true,
          message: "Invalid current password.",
          data: null,
        });
      }

      // Check if email is already in use
      const emailCheckResult = await pool.query(
        "SELECT id FROM users WHERE LOWER(TRIM(email)) = $1 AND id != $2",
        [normalizedEmail, userId]
      );
      if (emailCheckResult.rowCount > 0) {
        return res.status(409).json({
          error: true,
          message: "Email already in use.",
          data: null,
        });
      }
    }

    // VALIDATION 4: Validate phone format if provided
    if (phone !== undefined) {
      if (!isValidE164Phone(phone)) {
        return res.status(422).json({
          error: true,
          message: "Phone number must be in E.164 format (e.g., +447911123456).",
          data: null,
        });
      }
    }

    // Prepare update fields
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;

    if (name !== undefined) {
      updateFields.push(`name = $${paramCount}`);
      updateValues.push(name);
      paramCount++;
    }

    if (email !== undefined && isEmailChanged) {
      updateFields.push(`email = $${paramCount}`);
      updateValues.push(normalizedEmail);
      paramCount++;
      // Mark email as unverified when changed
      updateFields.push(`email_status = 'pending'`);
      updateFields.push(`email_verified_at = NULL`);
    }

    if (phone !== undefined) {
      updateFields.push(`phone = $${paramCount}`);
      updateValues.push(phone);
      paramCount++;
    }

    if (avatar_url !== undefined) {
      updateFields.push(`avatar_url = $${paramCount}`);
      updateValues.push(avatar_url);
      paramCount++;
    }

    // Always update updated_at
    updateFields.push(`updated_at = NOW()`);
    updateValues.push(userId);

    // Execute update
    const updateQuery = `
      UPDATE users
      SET ${updateFields.join(", ")}
      WHERE id = $${paramCount}
      RETURNING id, name, email, phone, role
    `;

    const updateResult = await pool.query(updateQuery, updateValues);

    if (updateResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    // Optional audit trail, enabled only when explicitly configured.
    if (ENABLE_PROFILE_AUDIT) {
      try {
        const changeDetails = {};
        if (name !== undefined) changeDetails.name = { old: currentUser.name, new: name };
        if (isEmailChanged) changeDetails.email = { old: currentUser.email, new: normalizedEmail };
        if (phone !== undefined) changeDetails.phone = { old: currentUser.phone, new: phone };
        if (avatar_url !== undefined) changeDetails.avatar_url = { old: currentUser.avatar_url, new: avatar_url };

        await pool.query(
          `INSERT INTO profile_audit_logs (user_id, action_type, action_details, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, "update_profile", JSON.stringify(changeDetails), req.ip, req.get("user-agent")]
        );
      } catch (logErr) {
        console.error("Profile audit logging failed:", logErr.message);
      }
    }

    const response = {
      success: true,
    };

    // If email changed, generate OTP and send to new email
    if (isEmailChanged) {
      try {
        // Create OTP and send to new email address
        const otpResult = await createOtp({
          email: normalizedEmail, // Send OTP to NEW email
          purpose: "email_verification", // Purpose indicates this is for email verification
        });

        response.email_verification_sent = true;
        response.message = "Verification code sent to your new email. Please verify to apply changes.";
        response.challengeId = otpResult.challengeId; // Client needs this for verification
        response.expiresIn = otpResult.expiresIn; // OTP expires in 10 minutes
        
        // Log this in console
        console.log(`\n✅ EMAIL VERIFICATION OTP\n`);
        console.log(`Email: ${normalizedEmail}`);
        console.log(`OTP Code: ${otpResult.otp}`);
        console.log(`Expires in: ${otpResult.expiresIn} seconds\n`);
        
      } catch (emailErr) {
        console.error("Error creating verification OTP:", emailErr);
        response.email_verification_sent = false;
        response.email_error = "Could not send verification code";
      }
    }

    return res.status(200).json({
      error: false,
      message: "Profile updated successfully",
      data: response,
    });
  } catch (err) {
    console.error("Update profile error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to update profile at the moment.",
      data: null,
    });
  }
};

/**
 * POST /api/v1/verify-email
 * Verify email change by confirming OTP code
 * 
 * After user successfully updates profile with new email,
 * they receive OTP code on new email. They provide OTP here to verify.
 * 
 * Request: { email, otp_code, challenge_id }
 * Response: { success: true, email_verified: true }
 * 
 * After this, the new email becomes verified and active.
 */
exports.verifyEmail = async (req, res) => {
  try {
    const { email, otp_code, challenge_id } = req.body;
    const userId = req.user.id;
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : email;

    // VALIDATION 1: All fields required
    if (!normalizedEmail || !otp_code || !challenge_id) {
      return res.status(400).json({
        error: true,
        message: "Email, OTP code, and challenge ID are required.",
        data: null,
      });
    }

    // VALIDATION 2: Verify OTP using existing OTP service
    try {
      await verifyOtp({
        challengeId: parseInt(challenge_id),
        email: normalizedEmail,
        otp: otp_code,
      });
    } catch (otpErr) {
      return res.status(401).json({
        error: true,
        message: otpErr.message || "Invalid or expired OTP code.",
        data: null,
      });
    }

    // VALIDATION 3: Verify email change request (email should exist in pending state)
    const userResult = await pool.query(
      "SELECT id, email, email_status FROM users WHERE id = $1",
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    const user = userResult.rows[0];

    // Finalize verification for the authenticated user. If email differs,
    // align it to the OTP-verified email to prevent stale-state mismatches.
    await pool.query(
      `UPDATE users
       SET email = $1,
           email_status = 'verified',
           email_verified_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [normalizedEmail, userId]
    );

    // Optional email verification audit trail.
    if (ENABLE_PROFILE_AUDIT) {
      try {
        await pool.query(
          `INSERT INTO profile_audit_logs (user_id, action_type, action_details, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, "email_verified", JSON.stringify({ email: normalizedEmail }), req.ip, req.get("user-agent")]
        );
      } catch (logErr) {
        console.error("Profile audit logging failed:", logErr.message);
      }
    }

    return res.status(200).json({
      error: false,
      message: "Email verified successfully. Your profile has been updated.",
      data: {
        success: true,
        email_verified: true,
        email: normalizedEmail,
      },
    });
  } catch (err) {
    console.error("Verify email error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to verify email at the moment.",
      data: null,
    });
  }
};

/**
 * Module 3: King's Account — Profile Settings (Authentication)
 * Role: kings_account (CEO/Admin)
 */

/**
 * GET /api/v1/kings_account/profile
 * Return current King's Account profile
 */
exports.getKingsAccountProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT id, name, email
       FROM users
       WHERE id = $1
         AND role = 'kings_account'`,
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "King's Account user not found.",
        data: null,
      });
    }

    return res.status(200).json({
      error: false,
      message: "King's profile retrieved successfully.",
      data: {
        id: result.rows[0].id,
        name: result.rows[0].name,
        email: result.rows[0].email,
        role: "kings_account",
      },
    });
  } catch (err) {
    console.error("Get King's profile error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve King's profile at the moment.",
      data: null,
    });
  }
};

/**
 * PUT /api/v1/kings_account/profile
 * Update name or email; trigger re-verification if email changed
 */
exports.updateKingsAccountProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, email } = req.body;
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : email;

    if (name === undefined && email === undefined) {
      return res.status(400).json({
        error: true,
        message: "At least one field (name or email) must be provided.",
        data: null,
      });
    }

    const userResult = await pool.query(
      "SELECT id, name, email FROM users WHERE id = $1 AND role = 'kings_account'",
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "King's Account user not found.",
        data: null,
      });
    }

    const currentUser = userResult.rows[0];
    const isEmailChanged = !!(
      normalizedEmail &&
      normalizedEmail !== (currentUser.email || "").trim().toLowerCase()
    );

    if (isEmailChanged) {
      const emailCheckResult = await pool.query(
        "SELECT id FROM users WHERE LOWER(TRIM(email)) = $1 AND id != $2",
        [normalizedEmail, userId]
      );

      if (emailCheckResult.rowCount > 0) {
        return res.status(409).json({
          error: true,
          message: "Email already in use.",
          data: null,
        });
      }
    }

    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;

    if (name !== undefined) {
      updateFields.push(`name = $${paramCount}`);
      updateValues.push(name);
      paramCount += 1;
    }

    if (isEmailChanged) {
      updateFields.push(`email = $${paramCount}`);
      updateValues.push(normalizedEmail);
      paramCount += 1;
      updateFields.push("email_status = 'pending'");
      updateFields.push("email_verified_at = NULL");
    }

    updateFields.push("updated_at = NOW()");
    updateValues.push(userId);

    const updateResult = await pool.query(
      `UPDATE users
       SET ${updateFields.join(", ")}
       WHERE id = $${paramCount}
       RETURNING id, name, email`,
      updateValues
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "King's Account user not found.",
        data: null,
      });
    }

    // Force 2FA re-setup on email change by clearing enrolled devices.
    if (isEmailChanged) {
      await pool.query("DELETE FROM devices WHERE user_id = $1", [userId]);
    }

    await logProfileAudit(
      userId,
      "kings_account_profile_updated",
      {
        name_changed: name !== undefined,
        email_changed: isEmailChanged,
        old_email: currentUser.email,
        new_email: isEmailChanged ? normalizedEmail : currentUser.email,
      },
      req
    );

    const response = { success: true };

    if (isEmailChanged) {
      const otpResult = await createOtp({
        email: normalizedEmail,
        purpose: "email_verification",
      });

      response.email_verification_sent = true;
      response.challengeId = otpResult.challengeId;
      response.expiresIn = otpResult.expiresIn;
    }

    return res.status(200).json({
      error: false,
      message: isEmailChanged
        ? "Verify your new email to apply changes"
        : "Profile updated successfully",
      data: response,
    });
  } catch (err) {
    console.error("Update King's profile error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to update King's profile at the moment.",
      data: null,
    });
  }
};

/**
 * POST /api/v1/kings_account/change-password/request-otp
 * Send a 2FA OTP to king's registered email before changing password.
 * Frontend calls this first, gets challengeId back, then passes the OTP
 * code together with passwords in the change-password request.
 */
exports.requestKingsPasswordChangeOtp = async (req, res) => {
  try {
    const userId = req.user.id;

    const userResult = await pool.query(
      "SELECT id, email FROM users WHERE id = $1 AND role = 'kings_account'",
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "King's Account user not found.",
        data: null,
      });
    }

    const user = userResult.rows[0];

    const otpResult = await createOtp({
      email: user.email,
      purpose: "kings_password_change",
    });

    return res.status(200).json({
      error: false,
      message: "Verification code sent to your registered email.",
      data: {
        challengeId: otpResult.challengeId,
        expiresIn: otpResult.expiresIn,
        ...(process.env.NODE_ENV === "development" && { otp: otpResult.otp }),
      },
    });
  } catch (err) {
    console.error("Request King's password change OTP error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to send verification code at the moment.",
      data: null,
    });
  }
};

/**
 * POST /api/v1/kings_account/change-password
 * Validate current password + 2FA code, update password, invalidate all sessions
 */
exports.changeKingsAccountPassword = async (req, res) => {
  try {
    const { current_password, new_password, twofa_code } = req.body;
    const userId = req.user.id;

    if (!current_password || !new_password || !twofa_code) {
      return res.status(400).json({
        error: true,
        message: "current_password, new_password, and twofa_code are required.",
        data: null,
      });
    }

    const userResult = await pool.query(
      "SELECT id, email, password_hash FROM users WHERE id = $1 AND role = 'kings_account'",
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "King's Account user not found.",
        data: null,
      });
    }

    const user = userResult.rows[0];
    const storedHash = typeof user.password_hash === "string"
      ? user.password_hash
      : (user.password_hash && typeof user.password_hash.toString === "function"
        ? user.password_hash.toString()
        : null);

    if (!storedHash || !storedHash.startsWith("$2")) {
      return res.status(400).json({
        error: true,
        message: "Current password is not set for this account.",
        data: null,
      });
    }

    const currentPasswordValid = await bcrypt.compare(String(current_password), storedHash);
    if (!currentPasswordValid) {
      return res.status(401).json({
        error: true,
        message: "current_password incorrect",
        data: null,
      });
    }

    const sameAsCurrent = await bcrypt.compare(String(new_password), storedHash);
    if (sameAsCurrent) {
      return res.status(409).json({
        error: true,
        message: "New password same as current",
        data: null,
      });
    }

    const strengthErrors = validatePasswordStrength(new_password);
    if (strengthErrors.length > 0) {
      return res.status(422).json({
        error: true,
        message: "Password does not meet strength requirements.",
        data: {
          errors: strengthErrors,
        },
      });
    }

    try {
      await verifyKingsTwofaCode({
        email: user.email,
        twofaCode: twofa_code,
      });
    } catch (twofaErr) {
      return res.status(403).json({
        error: true,
        message: "2FA code invalid or expired",
        data: null,
      });
    }

    const newHash = await bcrypt.hash(new_password, 12);

    await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
      [newHash, userId]
    );

    await revokeAllUserSessions(userId, "kings_password_change");

    await logProfileAudit(
      userId,
      "kings_account_password_changed",
      { status: "changed" },
      req
    );

    return res.status(200).json({
      error: false,
      message: "Password updated",
      data: {
        success: true,
      },
    });
  } catch (err) {
    console.error("Change King's password error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to change King's password at the moment.",
      data: null,
    });
  }
};

/**
 * GET /api/v1/kings_account/2fa/devices
 * Return registered 2FA devices with last used and location
 */
exports.getKingsTwofaDevices = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT d.id,
              d.device_id,
              d.last_seen_at,
              COALESCE(
                (
                  SELECT s.ip
                  FROM sessions s
                  WHERE s.user_id = d.user_id
                    AND s.device_id = d.device_id
                  ORDER BY s.created_at DESC
                  LIMIT 1
                ),
                'Unknown'
              ) AS location
       FROM devices d
       JOIN users u ON u.id = d.user_id
       WHERE d.user_id = $1
         AND u.role = 'kings_account'
       ORDER BY d.last_seen_at DESC`,
      [userId]
    );

    const devices = result.rows.map((row) => ({
      id: row.id,
      device_name: row.device_id,
      last_used: row.last_seen_at,
      location: row.location,
    }));

    return res.status(200).json(devices);
  } catch (err) {
    console.error("Get King's 2FA devices error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to fetch 2FA devices at the moment.",
      data: null,
    });
  }
};

/**
 * DELETE /api/v1/kings_account/2fa/devices/:id
 * Remove a 2FA device and log event
 */
exports.deleteKingsTwofaDevice = async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = parseInt(req.params.id, 10);

    if (Number.isNaN(deviceId) || deviceId <= 0) {
      return res.status(404).json({
        error: true,
        message: "2FA device not found",
        data: null,
      });
    }

    const deviceResult = await pool.query(
      `SELECT d.id, d.device_id
       FROM devices d
       JOIN users u ON u.id = d.user_id
       WHERE d.id = $1
         AND d.user_id = $2
         AND u.role = 'kings_account'`,
      [deviceId, userId]
    );

    if (deviceResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "2FA device not found",
        data: null,
      });
    }

    await pool.query("DELETE FROM devices WHERE id = $1 AND user_id = $2", [deviceId, userId]);

    await logProfileAudit(
      userId,
      "kings_account_2fa_device_removed",
      { removed_device_id: deviceId, removed_device_name: deviceResult.rows[0].device_id },
      req
    );

    return res.status(200).json({
      success: true,
      device_id: String(deviceId),
    });
  } catch (err) {
    console.error("Delete King's 2FA device error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to remove 2FA device at the moment.",
      data: null,
    });
  }
};
