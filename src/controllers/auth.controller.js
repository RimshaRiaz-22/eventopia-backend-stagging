const { createOtp, verifyOtp } = require("../services/otp.service");
const { createSession, revokeAllUserSessions } = require("../services/session.service");
const pool = require("../db");
const bcrypt = require("bcryptjs");
const { generatePasswordResetToken } = require("../utils/crypto");
const { ok, fail } = require("../utils/standardResponse");
const { sendPasswordResetEmail } = require("../services/email.service");
const { sendOtpEmail } = require("../services/email.service");
const {
  sendPromoterReferralInviteEmail,
  sendPromoterReferralInviteResendEmail,
} = require("../services/inviteEmailService");
const {
  ensurePromoterCreditWallet,
  ensurePromoterCreditWalletIfActivePromoter,
} = require("../services/promoterCreditWallet.service");
const {
  claimReferralOnRegister,
  ensureShareableReferralLinkForPromoter,
} = require("../services/promoterReferral.service");
const { getWalletMeForUser } = require("../services/walletMe.service");
const {
  getPendingPromoterInviteLoginBlock,
  getUnverifiedBuyerLoginBlock,
  getIncompleteSelfRegisteredPromoterLoginBlock,
} = require("../services/accountOnboardingStatus.service");
function isValidEmail(email) {
  return /^(?!\.)(?!.*\.\.)([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email);
}
/**
 * Validates password strength. Returns array of error messages for failed rules.
 * Strong password requires: min 8 chars, uppercase, lowercase, number, special character.
 */
function validatePasswordStrength(password) {
  const errors = [];
  if (!password || typeof password !== "string" || password.trim() === "") return ["Password is required."];
  if (password.length < 8) errors.push("Password must be at least 8 characters long.");
  if (!/[A-Z]/.test(password)) errors.push("Password must contain at least one uppercase letter.");
  if (!/[a-z]/.test(password)) errors.push("Password must contain at least one lowercase letter.");
  if (!/[0-9]/.test(password)) errors.push("Password must contain at least one number.");
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    errors.push("Password must contain at least one special character (e.g. !@#$%^&*).");
  }
  return errors.length > 0 ? errors : [];
}

// Friendly wording for the plain errors thrown by otp.service.verifyOtp (used by email verification).
const OTP_ERROR_MESSAGES = {
  "Invalid OTP": "That code is not correct. Please check it and try again.",
  "OTP expired": "That code has expired. Please request a new one.",
  "OTP already used": "That code has already been used. Please request a new one.",
  "Too many wrong attempts": "Too many incorrect attempts. Please request a new code.",
  "Invalid OTP request": "We could not find that verification request. Please request a new code.",
};

function mapUserForResponse(user) {
  const { id, user_no, ...rest } = user;

  return {
    userId: user_no ?? id, // ✅ public small id (falls back if null)
    ...Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [
        key.replace(/_/g, "-"),
        value,
      ])
    ),
    "user-no": user_no, // optional: keep it if frontend already uses it
  };
}

/* =======================
   OTP VERIFY (email verification)
   POST /auth/otp/verify
   Accepts: userId, otp
======================= */
async function verifyOtpEmail(req, res) {
  try {
    const { userId, email, otp, challengeId } = req.body;

    const errors = [];

if (!userId && !email && !challengeId) errors.push("User ID, email, or challengeId is required.");
if (!otp) errors.push("OTP is required.");

if (errors.length > 0) {
  return res.status(400).json({
    error: true,
    message: errors.join(" "),
    data: {
      userId: userId || null,
      email: email || null,
    },
  });
}
    // Resolve user deterministically using one of:
    // 1) explicit email from client, 2) challengeId -> otp email, 3) userId fallback.
    let userResult;
    if (email) {
      userResult = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    } else if (challengeId) {
      const otpByChallenge = await pool.query(
        `
        SELECT email
        FROM otps
        WHERE id = $1
          AND purpose = 'signup'
        LIMIT 1
        `,
        [challengeId]
      );
      if (otpByChallenge.rowCount === 0) {
        return res.status(400).json({
          error: true,
          message: "Invalid challengeId. Please request a new OTP.",
          data: { userId: userId || null, email: null, challengeId: challengeId || null },
        });
      }
      userResult = await pool.query(`SELECT * FROM users WHERE email = $1`, [otpByChallenge.rows[0].email]);
    } else if (userId) {
      try {
        // Keep backward compatibility with old payload (userId + otp):
        // treat userId primarily as public user_no, then fallback to internal id.
        userResult = await pool.query(
          `SELECT * FROM users WHERE user_no = $1 LIMIT 1`,
          [userId]
        );
        if (userResult.rowCount === 0) {
          userResult = await pool.query(
            `SELECT * FROM users WHERE id = $1 LIMIT 1`,
            [userId]
          );
        }
      } catch (err) {
        if (err.code === "42703" && String(err.message || "").includes("user_no")) {
          userResult = await pool.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [userId]);
        } else {
          throw err;
        }
      }
    } else {
      userResult = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    }

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: { userId: userId || null, email: email || null },
      });
    }

    const user = userResult.rows[0];

    // Find the latest active OTP for this user's email
    let otpResult;
    if (challengeId) {
      otpResult = await pool.query(
        `
        SELECT * FROM otps
        WHERE id = $1
          AND email = $2
          AND purpose = 'signup'
          AND consumed_at IS NULL
          AND expires_at > NOW()
        LIMIT 1
        `,
        [challengeId, user.email]
      );
    } else {
      otpResult = await pool.query(
        `
        SELECT * FROM otps
        WHERE email = $1
          AND purpose = 'signup'
          AND consumed_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [user.email]
      );
    }

    if (otpResult.rowCount === 0) {
      return res.status(400).json({
        error: true,
        message: "No valid OTP found. Please request a new OTP.",
        data: { userId: userId || null, email: user.email },
      });
    }

    const otpRecord = otpResult.rows[0];

    // Verify OTP using the service
    try {
      await verifyOtp({ challengeId: otpRecord.id, email: user.email, otp });
    } catch (otpError) {
      return res.status(400).json({
        error: true,
        message: OTP_ERROR_MESSAGES[otpError.message] || "That code is not valid. Please check it and try again.",
        data: { userId: userId || null, email: user.email },
      });
    }

    // Mark email as verified (email_status = verified)
    await pool.query(
      `
      UPDATE users
      SET email_verified_at = NOW(),
          email_status = 'verified',
          updated_at = NOW()
      WHERE id = $1
      `,
      [user.id]
    );

    // Get updated user
    const updatedUserResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [user.id]
    );
    const updatedUser = updatedUserResult.rows[0];

    const acct = updatedUser.account_status || "active";
    if (updatedUser.role === "promoter" && acct === "active") {
      const w = await pool.query(
        `SELECT 1 FROM promoter_credit_wallets WHERE promoter_id = $1 LIMIT 1`,
        [updatedUser.id]
      );
      if (w.rowCount === 0) {
        try {
          await ensurePromoterCreditWalletIfActivePromoter(updatedUser.id);
        } catch (e) {
          console.error("[verifyOtpEmail] ensurePromoterCreditWalletIfActivePromoter:", e.message);
        }
      }
    }

    // Accounts with no role yet (pending applications) cannot log in
    if (!updatedUser.role) {
      return res.status(403).json({
        error: true,
        message: "Your account is pending approval. You cannot login until your application is approved.",
        data: { userId: updatedUser.user_no ?? updatedUser.id },
      });
    }

    // Create JWT session
    const session = await createSession({
      userId: user.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      roles: [updatedUser.role],
      rolesVersion: updatedUser.roles_version || 1,
    });

    return res.json({
      error: false,
      message: "Email verified successfully. You are now logged in.",
      data: {
        userId: updatedUser.user_no ?? updatedUser.id,
        accessToken: session.accessToken,
        "expires-at": session.expiresAt,
        emailStatus: "verified",
        setupRequired: !updatedUser.name,
        role: updatedUser.role,
        user: {
          ...mapUserForResponse(updatedUser),
          role: updatedUser.role,
        },
      },
    });
  } catch (err) {
    console.error("Verify OTP email error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to verify OTP at the moment. Please try again later.",
      data: { userId: req.body?.userId || null, email: req.body?.email || null },
    });
  }
}



/* =======================
   GET ME
======================= */
async function getMe(req, res) {
  try {
    // Get full user data with account_status and email_status
    const userResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    const user = userResult.rows[0];
    const role = user.role;
    const setupRequired = !user.name; // Account setup is required if name is not set

    // Get user preferences (city and interests)
    let userPreferences = null;
    const prefsResult = await pool.query(
      `SELECT city FROM user_preferences WHERE user_id = $1`,
      [req.user.id]
    );

    if (prefsResult.rows.length > 0) {
      // Get user's tag preferences
      const tagsResult = await pool.query(
        `SELECT tag_id FROM user_preference_tags WHERE user_id = $1 ORDER BY created_at ASC`,
        [req.user.id]
      );

      const tagIds = tagsResult.rows.map((r) => r.tag_id);
      userPreferences = {
        city: prefsResult.rows[0].city || null,
        interestsTagIds: tagIds,
      };
    }

    // Get Promoter application if exists
    let promoterApplication = null;
    const promoterAppResult = await pool.query(
      `
      SELECT pa.id, pa.account_status, pa.created_at, pa.reviewed_at,
             pa.territory_name, pa.rejection_reason
      FROM promoter_applications pa
      WHERE pa.user_id = $1
      `,
      [req.user.id]
    );

    if (promoterAppResult.rowCount > 0) {
      promoterApplication = {
        id: promoterAppResult.rows[0].id,
        accountStatus: promoterAppResult.rows[0].account_status,
        createdAt: promoterAppResult.rows[0].created_at,
        reviewedAt: promoterAppResult.rows[0].reviewed_at,
        rejectionReason: promoterAppResult.rows[0].rejection_reason,
        territoryName: promoterAppResult.rows[0].territory_name,
      };
    }

    let promoter = null;
    if (role === "promoter") {
      let credit = null;
      const wm = await getWalletMeForUser(req.user.id, ["promoter"]);
      if (wm.ok) {
        credit = {
          balances: wm.body.balances,
          unlockStatus: wm.body.unlock_status,
        };
      }

      promoter = {
        accountStatus: user.account_status || "active",
        applicationAccountStatus: promoterApplication?.accountStatus ?? null,
        credit,
      };
    }

    return res.json({
      error: false,
      message: "Your profile information has been retrieved successfully.",
      data: {
        setupRequired, // ✅ indicates if account setup is needed
        user: {
          ...mapUserForResponse(user),
          role,
          accountStatus: user.account_status || "active",
          emailStatus: user.email_status || "pending",
        },
        promoterApplication,
        userPreferences, // ✅ includes city and interests for quick setup
        ...(promoter ? { promoter } : {}),
      },
    });
  } catch (err) {
    console.error("Get me error:", err);
    return res.status(400).json({
      error: true,
      message: "Unable to fetch your profile details at the moment.",
      data: null,
    });
  }
}

/* =======================
   LOGOUT
======================= */
async function logout(req, res) {
  try {
    const { revokeSession } = require("../services/session.service");
    await revokeSession(req.sessionId, "logout");

    return res.json({
      error: false,
      message: "You have been logged out successfully.",
      data: {
        loggedOut: true,
        sessionId: req.sessionId,
      },
    });
  } catch (err) {
    return res.status(400).json({
      error: true,
      message: "Unable to log you out at the moment. Please try again.",
      data: { sessionId: req.sessionId },
    });
  }
}

/* =======================
   UPDATE PROFILE (Name + Avatar)
   PATCH /users/me
======================= */
async function updateProfile(req, res) {
  try {
    const { name, avatarUrl } = req.body;

    // Validation
    if (name !== undefined && (!name || typeof name !== "string" || name.trim().length === 0)) {
      return res.status(400).json({
        error: true,
        message: "Name must be a non-empty string.",
        data: { name: name || null },
      });
    }

    if (name && name.trim().length < 2) {
      return res.status(400).json({
        error: true,
        message: "Full name must be at least 2 characters long.",
        data: { name: name.trim() },
      });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;

    if (name !== undefined) {
      updateFields.push(`name = $${paramCount++}`);
      updateValues.push(name.trim());
    }

    if (avatarUrl !== undefined) {
      updateFields.push(`avatar_url = $${paramCount++}`);
      updateValues.push(avatarUrl);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        error: true,
        message: "At least one field (name or avatarUrl) must be provided.",
        data: null,
      });
    }

    updateFields.push(`updated_at = NOW()`);
    updateValues.push(req.user.id);

    // Update user
    const userResult = await pool.query(
      `
      UPDATE users
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
      `,
      updateValues
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    const updatedUser = userResult.rows[0];

    return res.json({
      error: false,
      message: "Profile updated successfully.",
      data: {
        user: {
          ...mapUserForResponse(updatedUser),
          role: updatedUser.role,
        },
      },
    });
  } catch (err) {
    console.error("Update profile error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to update profile at the moment. Please try again later.",
      data: null,
    });
  }
}

/* =======================
   SETUP ACCOUNT
======================= */
async function setupAccount(req, res) {
  try {
    const { fullName } = req.body;

    if (
      !fullName ||
      typeof fullName !== "string" ||
      fullName.trim().length === 0
    ) {
      return res.status(400).json({
        error: true,
        message: "Full name is required to complete account setup.",
        data: { fullName: fullName || null },
      });
    }

    const trimmedName = fullName.trim();

    if (trimmedName.length < 2) {
      return res.status(400).json({
        error: true,
        message: "Full name must be at least 2 characters long.",
        data: { fullName: trimmedName },
      });
    }

    // Check if account is already set up
    if (req.user.name) {
      return res.status(400).json({
        error: true,
        message: "Your account has already been set up.",
        data: { fullName: req.user.name },
      });
    }

    // Update user's name
    const userResult = await pool.query(
      `
      UPDATE users
      SET name = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [trimmedName, req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: null,
      });
    }

    const updatedUser = userResult.rows[0];

    return res.json({
      error: false,
      message: "Your account has been set up successfully.",
      data: {
        user: {
          ...mapUserForResponse(updatedUser),
          role: updatedUser.role,
        },
        setupCompleted: true,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message:
        "Unable to complete account setup at the moment. Please try again later.",
      data: null,
    });
  }
}

/* =======================
   REGISTER (Email + Password)
======================= */
async function register(req, res) {
  try {
    const {
      email,
      password,
      name,
      city,
      deviceId,
      role,
      role_requested,
      device_token,
      referral_token,
      ref,
    } = req.body;
    const promoterReferralToken = (
      referral_token ||
      ref ||
      req.query?.referral_token ||
      req.query?.ref ||
      ""
    ).trim();

    // Collect exact validation errors
    const errors = [];
    const data = { email: email || null };

    if (!email || (typeof email === "string" && email.trim() === "")) {
      errors.push("Email is required.");
    } else if (!isValidEmail(email)) {
      errors.push("Please provide a valid email address.");
    }

    const passwordErrors = validatePasswordStrength(password);
    if (passwordErrors.length > 0) errors.push(...passwordErrors);

    if (errors.length > 0) {
      return res.status(400).json({
        error: true,
        message: errors.length === 1 ? errors[0] : errors.join(" "),
        data: { ...data, errors },
      });
    }

    const isPromoterRequest = role_requested === "promoter" || role === "promoter";

    if (role_requested === "guru" || role === "guru") {
      return res.status(400).json({
        error: true,
        message: "The Guru role is no longer available. You can only choose: buyer or promoter.",
        data: null,
      });
    }

    if (role_requested === "network_manager" || role === "network_manager") {
      return res.status(400).json({
        error: true,
        message: "The Network Manager role is no longer available. You can only choose: buyer or promoter.",
        data: null,
      });
    }

    if (promoterReferralToken && !isPromoterRequest) {
      return res.status(400).json({
        error: true,
        message: "Referral token can only be used for promoter registration.",
        data: null,
      });
    }

    // Validate role if provided
    const allowedSelfAssignRoles = ["buyer", "promoter"];
    const adminOnlyRoles = ["admin", "staff_finance", "staff_rewards", "staff_charity", "founder", "kings_account"];

    if (role) {
      // Prevent self-assignment of admin-only roles
      if (adminOnlyRoles.includes(role)) {
        return res.status(403).json({
          error: true,
          message: `Role '${role}' cannot be self-assigned. Please contact an administrator.`,
          data: null,
        });
      }

      // Validate that only allowed roles can be self-assigned
      if (!allowedSelfAssignRoles.includes(role)) {
        return res.status(400).json({
          error: true,
          message: `Role '${role}' cannot be selected during registration. You can only choose: buyer or promoter.`,
          data: null,
        });
      }
    }

    // Check if email already exists
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existingUser.rowCount > 0) {
      return res.status(409).json({
        error: true,
        message: "This email address is already registered. Please log in instead.",
        data: { email },
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Buyers are active straight away. A self-registered Promoter stays 'pending' until the
    // application is submitted and the King approves it.
    const initialRole = isPromoterRequest ? "promoter" : "buyer";
    const accountStatus = isPromoterRequest ? "pending" : "active";
    const emailStatus = "pending";

    // Create user (name/city for buyer; promoters complete their profile in the application)
    const isBuyerRequest = initialRole === "buyer";
    const userName = isBuyerRequest && name && typeof name === "string" && name.trim() ? name.trim() : null;
    const userCity = city && typeof city === "string" && city.trim() ? city.trim() : null;
    const userResult = await pool.query(
      `
      INSERT INTO users (email, password_hash, name, city, status, role, account_status, email_status)
      VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
      RETURNING *
      `,
      [email, passwordHash, userName, userCity, initialRole, accountStatus, emailStatus]
    );

    const user = userResult.rows[0];

    // Promoter -> Promoter referral token (promoter_referrals)
    if (promoterReferralToken) {
      const flow1Check = await pool.query(
        `SELECT 1 FROM promoter_referrals WHERE referral_link_token = $1 LIMIT 1`,
        [promoterReferralToken]
      );
      if (flow1Check.rowCount === 0) {
        try {
          await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
        } catch (_) {}
        return res.status(400).json({
          error: true,
          message: "Invalid referral token.",
          data: null,
        });
      }
      try {
        await claimReferralOnRegister({
          token: promoterReferralToken,
          referredUserId: user.id,
        });
      } catch (claimErr) {
        try {
          await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
        } catch (_) {}
        const status = claimErr.status || 400;
        return res.status(status).json({
          error: true,
          message: claimErr.message || "Unable to apply referral token.",
          data: null,
        });
      }
    }

    if (user.role === "promoter") {
      const wClient = await pool.connect();
      try {
        await wClient.query("BEGIN");
        await ensurePromoterCreditWallet(wClient, user.id);
        await wClient.query("COMMIT");
      } catch (wErr) {
        try {
          await wClient.query("ROLLBACK");
        } catch (_) {}
        console.error("[register] ensurePromoterCreditWallet:", wErr.message);
      } finally {
        wClient.release();
      }

      // UX helper: pre-provision a shareable referral link for profile page.
      // This is best-effort and must not block registration.
      try {
        await ensureShareableReferralLinkForPromoter(user.id);
      } catch (_) {}
    }

    // Create OTP for email verification (buyers and promoters)
    const otpResult = await createOtp({
      email,
      purpose: "signup",
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    if (isPromoterRequest) {
      return res.status(201).json({
        error: false,
        message: "Registration successful. Please verify your email with the OTP sent to your inbox.",
        data: {
          email,
          userId: user.user_no ?? user.id,
          accountStatus,
          emailStatus,
          roleRequested: "promoter",
          otp: otpResult.otp, // In production, send via email only
          challengeId: otpResult.challengeId,
          "expires-in": otpResult.expiresIn,
        },
      });
    }

    return res.status(201).json({
      error: false,
      message: "Registration successful. Please verify your email with the OTP sent to your inbox.",
      data: {
        email,
        userId: user.user_no ?? user.id,
        otp: otpResult.otp, // In production, send via email only
        challengeId: otpResult.challengeId,
        "expires-in": otpResult.expiresIn,
        user: {
          ...mapUserForResponse(user),
          role: initialRole,
        },
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({
      error: true,
      message: "Something went wrong while creating your account. Please try again later.",
      data: { email: req.body?.email || null },
    });
  }
}

/* =======================
   LOGIN (Email + Password)
======================= */
async function login(req, res) {
  try {
    const { email, password, deviceId } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: true,
        message: "Email and password are required.",
        data: { email: email || null },
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: "Please provide a valid email address.",
        data: { email },
      });
    }

    // Find user
    const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (userResult.rowCount === 0) {
      return res.status(401).json({
        error: true,
        message: "Invalid email or password.",
        data: { email },
      });
    }

    const user = userResult.rows[0];

    if (user.status !== "active") {
      return res.status(403).json({
        error: true,
        message: "Your account is currently inactive. Please contact support.",
        data: { email },
      });
    }

    // Check account_status
    const accountStatus = user.account_status || "active";
    if (accountStatus === "blocked") {
      return res.status(403).json({
        error: true,
        message: "Your account has been blocked. Please contact support for assistance.",
        data: { email },
      });
    }

    if (user.role === "network_manager") {
      return res.status(403).json({
        error: true,
        message: "The Network Manager role is no longer available. Please contact support.",
        data: { email },
      });
    }

    // The Guru role has been removed. Existing Guru rows are kept in the database but can
    // no longer log in.
    if (user.role === "guru") {
      return res.status(403).json({
        error: true,
        message: "The Guru role is no longer available. Please contact support.",
        data: { email },
      });
    }

    // A Promoter invited by the King but not yet fully registered (no password_hash)
    // needs a specific, actionable error — not the generic "pending approval"
    // message below (see accountOnboardingStatus.service.js).
    if (!user.password_hash) {
      const inviteBlock = await getPendingPromoterInviteLoginBlock(user);
      if (inviteBlock) {
        return res.status(403).json({
          error: true,
          message: inviteBlock.message,
          code: inviteBlock.code,
          data: inviteBlock.data,
        });
      }
    }

    // A self-registered Promoter ('pending') who hasn't finished
    // onboarding (email not verified, or application not submitted) gets a specific
    // error. The password is checked first so these details are only revealed to the
    // real account owner; on a wrong password we fall through to the existing
    // behaviour unchanged.
    if (accountStatus === "pending" && user.password_hash) {
      const passwordOk = await bcrypt.compare(password, user.password_hash);
      if (passwordOk) {
        const onboardingBlock = await getIncompleteSelfRegisteredPromoterLoginBlock(user);
        if (onboardingBlock) {
          // Email is already verified and the password just checked out, so let the
          // client go straight to the application form: issue a normal session (same
          // as verifyOtpEmail does for this buyer-role account) instead of a 2nd OTP.
          if (onboardingBlock.code === "PROFILE_INCOMPLETE") {
            const session = await createSession({
              userId: user.id,
              deviceId: deviceId || null,
              ip: req.ip,
              userAgent: req.headers["user-agent"],
              roles: [user.role],
              rolesVersion: user.roles_version || 1,
            });
            onboardingBlock.data.accessToken = session.accessToken;
            onboardingBlock.data["expires-at"] = session.expiresAt;
            onboardingBlock.data.user = { ...mapUserForResponse(user), role: user.role };
          }
          return res.status(403).json({
            error: true,
            message: onboardingBlock.message,
            code: onboardingBlock.code,
            data: onboardingBlock.data,
          });
        }
      }
    }

    // A Buyer who never verified their email cannot log in yet. Same rule as above:
    // only revealed after the password checks out.
    const unverifiedBuyerBlock = user.password_hash ? getUnverifiedBuyerLoginBlock(user) : null;
    if (unverifiedBuyerBlock && (await bcrypt.compare(password, user.password_hash))) {
      return res.status(403).json({
        error: true,
        message: unverifiedBuyerBlock.message,
        code: unverifiedBuyerBlock.code,
        data: unverifiedBuyerBlock.data,
      });
    }

    // Block until account_status is active
    if (accountStatus !== "active") {
      return res.status(403).json({
        error: true,
        message: "Your account is pending approval. You cannot login until your application has been approved.",
        data: { email },
      });
    }

    // Check password
    if (!user.password_hash) {
      return res.status(401).json({
        error: true,
        message: "Invalid email or password.",
        data: { email },
      });
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({
        error: true,
        message: "Invalid email or password.",
        data: { email },
      });
    }

    if (user.role === "promoter" && accountStatus === "active") {
      const w = await pool.query(
        `SELECT 1 FROM promoter_credit_wallets WHERE promoter_id = $1 LIMIT 1`,
        [user.id]
      );
      if (w.rowCount === 0) {
        try {
          await ensurePromoterCreditWalletIfActivePromoter(user.id);
        } catch (e) {
          console.error("[login] ensurePromoterCreditWalletIfActivePromoter:", e.message);
        }
      }
    }

    // Update last login timestamp
    await pool.query(
      `
      UPDATE users
      SET last_login_at = NOW()
      WHERE id = $1
      `,
      [user.id]
    );

    // Create session with JWT tokens
    const session = await createSession({
      userId: user.id,
      deviceId: deviceId || null,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      roles: [user.role],
      rolesVersion: user.roles_version || 1,
    });

    const activeRole = user.role;
    const setupRequired = !user.name;
    const emailStatus = user.email_status || "pending";

    return res.json({
      error: false,
      message: "You have logged in successfully.",
      data: {
        email,
        userId: user.user_no ?? user.id,
        accessToken: session.accessToken,
        "expires-at": session.expiresAt,
        setupRequired,
        accountStatus,
        emailStatus,
        role: activeRole,
        user: {
          ...mapUserForResponse(user),
          role: activeRole,
          // accountStatus,
          emailStatus,
        },
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to log you in at the moment. Please try again later.",
      data: { email: req.body?.email || null },
    });
  }
}

/* =======================
   OAUTH REGISTER (Google/Facebook)
   POST /auth/oauth/register
   Supports applicationData for the approval-required promoter role
======================= */
async function oauthRegister(req, res) {
  const client = await pool.connect();
  try {
    const {
      email,
      name,
      oauthProvider,
      oauthId,
      avatarUrl,
      deviceId,
      deviceToken,
      role,
      role_requested,
      applicationData = {},
    } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: "Valid email is required.",
        data: { email },
      });
    }

    if (!oauthProvider || !oauthId) {
      return res.status(400).json({
        error: true,
        message: "OAuth provider and OAuth ID are required.",
        data: null,
      });
    }

    const hasExplicitRole = !!(role_requested || role);
    const effectiveRole = role_requested || role || "buyer";

    if (effectiveRole === "network_manager") {
      client.release();
      return res.status(400).json({
        error: true,
        message: "The Network Manager role is no longer available.",
        data: null,
      });
    }

    if (effectiveRole === "guru") {
      client.release();
      return res.status(400).json({
        error: true,
        message: "The Guru role is no longer available. You can only choose: buyer or promoter.",
        data: null,
      });
    }

    const isPromoterRequest = effectiveRole === "promoter";
    const isApprovalRequired = isPromoterRequest;

    // Check if user exists
    const existingUserResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    // New user with no role selected yet - require role selection (don't create)
    if (existingUserResult.rowCount === 0 && !hasExplicitRole && !applicationData?.city) {
      client.release();
      return res.json({
        error: false,
        message: "Please select your role to complete registration.",
        data: {
          requiresRoleSelection: true,
          email,
        },
      });
    }

    let user;
    let isNewUser = false;

    if (existingUserResult.rowCount > 0) {
      // Existing user - update OAuth info and attempt login
      user = existingUserResult.rows[0];

      await client.query(
        `
        UPDATE users
        SET
          name = COALESCE($1, name),
          avatar_url = COALESCE($2, avatar_url),
          oauth_provider = COALESCE($3, oauth_provider),
          oauth_id = COALESCE($4, oauth_id),
          email_status = 'verified',
          email_verified_at = COALESCE(email_verified_at, NOW()),
          updated_at = NOW()
        WHERE id = $5
        RETURNING *
        `,
        [name || user.name, avatarUrl || user.avatar_url, oauthProvider, oauthId, user.id]
      );

      const updatedResult = await client.query("SELECT * FROM users WHERE id = $1", [user.id]);
      user = updatedResult.rows[0];
    } else {
      // Create new user
      isNewUser = true;

      await client.query("BEGIN");

      const initialRole = isPromoterRequest ? "promoter" : "buyer";
      const accountStatus = isApprovalRequired ? "pending" : "active";

      const buyerCity = effectiveRole === "buyer" ? (applicationData.city || null) : null;
      const createResult = await client.query(
        `
        INSERT INTO users (
          email, password_hash, name, city, avatar_url, status, role,
          account_status, email_status, email_verified_at,
          oauth_provider, oauth_id
        )
        VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, 'verified', NOW(), $8, $9)
        RETURNING *
        `,
        [email, null, name || null, buyerCity, avatarUrl || null, initialRole, accountStatus, oauthProvider, oauthId]
      );

      user = createResult.rows[0];

      // Create application records for approval-required roles
      if (isPromoterRequest) {
        const { agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms } = applicationData;
        const oauthPhone = typeof applicationData.phone === "string" ? applicationData.phone.trim().replace(/\s+/g, "") : "";
        if (!/^\+[1-9]\d{1,14}$/.test(oauthPhone)) {
          await client.query("ROLLBACK");
          client.release();
          return res.status(422).json({
            error: true,
            message: "A phone number in E.164 format (e.g., +447911123456) is required for Promoter application.",
            data: null,
          });
        }
        await client.query("UPDATE users SET phone = $1 WHERE id = $2", [oauthPhone, user.id]);
        if (!agreed_to_terms || !agreed_to_promoter_agreement || !agreed_to_activation_fee_terms) {
          await client.query("ROLLBACK");
          client.release();
          return res.status(400).json({
            error: true,
            message: "Agreement to all terms is required for Promoter application.",
            data: null,
          });
        }
        await client.query(
          `INSERT INTO promoter_applications
            (user_id, territory_name, avatar_url, agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms, account_status)
          VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
          [user.id, applicationData.territory_name || null, avatarUrl || null, agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms]
        );
      }

      if (user.role === "promoter") {
        await ensurePromoterCreditWallet(client, user.id);
      }

      await client.query("COMMIT");
    }

    // Users with NULL role (legacy pending applicants) cannot login
    if (user.role === null || user.role === undefined) {
      client.release();
      return res.json({
        error: false,
        message: "Application submitted successfully. You will be notified once approved.",
        data: {
          pendingApproval: true,
          role: effectiveRole,
          email,
          message: "Your application has been submitted. You cannot login until your application has been approved.",
        },
      });
    }

    if (user.role === "guru") {
      client.release();
      return res.status(403).json({
        error: true,
        message: "The Guru role is no longer available. Please contact support.",
        data: { email },
      });
    }

    if (user.role === "network_manager") {
      client.release();
      return res.status(403).json({
        error: true,
        message: "The Network Manager role is no longer available. Please contact support.",
        data: { email },
      });
    }

    // Block promoters from logging in until approved by the King (account_status = 'active')
    if (user.role === "promoter" && user.account_status !== "active") {
      client.release();
      return res.json({
        error: false,
        message: "Application submitted successfully. You will be notified once approved.",
        data: {
          pendingApproval: true,
          role: user.role,
          email,
          message: "Your application has been submitted. You cannot login until your application has been approved.",
        },
      });
    }

    // Create session for approved/active users
    const session = await createSession({
      userId: user.id,
      deviceId: deviceId || null,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      roles: [user.role],
      rolesVersion: user.roles_version || 1,
    });

    const activeRole = user.role;
    const setupRequired = !user.name;

    client.release();

    return res.json({
      error: false,
      message: isNewUser ? "Account created successfully via OAuth." : "Logged in successfully via OAuth.",
      data: {
        email,
        userId: user.user_no ?? user.id,
        accessToken: session.accessToken,
        "expires-at": session.expiresAt,
        setupRequired,
        accountStatus: user.account_status || "active",
        emailStatus: "verified",
        isNewUser,
        user: {
          ...mapUserForResponse(user),
          role: activeRole,
          emailStatus: "verified",
        },
      },
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) { }
    if (client) client.release();
    console.error("OAuth register error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to complete OAuth authentication.",
      data: { email: req.body?.email || null },
    });
  }
}


/**
 * POST /api/auth/oauth/callback
 * Handle OAuth callback from Clerk - exchange Clerk token for app tokens
 */
async function oauthCallback(req, res) {
  try {
    const { oauth_provider, oauth_id, email, name, avatar_url } = req.body;

    // Get Clerk token from authorization header
    const clerkToken = req.headers.authorization?.replace('Bearer ', '');

    if (!clerkToken) {
      return res.status(401).json({
        success: false,
        message: 'No Clerk token provided'
      });
    }

    // Verify the Clerk token (you may need to use Clerk's API)
    // For now, we'll check if user exists in our DB

    // Check if user already exists
    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    const user = userResult.rows[0];

    if (user) {
      // Existing user - return tokens
      const accessToken = generateAccessToken(user);

      return res.json({
        success: true,
        data: {
          user: {
            userId: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            emailStatus: user.email_status,
            accountStatus: user.account_status,
            setupRequired: user.setup_required,
            avatarUrl: user.avatar_url
          },
          userId: user.id,
          email: user.email,
          role: user.role,
          emailStatus: user.email_status,
          accountStatus: user.account_status,
          setupRequired: user.setup_required,
          accessToken,
          'expires-at': getTokenExpiry()
        }
      });
    } else {
      // New OAuth user - return minimal data for role selection
      return res.json({
        success: true,
        data: {
          isNewUser: true,
          oauthData: {
            oauth_provider,
            oauth_id,
            email,
            name,
            avatar_url
          },
          message: 'Please select a role to complete registration'
        }
      });
    }
  } catch (error) {
    console.error('OAuth callback error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'OAuth callback failed'
    });
  }
};


/* =======================
   VERIFY EMAIL
======================= */
async function verifyEmail(req, res) {
  try {
    const { token, otp } = req.body;

    // Backward compatibility: OTP-based email verification payloads
    // should be handled by the OTP verification flow.
    if (otp) {
      return verifyOtpEmail(req, res);
    }

    if (!token) {
      return res.status(400).json({
        error: true,
        message: "Verification token is required.",
        data: null,
      });
    }

    // Verify token
    const tokenResult = await pool.query(
      `
      SELECT user_id, expires_at, consumed_at
      FROM email_verification_tokens
      WHERE token = $1
      `,
      [token]
    );

    if (tokenResult.rowCount === 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid verification token.",
        data: null,
      });
    }

    const tokenRecord = tokenResult.rows[0];

    if (tokenRecord.consumed_at) {
      return res.status(400).json({
        error: true,
        message: "This verification token has already been used.",
        data: null,
      });
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(400).json({
        error: true,
        message: "Verification token has expired. Please request a new one.",
        data: null,
      });
    }

    // Mark email as verified
    await pool.query(
      `
      UPDATE users
      SET email_verified_at = NOW()
      WHERE id = $1
      `,
      [tokenRecord.user_id]
    );

    // Mark token as consumed
    await pool.query(
      `
      UPDATE email_verification_tokens
      SET consumed_at = NOW()
      WHERE token = $1
      `,
      [token]
    );

    // Get user and create session
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [
      tokenRecord.user_id,
    ]);
    const user = userResult.rows[0];

    // Users with no role yet (pending applications) cannot login
    if (user.role === null || user.role === undefined) {
      return res.status(403).json({
        error: true,
        message: "Your account is pending approval. You cannot login until your application is approved.",
        data: null,
      });
    }

    // Block promoters from logging in until approved by the King (account_status = 'active')
    if (user.role === 'promoter' && user.account_status !== 'active') {
      return res.status(403).json({
        error: true,
        message: "Your account is pending approval. You cannot login until your application has been approved.",
        data: null,
      });
    }

    const session = await createSession({
      userId: user.id,
      deviceId: req.body.deviceId || null,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      roles: [user.role],
      rolesVersion: user.roles_version || 1,
    });

    return res.json({
      error: false,
      message: "Your email has been verified successfully. You are now logged in.",
      data: {
        email: user.email,
        userId: user.user_no ?? user.id,
        accessToken: session.accessToken,
        "expires-at": session.expiresAt,
        user: {
          ...mapUserForResponse(user),
          role: user.role,
        },
      },
    });
  } catch (err) {
    console.error("Verify email error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to verify your email at the moment. Please try again later.",
      data: null,
    });
  }
}

/* =======================
   FORGOT PASSWORD
======================= */
async function forgotPassword(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: true,
        message: "Email address is required.",
        data: { email: null },
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: "Please provide a valid email address.",
        data: { email },
      });
    }

    // Find user with name for email personalization
    const userResult = await pool.query(
      "SELECT id, name FROM users WHERE email = $1",
      [email]
    );

    // Always return success to prevent email enumeration
    if (userResult.rowCount === 0) {
      return res.json({
        error: false,
        message: "If an account exists with this email, a password reset link has been sent.",
        data: { email },
      });
    }


    const user = userResult.rows[0];

    // Create reset token
    const resetToken = generatePasswordResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      `
      INSERT INTO password_reset_tokens (user_id, token, expires_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (token) DO NOTHING
      `,
      [user.id, resetToken, expiresAt]
    );

    // Send password reset email
    try {
      await sendPasswordResetEmail(email, resetToken, user.name);
    } catch (emailError) {
      console.error("Failed to send password reset email:", emailError);
      // Don't fail the request if email sending fails
      // User might still have the token from development logs
    }

    return res.json({
      error: false,
      message: "If an account exists with this email, a password reset link has been sent.",
      data: {
        email,
        resetToken,
      },
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to process your request at the moment. Please try again later.",
      data: { email: req.body?.email || null },
    });
  }
}

/* =======================
   RESET PASSWORD
======================= */
async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        error: true,
        message: "Reset token and new password are required.",
        data: null,
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: true,
        message: "Password must be at least 8 characters long.",
        data: null,
      });
    }

    // Verify token
    const tokenResult = await pool.query(
      `
      SELECT user_id, expires_at, consumed_at
      FROM password_reset_tokens
      WHERE token = $1
      `,
      [token]
    );

    if (tokenResult.rowCount === 0) {
      return res.status(400).json({
        error: true,
        message: "Invalid or expired reset token.",
        data: null,
      });
    }

    const tokenRecord = tokenResult.rows[0];

    if (tokenRecord.consumed_at) {
      return res.status(400).json({
        error: true,
        message: "This reset token has already been used.",
        data: null,
      });
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(400).json({
        error: true,
        message: "Reset token has expired. Please request a new one.",
        data: null,
      });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await pool.query(
      `
      UPDATE users
      SET password_hash = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [passwordHash, tokenRecord.user_id]
    );

    // Mark token as consumed
    await pool.query(
      `
      UPDATE password_reset_tokens
      SET consumed_at = NOW()
      WHERE token = $1
      `,
      [token]
    );

    // Revoke all existing sessions for security
    await revokeAllUserSessions(tokenRecord.user_id, "password_reset");

    return res.json({
      error: false,
      message: "Your password has been reset successfully. Please log in with your new password.",
      data: {
        success: true,
      },
    });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to reset your password at the moment. Please try again later.",
      data: null,
    });
  }
}

/* =======================
   RESEND OTP
======================= */
async function resendOtp(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: true,
        message: "Email address is required.",
        data: { email: null },
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: "Please provide a valid email address.",
        data: { email },
      });
    }

    // Get user by email
    const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "User not found.",
        data: { email },
      });
    }

    const user = userResult.rows[0];

    // Create new OTP for signup verification
    const otpResult = await createOtp({
      email: user.email,
      purpose: "signup",
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      error: false,
      message: "OTP has been sent to your email address.",
      data: {
        email: user.email,
        userId: user.user_no ?? user.id,
        otp: otpResult.otp, // In production, send via email only
        challengeId: otpResult.challengeId,
        "expires-in": otpResult.expiresIn,
      },
    });
  } catch (err) {
    console.error("Resend OTP error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to resend OTP at the moment. Please try again later.",
      data: null,
    });
  }
}

/* =======================
   LOGOUT ALL DEVICES
======================= */
async function logoutAll(req, res) {
  try {
    await revokeAllUserSessions(req.user.id, "logout_all");

    return res.json({
      error: false,
      message: "You have been logged out from all devices successfully.",
      data: {
        loggedOut: true,
      },
    });
  } catch (err) {
    return res.status(400).json({
      error: true,
      message: "Unable to log you out at the moment. Please try again.",
      data: null,
    });
  }
}

/* =======================
   SET ACTIVE ROLE
======================= */
async function setActiveRole(req, res) {
  try {
    return res.json({
      error: false,
      message: "Single-role system: active role cannot be changed.",
      data: {
        user: {
          ...mapUserForResponse(req.user),
          role: req.user.role,
        },
      },
    });
  } catch (err) {
    console.error("Set active role error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to update active role at the moment. Please try again later.",
      data: null,
    });
  }
}


async function kingsRegister(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: "Valid email is required.",
        data: { email: email || null },
      });
    }

    const passwordErrors = validatePasswordStrength(password);
    if (passwordErrors.length > 0) {
      return res.status(400).json({
        error: true,
        message: passwordErrors.length === 1 ? passwordErrors[0] : passwordErrors.join(" "),
        data: { email, errors: passwordErrors },
      });
    }

    // Block in production
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({
        error: true,
        message: "Public registration is disabled.",
        data: null,
      });
    }

    // Check if already exists
    const existing = await pool.query(
      `SELECT id, email, role FROM users WHERE email = $1`,
      [email]
    );

    if (existing.rowCount > 0) {
      return res.json({
        error: false,
        message: "This email is already registered. Please log in instead.",
        data: existing.rows[0],
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO users (email, password_hash, role, status, email_status)
      VALUES ($1, $2, 'kings_account', 'active', 'verified')
      RETURNING id, email, role
      `,
      [email, passwordHash]
    );

    return res.status(201).json({
      error: false,
      message: "Kings account created successfully.",
      data: result.rows[0],
    });

  } catch (err) {
    console.error("Kings register error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to create Kings account.",
      data: null,
    });
  }
}

async function kingsSendOtp(req, res) {
  try {
    const { email } = req.body;

    const userResult = await pool.query(
      `SELECT * FROM users 
       WHERE email = $1 
       AND role = 'kings_account'
       AND status = 'active'`,
      [email]
    );

    if (userResult.rowCount === 0) {
      return res.status(403).json({
        error: true,
        message: "Access denied.",
        data: { email },
      });
    }

    const otpResult = await createOtp({
      email,
      purpose: "kings_login",
    });

    return res.json({
      error: false,
      message:
        "A verification code has been sent to your email address. Please check your inbox.",
      data: {
        email,
        challengeId: otpResult.challengeId,   // 🔥 ADD THIS
        "expires-in": otpResult.expiresIn,
        ...(process.env.NODE_ENV === "development" && { otp: otpResult.otp }),
      },
    });

  } catch (err) {
    console.error("Kings send OTP error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to send OTP.",
      data: null,
    });
  }
}
async function kingsVerifyOtp(req, res) {
  try {
    const { email, otp, challengeId } = req.body;

    if (!email || !otp || !challengeId) {
      return res.status(400).json({
        error: true,
        message: "Email, OTP and challengeId are required.",
        data: { email: email || null },
      });
    }

    const userResult = await pool.query(
      `SELECT * FROM users 
       WHERE email = $1 
       AND role = 'kings_account'
       AND status = 'active'`,
      [email]
    );

    if (userResult.rowCount === 0) {
      return res.status(403).json({
        error: true,
        message: "Access denied.",
        data: { email },
      });
    }

    try {
      await verifyOtp({
        challengeId,
        email,
        otp,
      });
    } catch (err) {
      return res.status(400).json({
        error: true,
        message: err.message,
        data: { email },
      });
    }

    const user = userResult.rows[0];

    const session = await createSession({
      userId: user.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      roles: ["kings_account"],
      rolesVersion: user.roles_version || 1,
    });

    await pool.query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
      [user.id]
    );

    return res.json({
      error: false,
      message: "Login successful.",
      data: {
        email: user.email,
        role: "kings_account",
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
      },
    });

  } catch (err) {
    console.error("Kings verify OTP error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to verify OTP.",
      data: null,
    });
  }
}

/**
 * POST /api/v1/auth/change-password
 * Change user password (Settings Module - Module 2)
 * 
 * Requirements:
 * - Validate current password against stored hash before processing
 * - New password must not match current password
 * - New password and confirm new password must match
 * - Enforce minimum password strength (min 8 chars, at least 1 number and 1 uppercase)
 * - On success: keep current session active but invalidate all other active sessions
 * - Log password change event with timestamp and IP
 * 
 * Request: { current_password, new_password, confirm_new_password }
 * Response: { success: true, message: "..." }
 */
async function changePasswordV1(req, res) {
  try {
    const { current_password, new_password, confirm_new_password } = req.body;
    const userId = req.user.id;

    // VALIDATION 1: All fields are required
    if (!current_password || !new_password || !confirm_new_password) {
      return res.status(400).json({
        error: true,
        message: "Current password, new password, and confirm new password are all required.",
        data: null,
      });
    }

    // VALIDATION 2: New password and confirm must match
    if (new_password !== confirm_new_password) {
      return res.status(400).json({
        error: true,
        message: "New password and confirm new password do not match.",
        data: null,
      });
    }

    // Get user with password hash
    const userResult = await pool.query(
      "SELECT id, password_hash FROM users WHERE id = $1",
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

    // VALIDATION 3: Verify current password is correct
    const passwordValid = await bcrypt.compare(current_password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({
        error: true,
        message: "Current password is incorrect.",
        data: null,
      });
    }

    // VALIDATION 4: New password must not match current password
    const sameAsOld = await bcrypt.compare(new_password, user.password_hash);
    if (sameAsOld) {
      return res.status(409).json({
        error: true,
        message: "New password is the same as current password.",
        data: null,
      });
    }

    // VALIDATION 5: Enforce password strength (min 8 chars, 1 number, 1 uppercase)
    const passwordStrengthErrors = validatePasswordStrength(new_password);
    if (passwordStrengthErrors.length > 0) {
      return res.status(422).json({
        error: true,
        message: "Password does not meet strength requirements.",
        data: {
          errors: passwordStrengthErrors,
        },
      });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(new_password, 12);

    // Update password
    await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
      [passwordHash, userId]
    );

    // Log password change event (optional audit trail)
    try {
      await pool.query(
        `INSERT INTO profile_audit_logs (user_id, action_type, action_details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, "change_password", JSON.stringify({ status: "changed" }), req.ip, req.get("user-agent")]
      );
    } catch (logErr) {
      console.error("Note: Audit logging table not available (optional):", logErr.message);
      // Don't block password change if logging fails
    }

    // Invalidate all other active sessions for security (keep current session active)
    // The revokeAllUserSessions function should skip the current session
    try {
      await revokeAllUserSessions(userId, "password_change", req.sessionId);
    } catch (sessionErr) {
      console.error("Error revoking other sessions:", sessionErr);
      // Don't block password change if session revocation fails
    }

    return res.status(200).json({
      error: false,
      message: "Password updated successfully. Other sessions have been signed out.",
      data: {
        success: true,
      },
    });
  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to change password at the moment.",
      data: null,
    });
  }
}

/**
 * POST /api/auth/promoters/invites
 * Create Promoter Invite (King's Account, founder or admin)
 * 
 * AUTHORIZATION: Only kings_account, founder or admin can invite promoters
 * 
 * Requirements:
 * - The King creates a time-limited (15 min) invite link for a Promoter
 * - Invited promoters are approved automatically once they accept (no separate approval step)
 * - Email is sent with referral link
 * - Referral token must be validated before registration
 * - Token expires after 15 minutes
 * 
 * Request: { email, name?, expires_in_minutes?: 15 }
 * Response: { referral_token, registration_url, email, expires_at }
 */
async function createPromoterReferralInvite(req, res) {
  const client = await pool.connect();
  try {
    // AUTHORIZATION: Only kings_account, founder or admin can invite promoters
    const allowedRoles = ['kings_account', 'founder', 'admin'];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: true,
        message: "Only the King's Account can invite promoters.",
        data: null,
      });
    }

    const { email, name = '', expires_in_minutes = 15 } = req.body;
    const inviterId = req.user.id;

    // VALIDATION: Email is required
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: "Valid email is required.",
        data: { email: email || null },
      });
    }

    // VALIDATION: Expires in minutes must be positive (1-1440 = 1 minute to 24 hours)
    if (expires_in_minutes && (expires_in_minutes < 1 || expires_in_minutes > 1440)) {
      return res.status(400).json({
        error: true,
        message: "Expires in minutes must be between 1 and 1440 (24 hours).",
        data: { expires_in_minutes },
      });
    }

    // Check if email already exists
    const existingUser = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existingUser.rowCount > 0) {
      return res.status(409).json({
        error: true,
        message: "Email is already registered.",
        data: { email },
      });
    }

    await client.query("BEGIN");

    // Create a pending promoter user immediately so the King can see and manage them from the portal
    const pendingUserResult = await client.query(
      `INSERT INTO users (email, name, role, status, account_status, email_status)
       VALUES ($1, $2, 'promoter', 'active', 'pending', 'pending')
       RETURNING id`,
      [email, String(name || "").trim() || null]
    );
    const pendingPromoterUserId = pendingUserResult.rows[0].id;

    await client.query(
      `INSERT INTO promoter_profiles (user_id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [pendingPromoterUserId]
    );

    // Generate referral token (UUID-like token)
    const referralToken = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + expires_in_minutes * 60 * 1000);

    // Create referral invite record
    const inviteResult = await client.query(
      `INSERT INTO promoter_referral_invites (email, name, referral_token, kings_account_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, referral_token, expires_at, email`,
      [email, name, referralToken, inviterId, expiresAt]
    );

    const invite = inviteResult.rows[0];


    // Build registration URL
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const registrationUrl = `${baseUrl}/auth/promoter/register?referral_token=${referralToken}`;

    // SEND EMAIL with referral link
    try {
      await sendPromoterReferralInviteEmail({
        email,
        registrationUrl,
        expiresInMinutes: expires_in_minutes,
      });
    } catch (emailError) {
      console.warn(`[PROMOTER REFERRAL] Email sending failed for ${email}:`, emailError.message);
      // Continue - don't fail the API if email fails
    }

    await client.query("COMMIT");

    // Return success response
    return res.status(201).json({
      error: false,
      message: `Promoter referral invitation has been sent to ${email}. The link expires in ${expires_in_minutes} minutes.`,
      data: {
        email: invite.email,
        sent_at: new Date(),
        expires_at: invite.expires_at,
        expires_in_minutes: expires_in_minutes,
        // For testing/admin purposes only:
        referral_token: invite.referral_token,
        registration_url: registrationUrl,
      },
    });

  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("Create promoter referral invite error:", err);
    return res.status(500).json({
      error: true,
      message: "An error occurred while creating the referral invite.",
      data: null,
    });
  } finally {
    client.release();
  }
}

/**
 * POST /api/v1/promoter/referral-invites/resend
 * Resend Promoter Referral Invite (Token Expired) - PUBLIC ENDPOINT
 * 
 * ⭐ THIS IS A PUBLIC ENDPOINT (NO AUTHENTICATION REQUIRED)
 * 
 * When a promoter's referral token expires, the frontend shows a "Resend Invitation" button.
 * The promoter (without login) provides their email to request a new invite.
 * 
 * Flow:
 * 1. Promoter receives referral email with token + link
 * 2. Promoter doesn't click link for 15+ minutes (token expires)
 * 3. Promoter clicks "Resend Invitation" button on frontend (unauthenticated)
 * 4. Frontend makes POST to this endpoint with email
 * 5. Backend generates NEW token, updates invite record, sends NEW email
 * 6. Promoter receives fresh referral email with new token + link
 * 
 * Request: { email } OR { referral_token }
 * - email: The email address promoter was invited with (PREFERRED)
 * - referral_token: The old expired token (fallback if email lost)
 * 
 * Response: 
 * - 200: Invitation resent successfully
 * - 400: Missing email and referral_token
 * - 404: No invitation found for this email/token
 * - 409: Invitation already used (promoter already registered)
 * - 500: Server error
 */
async function resendPromoterReferralInvite(req, res) {
  try {
    const { referral_token, email } = req.body;

    // VALIDATION: Either referral_token or email must be provided
    if (!referral_token && !email) {
      return res.status(400).json({
        error: true,
        message: "Either 'email' or 'referral_token' is required.",
        data: null,
      });
    }

    // Find the original invitation
    let inviteResult;
    if (email) {
      // PREFERRED: Search by email (promoter knows their own email)
      inviteResult = await pool.query(
        `SELECT pri.*
         FROM promoter_referral_invites pri
         WHERE pri.email = $1 AND pri.used_at IS NULL
         ORDER BY pri.created_at DESC
         LIMIT 1`,
        [email]
      );
    } else {
      // FALLBACK: Search by old token
      inviteResult = await pool.query(
        `SELECT pri.*
         FROM promoter_referral_invites pri
         WHERE pri.referral_token = $1`,
        [referral_token]
      );
    }

    if (inviteResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "No referral invitation found. Please check your email. If you don't have an invitation, ask the King's Account to send one.",
        data: { email: email || null },
      });
    }

    const originalInvite = inviteResult.rows[0];

    // Check if invitation was already used
    if (originalInvite.used_at) {
      return res.status(409).json({
        error: true,
        message: "This referral invitation was already accepted. Please log in to your account.",
        data: { email: originalInvite.email },
      });
    }

    // Get expiration time (default 15 minutes)
    const expires_in_minutes = 15;
    const newExpiresAt = new Date(Date.now() + expires_in_minutes * 60 * 1000);

    // Generate new referral token
    const newReferralToken = require('crypto').randomBytes(32).toString('hex');

    // Update the invitation with new token and expiry
    const updateResult = await pool.query(
      `UPDATE promoter_referral_invites
       SET referral_token = $1,
           expires_at = $2
       WHERE id = $3
       RETURNING id, referral_token, expires_at, email`,
      [newReferralToken, newExpiresAt, originalInvite.id]
    );

    const updatedInvite = updateResult.rows[0];

    // Build registration URL
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const registrationUrl = `${baseUrl}/auth/promoter/register?referral_token=${newReferralToken}`;

    // SEND EMAIL with new referral link
    try {
      await sendPromoterReferralInviteResendEmail({
        email: updatedInvite.email,
        registrationUrl,
        expiresInMinutes: expires_in_minutes,
      });
    } catch (emailError) {
      console.warn(`[PROMOTER REFERRAL RESEND] ⚠️ Email failed for ${updatedInvite.email}:`, emailError.message);
      // Continue - don't fail API if email delivery fails
    }

    // Return success response
    return res.status(200).json({
      error: false,
      message: `New invitation sent to ${updatedInvite.email}! Check your inbox. This link expires in ${expires_in_minutes} minutes.`,
      data: {
        email: updatedInvite.email,
        resent_at: new Date(),
        expires_at: updatedInvite.expires_at,
        expires_in_minutes: expires_in_minutes,
        referral_token: updatedInvite.referral_token,
        registration_url: registrationUrl,
      },
    });

  } catch (err) {
    console.error("Resend promoter referral invite error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to resend referral invitation. Please try again later.",
      data: null,
    });
  }
}

/**
 * POST /api/auth/promoter/register
 * Promoter Registration via King Invite Link
 *
 * Requirements:
 * - POST registration must include the invite referral_token in the request body
 * - The email always comes from the invite, never from the request
 * - Invited promoters are active immediately (the King's invite is the approval)
 * - Invite is invalidated after use
 *
 * Request: { name, password, phone, referral_token }
 * Response: { access_token, user: { ...user_data } }
 *
 * Error Responses:
 * - 400: Missing required fields
 * - 401: Invite token invalid
 * - 410: Invite token expired
 * - 409: Invite already used
 */

async function promoterRegisterViaReferral(req, res) {
  const client = await pool.connect();
  try {
    const { name, password, phone, referral_token } = req.body;

    // VALIDATION
    const errors = [];
    if (!referral_token) errors.push("Invite token is required.");
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      errors.push("Name is required.");
    }
    if (!password) errors.push("Password is required.");
    if (!phone) errors.push("Phone number is required.");

    if (errors.length > 0) {
      client.release();
      return res.status(400).json({
        error: true,
        message: "Missing required fields.",
        data: { errors },
      });
    }

    // PASSWORD VALIDATION
    const passwordErrors = validatePasswordStrength(password);
    if (passwordErrors.length > 0) {
      client.release();
      return res.status(400).json({
        error: true,
        message: "Password does not meet strength requirements.",
        data: { errors: passwordErrors },
      });
    }

    // PHONE VALIDATION
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phone)) {
      client.release();
      return res.status(422).json({
        error: true,
        message: "Phone number must be in E.164 format (e.g., +447911123456).",
        data: { phone },
      });
    }

    // STEP 1: VALIDATE INVITE TOKEN
    const result = await client.query(
      `SELECT * FROM promoter_referral_invites WHERE referral_token = $1`,
      [referral_token]
    );

    if (result.rowCount === 0) {
      client.release();
      return res.status(401).json({
        error: true,
        message: "Invite token is invalid.",
      });
    }

    const invite = result.rows[0];

    if (invite.used_at) {
      client.release();
      return res.status(409).json({
        error: true,
        message: "This invitation has already been used.",
      });
    }

    if (new Date(invite.expires_at) < new Date()) {
      client.release();
      return res.status(410).json({
        error: true,
        message: "This invitation has expired.",
      });
    }

    // ALWAYS TAKE EMAIL FROM INVITE
    const email = invite.email;

    // STEP 2: FIND THE PENDING USER PRE-CREATED BY THE INVITE
    const pendingUserResult = await client.query(
      `SELECT id, password_hash, account_status
       FROM users
       WHERE email = $1
       ORDER BY created_at ASC
       LIMIT 1`,
      [email]
    );
    const invitedPendingUserId = pendingUserResult.rows[0]?.id ?? null;

    if (pendingUserResult.rows[0]?.password_hash) {
      client.release();
      return res.status(409).json({
        error: true,
        message: "This email address is already registered. Please log in instead.",
      });
    }
    if (pendingUserResult.rows[0]?.account_status === "blocked") {
      client.release();
      return res.status(403).json({
        error: true,
        message: "This account has been blocked. Please contact support.",
      });
    }

    // STEP 3: CREATE / ACTIVATE USER
    await client.query("BEGIN");

    const passwordHash = await bcrypt.hash(password, 12);

    let user;
    if (invitedPendingUserId) {
      const updatedUserResult = await client.query(
        `UPDATE users
         SET password_hash = $1,
             name = $2,
             phone = $3,
             role = 'promoter',
             status = 'active',
             account_status = 'active',
             email_status = 'verified',
             email_verified_at = NOW(),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [passwordHash, name.trim(), phone, invitedPendingUserId]
      );
      user = updatedUserResult.rows[0];
    } else {
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, name, phone, role, status, account_status, email_status, email_verified_at)
         VALUES ($1, $2, $3, $4, 'promoter', 'active', 'active', 'verified', NOW())
         RETURNING *`,
        [email, passwordHash, name.trim(), phone]
      );
      user = userResult.rows[0];
    }

    await client.query(
      `INSERT INTO promoter_profiles (user_id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()`,
      [user.id]
    );

    await ensurePromoterCreditWallet(client, user.id);

    // MARK INVITE USED
    await client.query(
      `UPDATE promoter_referral_invites
       SET used_at = NOW()
       WHERE id = $1`,
      [invite.id]
    );

    await client.query("COMMIT");
    client.release();

    // SESSION
    const session = await createSession({
      userId: user.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      roles: ["promoter"],
      rolesVersion: user.roles_version || 1,
    });

    return res.status(201).json({
      error: false,
      message: "Promoter registration successful.",
      data: {
        access_token: session.accessToken,
        expires_at: session.expiresAt,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: "promoter",
        },
      },
    });

  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    try { client.release(); } catch (_) {}

    console.error("Promoter registration error:", err);

    return res.status(500).json({
      error: true,
      message: "Registration failed. Try again.",
    });
  }
}

/**
 * GET /api/auth/referrals/validate/:token
 * Validate a promoter invite token.
 *
 * Response: { valid: true, email, name }
 *
 * Error Responses:
 * - 401: Invite token invalid
 * - 409: Invite already used
 * - 410: Invite token expired
 */
async function validateReferralToken(req, res) {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({
        error: true,
        message: "Invite token is required.",
        data: null,
      });
    }

    const inviteResult = await pool.query(
      `SELECT * FROM promoter_referral_invites WHERE referral_token = $1`,
      [token]
    );

    if (inviteResult.rowCount === 0) {
      return res.status(401).json({
        error: true,
        message: "Invite token is invalid.",
        data: { valid: false, token },
      });
    }

    const invite = inviteResult.rows[0];

    if (invite.used_at) {
      return res.status(409).json({
        error: true,
        message: "This invitation has already been used.",
        data: { valid: false, token },
      });
    }

    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({
        error: true,
        message: "Invite token has expired.",
        data: { valid: false, token },
      });
    }

    return res.json({
      error: false,
      message: "Invite token is valid.",
      data: {
        valid: true,
        email: invite.email,
        name: invite.name || null,
        token_type: "promoter_invite",
      },
    });
  } catch (err) {
    console.error("Validate invite token error:", err);
    return res.status(500).json({
      error: true,
      message: "An error occurred while validating the invite token. Please try again later.",
      data: null,
    });
  }
}


module.exports = {
  kingsRegister,
  kingsSendOtp,
  kingsVerifyOtp,
  // kingsMe,
  // kingsLogout,
  getMe,
  logout,
  setupAccount,
  updateProfile,
  // Email/password endpoints
  register,
  login: login,
  oauthRegister,
  oauthCallback,
  resendOtp,
  verifyEmail,
  forgotPassword,
  resetPassword,
  logoutAll,
  setActiveRole,
  // OTP verification
  verifyOtpEmail,
  // Settings module - change password
  changePasswordV1,
  // Promoter registration via King invite
  promoterRegisterViaReferral,
  validateReferralToken,
  createPromoterReferralInvite,
  resendPromoterReferralInvite,
};
