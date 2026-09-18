const { createOtp, verifyOtp } = require("../services/otp.service");
const { createSession, validateRefreshToken, refreshAccessToken, revokeAllUserSessions } = require("../services/session.service");
const pool = require("../db");
const bcrypt = require("bcryptjs");
const { generatePasswordResetToken } = require("../utils/crypto");
const { ok, fail } = require("../utils/standardResponse");
const GuruService = require("../services/guru.service");
const ReferralService = require("../services/referral.service");
const { sendPasswordResetEmail } = require("../services/email.service");
const { sendOtpEmail } = require("../services/email.service");
const {
  sendGuruInviteEmail,
  sendGuruInviteResendEmail,
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
   OTP VERIFY (Network Manager email verification)
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
        message: otpError.message || "Invalid or expired OTP. Please try again.",
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

    // Users with NULL role (Network Manager applicants) can login if email is verified
    // They need to setup their account and submit their application
    if (updatedUser.role === null || updatedUser.role === undefined) {
      if (updatedUser.email_status !== 'verified') {
        return res.status(403).json({
          error: true,
          message: "Please verify your email first before logging in.",
          data: { userId },
        });
      }
    }

    // Create JWT session
    const sessionRoles = updatedUser.role ? [updatedUser.role] : ['network_manager_applicant'];
    const session = await createSession({
      userId: user.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      roles: sessionRoles,
      rolesVersion: updatedUser.roles_version || 1,
    });

    return res.json({
      error: false,
      message: updatedUser.role === null
        ? "Email verified successfully. Please complete your account setup and submit your Network Manager application."
        : "Email verified successfully. You are now logged in.",
      data: {
        userId: updatedUser.user_no ?? updatedUser.id,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        "expires-at": otpRecord.expires_at,
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

    // Get Network Manager application if exists
    let networkManagerApplication = null;
    const nmAppResult = await pool.query(
      `
      SELECT id, territory_name, account_status, created_at, reviewed_at
      FROM network_manager_applications
      WHERE user_id = $1
      `,
      [req.user.id]
    );

    if (nmAppResult.rowCount > 0) {
      networkManagerApplication = {
        id: nmAppResult.rows[0].id,
        territoryName: nmAppResult.rows[0].territory_name,
        accountStatus: nmAppResult.rows[0].account_status,
        createdAt: nmAppResult.rows[0].created_at,
        reviewedAt: nmAppResult.rows[0].reviewed_at,
      };
    }

    // Get Guru application if exists
    let guruApplication = null;
    const guruAppResult = await pool.query(
      `
      SELECT ga.id, ga.account_status, ga.created_at, ga.reviewed_at, ga.network_manager_user_id,
             u.name as network_manager_name, u.city as network_manager_territory
      FROM guru_applications ga
      LEFT JOIN users u ON u.id = ga.network_manager_user_id
      WHERE ga.user_id = $1
      `,
      [req.user.id]
    );

    if (guruAppResult.rowCount > 0) {
      guruApplication = {
        id: guruAppResult.rows[0].id,
        accountStatus: guruAppResult.rows[0].account_status,
        createdAt: guruAppResult.rows[0].created_at,
        reviewedAt: guruAppResult.rows[0].reviewed_at,
        networkManager: {
          id: guruAppResult.rows[0].network_manager_user_id,
          name: guruAppResult.rows[0].network_manager_name,
        },
        territoryName: guruAppResult.rows[0].network_manager_territory,
      };
    }

    // Get Promoter application if exists (with network manager from Guru hierarchy)
    let promoterApplication = null;
    const promoterAppResult = await pool.query(
      `
      SELECT pa.id, pa.account_status, pa.created_at, pa.reviewed_at, pa.guru_user_id,
             pa.territory_name, u.name as guru_name,
             gnm.network_manager_user_id
      FROM promoter_applications pa
      LEFT JOIN users u ON u.id = pa.guru_user_id
      LEFT JOIN guru_network_manager gnm ON gnm.guru_user_id = pa.guru_user_id
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
        guru: {
          id: promoterAppResult.rows[0].guru_user_id,
          name: promoterAppResult.rows[0].guru_name,
        },
        territoryName: promoterAppResult.rows[0].territory_name,
        networkManagerId: promoterAppResult.rows[0].network_manager_user_id,
      };
    }

    let promoter = null;
    if (role === "promoter") {
      const linkResult = await pool.query(
        `SELECT pgl.guru_user_id, u.name AS guru_name
         FROM promoter_guru_links pgl
         LEFT JOIN users u ON u.id = pgl.guru_user_id
         WHERE pgl.promoter_user_id = $1
         LIMIT 1`,
        [req.user.id]
      );
      const assignedGuru =
        linkResult.rowCount > 0 && linkResult.rows[0].guru_user_id != null
          ? {
              id: linkResult.rows[0].guru_user_id,
              name: linkResult.rows[0].guru_name,
            }
          : promoterApplication?.guru?.id != null
            ? promoterApplication.guru
            : null;

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
        assignedGuru,
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
        networkManagerApplication,
        guruApplication,
        promoterApplication,
        userPreferences, // ✅ includes city and interests for quick setup
        // For approved Gurus and Promoters, flatten hierarchy info to top level
        ...(role === 'guru' && guruApplication && guruApplication.accountStatus === 'approved' ? {
          network_manager_id: guruApplication.networkManager?.id,
          territory_id: guruApplication.networkManager?.territoryName,
        } : {}),
        ...(role === 'promoter' && promoterApplication ? {
          guru_id: promoter?.assignedGuru?.id ?? promoterApplication.guru?.id,
          network_manager_id: promoterApplication.networkManagerId,
          territory_id: promoterApplication.territoryName,
        } : {}),
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
      guruCode,
      role,
      role_requested,
      invite_token,
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

    const isNetworkManagerRequest = role_requested === "network_manager" || role === "network_manager";

    if (errors.length > 0) {
      return res.status(400).json({
        error: true,
        message: errors.length === 1 ? errors[0] : errors.join(" "),
        data: { ...data, errors },
      });
    }

    // Handle invite token if provided
    let inviteData = null;
    if (invite_token) {
      const inviteResult = await pool.query(
        `
        SELECT gi.*, u.name as admin_name
        FROM guru_invites gi
        LEFT JOIN users u ON u.id = gi.created_by
        WHERE gi.invite_token = $1
        `,
        [invite_token]
      );

      if (inviteResult.rowCount === 0) {
        return res.status(400).json({
          error: true,
          message: "Invalid invitation token.",
          data: null,
        });
      }

      inviteData = inviteResult.rows[0];

      // Check if invite is already used
      if (inviteData.used_at) {
        return res.status(400).json({
          error: true,
          message: "This invitation has already been used.",
          data: null,
        });
      }

      // Check if invite is expired
      if (new Date(inviteData.expires_at) < new Date()) {
        return res.status(400).json({
          error: true,
          message: "This invitation has expired.",
          data: null,
        });
      }

      // Check if email matches
      if (inviteData.email !== email) {
        return res.status(400).json({
          error: true,
          message: `This invitation is for ${inviteData.email}. Please use that email address.`,
          data: null,
        });
      }

      console.log(`[REGISTER] Valid invite found for role: ${inviteData.role}`);
    }

    // Handle role_requested for Network Manager, Guru, and Promoter flows
    const isGuruRequest = role_requested === "guru" || role === "guru";
    const isPromoterRequest = role_requested === "promoter" || role === "promoter";

    if (promoterReferralToken && !isPromoterRequest) {
      return res.status(400).json({
        error: true,
        message: "Referral token can only be used for promoter registration.",
        data: null,
      });
    }

    // Validate role if provided
    const allowedSelfAssignRoles = ["buyer", "promoter", "guru"];
    const adminOnlyRoles = ["network_manager", "admin", "staff_finance", "staff_rewards", "staff_charity", "founder"];

    if (role && !isNetworkManagerRequest) {
      // Check if role is valid
      const roleCheck = await pool.query(
        "SELECT key FROM roles WHERE key = $1",
        [role]
      );

      if (roleCheck.rowCount === 0) {
        return res.status(400).json({
          error: true,
          message: `Invalid role: ${role}. Valid roles are: buyer, promoter, guru, network_manager, admin, staff_finance, staff_rewards, staff_charity, founder.`,
          data: null,
        });
      }

      // Prevent self-assignment of admin-only roles (except network_manager which uses role_requested)
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
          message: `Role '${role}' cannot be selected during registration. You can only choose: buyer, promoter, or guru.`,
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

    // Determine initial active role
    let initialRole;
    let accountStatus;
    let emailStatus;

    // If user has an invite, use the role from the invite
    if (inviteData) {
      // Guru invites require approval and activation fee - use buyer until approved
      if (inviteData.role === "guru") {
        initialRole = "buyer";
        accountStatus = "pending";
      } else {
        initialRole = inviteData.role;
        accountStatus = "active";
      }
      emailStatus = "pending";
      console.log(`[REGISTER] Using invite role: ${initialRole}`);
    } else {
      // No invite - use self-selection logic
      // Network Manager role is NOT granted at registration - only after admin approval
      initialRole = isNetworkManagerRequest ? null
        : (isGuruRequest ? "buyer" : (role && allowedSelfAssignRoles.includes(role) ? role : "buyer"));

      if (isNetworkManagerRequest) {
        accountStatus = "requested";
        emailStatus = "pending";
      } else if (isGuruRequest) {
        accountStatus = "requested";
        emailStatus = "pending";
      } else if (role === "promoter") {
        accountStatus = "pending";
        emailStatus = "pending";
      } else {
        accountStatus = "active";
        emailStatus = "pending";
      }
    }

    // Create user (name/city for buyer; others complete profile later)
    const isBuyerRequest = role_requested === "buyer" || role === "buyer";
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

    // Promoter referral_token: Flow 1 (promoter_referrals) or Flow 2 (guru_referrals public code).
    if (promoterReferralToken) {
      const flow1Check = await pool.query(
        `SELECT 1 FROM promoter_referrals WHERE referral_link_token = $1 LIMIT 1`,
        [promoterReferralToken]
      );
      if (flow1Check.rowCount > 0) {
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
      } else {
        const guruRef = await ReferralService.validateReferralCode(promoterReferralToken);
        if (guruRef) {
          try {
            await ReferralService.recordSignup(promoterReferralToken, user.id);
          } catch (signupErr) {
            try {
              await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
            } catch (_) {}
            return res.status(400).json({
              error: true,
              message: signupErr.message || "Unable to apply referral token.",
              data: null,
            });
          }
          // Guru public link: attach to network so dashboards / credit routing see this promoter
          // (recordSignup only writes user_attributions + referral_events).
          if (user.role === "promoter") {
            const gid = guruRef.guru_id;
            try {
              await pool.query(
                `INSERT INTO promoter_guru_links (promoter_user_id, guru_user_id, source, created_at, changed_at)
                 VALUES ($1, $2, 'guru_public_referral', NOW(), NOW())
                 ON CONFLICT (promoter_user_id) DO UPDATE
                 SET guru_user_id = EXCLUDED.guru_user_id,
                     source = EXCLUDED.source,
                     changed_at = NOW()`,
                [user.id, gid]
              );
              await pool.query(
                `INSERT INTO promoter_profiles (user_id, guru_id, created_at, updated_at)
                 VALUES ($1, $2, NOW(), NOW())
                 ON CONFLICT (user_id) DO UPDATE
                 SET guru_id = EXCLUDED.guru_id, updated_at = NOW()`,
                [user.id, gid]
              );
            } catch (linkErr) {
              console.error("[register] guru referral attach promoter_guru_links:", linkErr.message);
              try {
                await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
              } catch (_) {}
              return res.status(500).json({
                error: true,
                message: "Unable to complete referral signup. Please try again.",
                data: null,
              });
            }
          }
        } else {
          try {
            await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
          } catch (_) {}
          return res.status(400).json({
            error: true,
            message: "Invalid referral token.",
            data: null,
          });
        }
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

    // Pre-provision guru public referral code during registration so frontend can read via GET endpoint.
    if (isGuruRequest || inviteData?.role === "guru") {
      try {
        await ReferralService.createReferralCode(user.id);
      } catch (guruReferralErr) {
        console.error("[register] ensureGuruReferralCode:", guruReferralErr.message);
      }
    }

    // If user registered via invite, mark invite as used and handle special flows
    if (inviteData) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Mark invite as used
        await client.query(
          `UPDATE guru_invites SET used_at = NOW() WHERE id = $1`,
          [inviteData.id]
        );

        if (inviteData.role === 'guru' && inviteData.network_manager_user_id) {
          // Fetch NM for territory (city)
          const nmResult = await client.query(
            'SELECT id, city FROM users WHERE id = $1 AND role = $2',
            [inviteData.network_manager_user_id, 'network_manager']
          );
          const territoryName = nmResult.rowCount > 0 ? nmResult.rows[0].city : null;

          // Pre-assign to Network Manager
          await client.query(
            `INSERT INTO guru_network_manager 
     (guru_user_id, network_manager_user_id, territory_name, assigned_at, assigned_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (guru_user_id) DO UPDATE SET
       network_manager_user_id = EXCLUDED.network_manager_user_id,
       territory_name = EXCLUDED.territory_name,
       assigned_at = NOW()
    `,
            [
              user.id,
              inviteData.network_manager_user_id,
              territoryName,
              inviteData.created_by  // Admin who created invite
            ]
          );

          // Create guru_application so user goes through activation fee + approval flow
          await client.query(
            `INSERT INTO guru_applications
       (user_id, network_manager_user_id, territory_name, agreed_to_terms, agreed_to_guru_agreement, account_status)
     VALUES ($1, $2, $3, TRUE, TRUE, 'pending')
     ON CONFLICT (user_id) DO NOTHING`,
            [user.id, inviteData.network_manager_user_id, territoryName]
          );
        }


        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error processing invite:', err);
        // Continue with registration even if invite update fails
      } finally {
        client.release();
      }
    }

    // Handle referral tracking if guruCode is provided
    if (guruCode) {
      try {
        await ReferralService.recordSignup(guruCode, user.id);
      } catch (err) {
        console.error('Referral tracking error:', err.message);
        // Don't fail registration if referral tracking fails
      }
    }

    // For invited users, create OTP for email verification (don't skip OTP)
    if (inviteData) {
      const otpResult = await createOtp({
        email,
        purpose: "signup",
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return res.status(201).json({
        error: false,
        message: `Registration successful! Please verify your email with the OTP sent to your inbox.`,
        data: {
          email,
          userId: user.user_no ?? user.id,
          otp: otpResult.otp, // In production, remove this - send via email only
          challengeId: otpResult.challengeId,
          "expires-in": otpResult.expiresIn,
          accountStatus: user.account_status,
          emailStatus: user.email_status,
          role: user.role,
          invited: true,
        },
      });
    }

    // For Network Manager, Guru, and Promoter (non-invited), create OTP for email verification
    if (isNetworkManagerRequest || isGuruRequest || isPromoterRequest) {
      const otpResult = await createOtp({
        email,
        purpose: "signup",
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      const roleRequested = isNetworkManagerRequest ? "network_manager" : (isPromoterRequest ? "promoter" : "guru");

      return res.status(201).json({
        error: false,
        message: isGuruRequest
          ? "Registration successful. Please verify your email with the OTP sent to your inbox."
          : "Registration successful. Please verify your email with the OTP sent to your inbox.",
        data: {
          email,
          userId: user.user_no ?? user.id,
          otp: otpResult.otp, // In production, remove this - send via email only
          challengeId: otpResult.challengeId,
          "expires-in": otpResult.expiresIn,
          accountStatus: accountStatus,
          emailStatus: emailStatus,
          roleRequested: roleRequested,
        },
      });
    }

    // Handle guru referral link if provided
    // Note: We only track referrals here. Promoter-Guru attachment is admin-controlled.
    if (guruCode) {
      console.log(`[REGISTER] Processing guruCode: ${guruCode} for user: ${email}`);
      // Attribution is now tracked via ReferralService.recordSignup above
      // Admin must manually attach promoters to Gurus
    } else {
      console.log(`[REGISTER] No guruCode provided for user: ${email}`);
    }

    // Create OTP for email verification (for all registrations including buyers)
    const otpResult = await createOtp({
      email,
      purpose: "signup",
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    // Build success message based on role
    let roleMessage = "";
    if (role === "promoter") {
      roleMessage = " You have been registered as a Promoter. You can now create events and sell tickets.";
    } else if (role === "guru") {
      roleMessage = " You have been registered as a Guru. You can now refer promoters and earn commissions.";
    }

    // For promoter registration, return simplified response format
    if (role === "promoter") {
      return res.status(201).json({
        error: false,
        message: "Registration successful. Please verify your email with the OTP sent to your inbox.",
        data: {
          email,
          userId: user.user_no ?? user.id,
          accountStatus: accountStatus,
          emailStatus: emailStatus,
          roleRequested: role,
          otp: otpResult.otp, // In production, send via email only
          challengeId: otpResult.challengeId,
          "expires-in": otpResult.expiresIn,
        },
      });
    }

    return res.status(201).json({
      error: false,
      message: `Registration successful. Please verify your email with the OTP sent to your inbox.${roleMessage}`,
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

    const isNetworkManagerApplicant = user.role === null || user.role === undefined;

    // Network Manager applicants: allow login only if email is verified (so they can check application status)
    if (isNetworkManagerApplicant) {
      if (user.email_status !== "verified") {
        return res.status(403).json({
          error: true,
          message: "Please verify your email before logging in.",
          data: { email },
        });
      }
      // Allow account_status 'requested' or 'pending' for NM applicants
      if (accountStatus !== "active" && accountStatus !== "requested" && accountStatus !== "pending") {
        return res.status(403).json({
          error: true,
          message: "Your account is pending approval. You cannot login until your application is approved.",
          data: { email },
        });
      }
    } else {
      // Non-NM applicants: block until account_status is active
      if (accountStatus !== "active") {
        return res.status(403).json({
          error: true,
          message: "Your account is pending approval. You cannot login until your application has been approved.",
          data: { email },
        });
      }
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
    const sessionRoles = user.role ? [user.role] : ['network_manager_applicant'];
    const session = await createSession({
      userId: user.id,
      deviceId: deviceId || null,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      roles: sessionRoles,
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
        refreshToken: session.refreshToken,
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
   Supports applicationData for approval-required roles (network_manager, guru, promoter)
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
    const isNetworkManagerRequest = effectiveRole === "network_manager";
    const isGuruRequest = effectiveRole === "guru";
    const isPromoterRequest = effectiveRole === "promoter";
    const isApprovalRequired = isNetworkManagerRequest || isGuruRequest || isPromoterRequest;

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

      // Name is required for Network Manager registration (new users only)
      if (isNetworkManagerRequest && (!name || typeof name !== "string" || name.trim().length < 2)) {
        client.release();
        return res.status(400).json({
          error: true,
          message: "Name is required for Network Manager registration and must be at least 2 characters long.",
          data: { name: name || null },
        });
      }

      await client.query("BEGIN");

      const initialRole = isNetworkManagerRequest || isGuruRequest ? null
        : (isPromoterRequest ? "promoter" : "buyer");
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
      if (isNetworkManagerRequest) {
        const { territory_name } = applicationData;
        if (!territory_name) {
          await client.query("ROLLBACK");
          client.release();
          return res.status(400).json({
            error: true,
            message: "Territory name is required for Network Manager application.",
            data: null,
          });
        }
        const nmAppResult = await client.query(
          `INSERT INTO network_manager_applications
            (user_id, territory_name, avatar_url, account_status)
          VALUES ($1, $2, $3, 'pending')
          RETURNING id`,
          [user.id, territory_name, avatarUrl || null]
        );
        const nmApp = nmAppResult.rows[0];
        await client.query(
          `INSERT INTO wallets (user_id, balance_amount, currency) VALUES ($1, 0, 'GBP') ON CONFLICT (user_id) DO NOTHING`,
          [user.id]
        );
        await client.query(
          `INSERT INTO invoices (user_id, description, amount, currency, status, invoice_type, related_entity_type, related_entity_id)
           VALUES ($1, 'Territory fee', 250000, 'GBP', 'pending', 'fee', 'network_manager_application', $2)`,
          [user.id, nmApp.id]
        );
        await client.query(
          "UPDATE users SET account_status = 'pending', updated_at = NOW() WHERE id = $1",
          [user.id]
        );
      } else if (isGuruRequest) {
        const { network_manager_user_id, agreed_to_terms, agreed_to_guru_agreement } = applicationData;
        if (!network_manager_user_id || !agreed_to_terms || !agreed_to_guru_agreement) {
          await client.query("ROLLBACK");
          client.release();
          return res.status(400).json({
            error: true,
            message: "Network Manager selection and agreement to terms are required for Guru application.",
            data: null,
          });
        }
        const nmResult = await client.query(
          "SELECT id, name, city FROM users WHERE id = $1 AND role = 'network_manager'",
          [network_manager_user_id]
        );
        if (nmResult.rowCount === 0) {
          await client.query("ROLLBACK");
          client.release();
          return res.status(400).json({
            error: true,
            message: "Invalid Network Manager selection.",
            data: null,
          });
        }
        const territoryName = nmResult.rows[0].city || applicationData.territory_name || "Unknown";
        await client.query(
          `INSERT INTO guru_applications
            (user_id, network_manager_user_id, territory_name, avatar_url, agreed_to_terms, agreed_to_guru_agreement, account_status)
          VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
          [user.id, network_manager_user_id, territoryName, avatarUrl || null, agreed_to_terms, agreed_to_guru_agreement]
        );
      } else if (isPromoterRequest) {
        const { guru_user_id, agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms } = applicationData;
        if (!guru_user_id || !agreed_to_terms || !agreed_to_promoter_agreement || !agreed_to_activation_fee_terms) {
          await client.query("ROLLBACK");
          client.release();
          return res.status(400).json({
            error: true,
            message: "Guru selection and agreement to all terms are required for Promoter application.",
            data: null,
          });
        }
        const guruResult = await client.query(
          `SELECT id, role, account_status FROM users WHERE id = $1 AND role = 'guru'`,
          [guru_user_id]
        );
        if (guruResult.rowCount === 0 || guruResult.rows[0].account_status !== "active") {
          await client.query("ROLLBACK");
          client.release();
          return res.status(400).json({
            error: true,
            message: "Invalid or inactive Guru selection.",
            data: null,
          });
        }
        const territoryResult = await client.query(
          `SELECT territory_name FROM guru_network_manager WHERE guru_user_id = $1`,
          [guru_user_id]
        );
        const territoryName = territoryResult.rowCount > 0 ? territoryResult.rows[0].territory_name : null;
        await client.query(
          `INSERT INTO promoter_applications
            (user_id, guru_user_id, territory_name, avatar_url, agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms, account_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
          [user.id, guru_user_id, territoryName, avatarUrl || null, agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms]
        );
        await client.query(
          `INSERT INTO promoter_guru_links (promoter_user_id, guru_user_id, source) VALUES ($1, $2, 'application')
           ON CONFLICT (promoter_user_id) DO NOTHING`,
          [user.id, guru_user_id]
        );
      }

      if (user.role === "promoter") {
        await ensurePromoterCreditWallet(client, user.id);
      }

      await client.query("COMMIT");
    }

    // Users with NULL role (Network Manager, Guru applicants) cannot login
    if (user.role === null || user.role === undefined) {
      // Resolve actual pending role from application tables (not effectiveRole, which defaults to "buyer")
      let pendingRole = effectiveRole;
      const nmApp = await pool.query(
        "SELECT id FROM network_manager_applications WHERE user_id = $1 LIMIT 1",
        [user.id]
      );
      if (nmApp.rowCount > 0) {
        pendingRole = "network_manager";
      } else {
        const guruApp = await pool.query(
          "SELECT id FROM guru_applications WHERE user_id = $1 LIMIT 1",
          [user.id]
        );
        if (guruApp.rowCount > 0) {
          pendingRole = "guru";
        }
      }
      client.release();
      return res.json({
        error: false,
        message: "Application submitted successfully. You will be notified once approved.",
        data: {
          pendingApproval: true,
          role: pendingRole,
          email,
          message: "Your application has been submitted. You cannot login until your application has been approved.",
        },
      });
    }

    // Block promoters and gurus from logging in until approved (account_status = 'active')
    if ((user.role === "promoter" || user.role === "guru") && user.account_status !== "active") {
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
        refreshToken: session.refreshToken,
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
      const refreshToken = generateRefreshToken(user);

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
          refreshToken,
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

    // Users with NULL role (Network Manager applicants) cannot login
    if (user.role === null || user.role === undefined) {
      return res.status(403).json({
        error: true,
        message: "Your account is pending approval. You cannot login until your application is approved.",
        data: null,
      });
    }

    // Block promoters and gurus from logging in until approved (account_status = 'active')
    if ((user.role === 'promoter' || user.role === 'guru') && user.account_status !== 'active') {
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
        refreshToken: session.refreshToken,
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
   REFRESH TOKEN
======================= */
async function refreshToken(req, res) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: true,
        message: "Refresh token is required.",
        data: null,
      });
    }

    const session = await refreshAccessToken(
      refreshToken,
      req.ip,
      req.headers["user-agent"]
    );

    return res.json({
      error: false,
      message: "Tokens refreshed successfully.",
      data: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        "expires-at": session.expiresAt,
      },
    });
  } catch (err) {
    return res.status(401).json({
      error: true,
      message: err.message || "Invalid or expired refresh token.",
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

/**
 * Guru Checkout (DEPRECATED)
 * POST /auth/guru/checkout
 *
 * This endpoint is deprecated. Use the new Guru registration flow:
 * 1. POST /api/gurus/activation-fee/commit with { choice: 'upfront' | 'negative_balance' }
 * 2. Wait for Network Manager or Admin approval
 */
async function guruCheckout(req, res) {
  return fail(res, req, 410, "DEPRECATED", "This endpoint is deprecated. Use POST /api/gurus/activation-fee/commit with { choice: 'upfront' | 'negative_balance' }, then await approval from your Network Manager or Admin.");
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
        refreshToken: session.refreshToken,
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
 * POST /api/v1/gurus/promoter/referral-invites
 * Create Promoter Referral Invite (Guru or Kings Account)
 * 
 * AUTHORIZATION: Only gurus or kings_account can create promoter referral invites
 * 
 * Requirements:
 * - Guru/Kings Account creates a time-limited (15 min) referral link for Promoter
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
    // AUTHORIZATION: Only gurus or kings_account can create referral invites
    const allowedRoles = ['guru', 'kings_account'];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: true,
        message: "Only Gurus and Kings Accounts can create promoter referral invites.",
        data: null,
      });
    }

    const { email, name = '', expires_in_minutes = 15 } = req.body;
    const guruId = req.user.id;

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

    // Create a pending promoter user immediately so Guru can manage/activate from dashboard
    const pendingUserResult = await client.query(
      `INSERT INTO users (email, name, role, status, account_status, email_status)
       VALUES ($1, $2, 'promoter', 'active', 'pending', 'pending')
       RETURNING id`,
      [email, String(name || "").trim() || null]
    );
    const pendingPromoterUserId = pendingUserResult.rows[0].id;

    await client.query(
      `INSERT INTO promoter_guru_links (promoter_user_id, guru_user_id, source, created_at, changed_at)
       VALUES ($1, $2, 'invite_referral', NOW(), NOW())
       ON CONFLICT (promoter_user_id) DO UPDATE
       SET guru_user_id = EXCLUDED.guru_user_id,
           source = EXCLUDED.source,
           changed_at = NOW()`,
      [pendingPromoterUserId, guruId]
    );

    await client.query(
      `INSERT INTO promoter_profiles (user_id, guru_id, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET guru_id = EXCLUDED.guru_id, updated_at = NOW()`,
      [pendingPromoterUserId, guruId]
    );

    // Generate referral token (UUID-like token)
    const referralToken = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + expires_in_minutes * 60 * 1000);

    // Create referral invite record
    const inviteResult = await client.query(
      `INSERT INTO promoter_referral_invites (email, name, referral_token, guru_user_id, kings_account_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, referral_token, expires_at, email`,
      [email, name, referralToken, guruId, req.user.role === 'kings_account' ? guruId : null, expiresAt]
    );

    const invite = inviteResult.rows[0];

    // Get guru name
    const guruResult = await client.query("SELECT name FROM users WHERE id = $1", [guruId]);
    const guruName = guruResult.rows[0]?.name || 'Your Guru';

    // Build registration URL
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const registrationUrl = `${baseUrl}/auth/promoter/register?referral_token=${referralToken}`;

    // SEND EMAIL with referral link
    try {
      await sendPromoterReferralInviteEmail({
        email,
        guruName,
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
        `SELECT pri.*, u.name as guru_name
         FROM promoter_referral_invites pri
         LEFT JOIN users u ON u.id = pri.guru_user_id
         WHERE pri.email = $1 AND pri.used_at IS NULL
         ORDER BY pri.created_at DESC
         LIMIT 1`,
        [email]
      );
    } else {
      // FALLBACK: Search by old token
      inviteResult = await pool.query(
        `SELECT pri.*, u.name as guru_name
         FROM promoter_referral_invites pri
         LEFT JOIN users u ON u.id = pri.guru_user_id
         WHERE pri.referral_token = $1`,
        [referral_token]
      );
    }

    if (inviteResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "No referral invitation found. Please check your email. If you don't have an invitation, ask your Guru to send one.",
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

    // Get guru name
    const guruName = originalInvite.guru_name || 'Your Guru';

    // SEND EMAIL with new referral link
    try {
      await sendPromoterReferralInviteResendEmail({
        email: updatedInvite.email,
        guruName,
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
      message: `New referral invi tation sent to ${updatedInvite.email}! Check your inbox. This link expires in ${expires_in_minutes} minutes.`,
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
 * POST /api/v1/auth/promoter/register
 * Promoter Registration via Guru Referral Link (Module 5)
 * 
 * Requirements:
 * - POST registration must include referral_token in request body
 * - On register: create a referral record, log referral_start_date, set referral_expiry = start date + 90 days
 * - Lock Guru assignment permanently — cannot be changed after registration
 * - Validate no duplicate email
 * 
 * Request: { name, email, password, phone, referral_token? }
 * Response: { access_token, refresh_token, user: { ...user_data, unlock_threshold: 575 } }
 * 
 * Error Responses:
 * - 400: Missing required fields
 * - 401: Referral token invalid
 * - 410: Referral token expired
 * - 409: Email already registered
 */

async function promoterRegisterViaReferral(req, res) {
  const client = await pool.connect();
  try {
    const { name, password, phone, referral_token } = req.body;

    // VALIDATION
    const errors = [];
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

    // STEP 1: VALIDATE TOKEN
    let guruId = null;
    let guruData = null;
    let isTimeBasedInvite = false;
    let email = null; // <-- THIS is now controlled by backend

    if (referral_token) {
      const result = await client.query(
        `SELECT pri.*, u.id as user_id, u.name as guru_name
         FROM promoter_referral_invites pri
         JOIN users u ON u.id = pri.guru_user_id
         WHERE pri.referral_token = $1`,
        [referral_token]
      );

      if (result.rowCount === 0) {
        client.release();
        return res.status(401).json({
          error: true,
          message: "Referral token is invalid.",
        });
      }

      const invite = result.rows[0];

      // USED
      if (invite.used_at) {
        client.release();
        return res.status(409).json({
          error: true,
          message: "This referral invitation has already been used.",
        });
      }

      // EXPIRED
      if (new Date(invite.expires_at) < new Date()) {
        client.release();
        return res.status(410).json({
          error: true,
          message: "This referral invitation has expired.",
        });
      }

      // ✅ ALWAYS TAKE EMAIL FROM INVITE
      email = invite.email;

      guruId = invite.user_id;
      guruData = invite;
      isTimeBasedInvite = true;
    }

    // STEP 2: CHECK EXISTING USER (invite flow can pre-create pending promoter user)
    let invitedPendingUserId = null;
    if (isTimeBasedInvite) {
      const pendingUserResult = await client.query(
        `SELECT id, account_status
         FROM users
         WHERE email = $1
         ORDER BY created_at ASC
         LIMIT 1`,
        [email]
      );

      if (pendingUserResult.rowCount > 0) {
        invitedPendingUserId = pendingUserResult.rows[0].id;
      }
    } else {
      const existingUser = await client.query(
        "SELECT id FROM users WHERE email = $1",
        [email]
      );

      if (existingUser.rowCount > 0) {
        client.release();
        return res.status(409).json({
          error: true,
          message: "Email is already registered.",
        });
      }
    }

    // STEP 3: CREATE USER
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

    // STEP 4: LINK GURU
    if (guruId) {
      await client.query(
        `INSERT INTO promoter_guru_links (promoter_user_id, guru_user_id, source, created_at, changed_at)
         VALUES ($1, $2, 'referral_link', NOW(), NOW())
         ON CONFLICT (promoter_user_id) DO UPDATE 
         SET guru_user_id = EXCLUDED.guru_user_id`,
        [user.id, guruId]
      );

    }

    // Always ensure promoter profile exists for promoter-role users.
    // Some flows may register a promoter without an attached guru yet.
    await client.query(
      `INSERT INTO promoter_profiles (user_id, guru_id, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET guru_id = COALESCE(EXCLUDED.guru_id, promoter_profiles.guru_id),
           updated_at = NOW()`,
      [user.id, guruId || null]
    );

    await ensurePromoterCreditWallet(client, user.id);

    // MARK INVITE USED
    if (isTimeBasedInvite) {
      await client.query(
        `UPDATE promoter_referral_invites
         SET used_at = NOW()
         WHERE referral_token = $1`,
        [referral_token]
      );
    }

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
        refresh_token: session.refreshToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: "promoter",
          guru_id: guruId || null,
          guru_display_name: guruData?.guru_name || null,
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
 * GET /api/v1/referrals/validate/:token
 * Validate Referral Token and Return Guru Info (Module 5)
 * 
 * Requirements:
 * - GET validate endpoint must return guru_id and guru display name from the referral token
 * - Confirm token is valid and not expired
 * 
 * Response: { valid: true, guru_id, guru_display_name }
 * 
 * Error Responses:
 * - 401: Referral token invalid
 * - 410: Referral token expired
 */
async function validateReferralToken(req, res) {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({
        error: true,
        message: "Referral token is required.",
        data: null,
      });
    }

    // STEP 1: Try new time-limited promoter_referral_invites system
    const newInviteResult = await pool.query(
      `SELECT pri.*, u.id as guru_id, u.name as guru_display_name
       FROM promoter_referral_invites pri
       JOIN users u ON u.id = pri.guru_user_id
       WHERE pri.referral_token = $1`,
      [token]
    );

    if (newInviteResult.rowCount > 0) {
      const invite = newInviteResult.rows[0];

      // Check if token is expired
      if (new Date(invite.expires_at) < new Date()) {
        return res.status(410).json({
          error: true,
          message: "Referral token has expired.",
          data: { 
            valid: false,
            token
          },
        });
      }

      // Token is valid
      return res.json({
        error: false,
        message: "Referral token is valid.",
        data: {
          valid: true,
          guru_id: invite.guru_id,
          guru_display_name: invite.guru_display_name,
          token_type: "promoter_invite"
        },
      });
    }

    // STEP 2: Fall back to old guru_referrals system for backwards compatibility
    const guruResult = await pool.query(
      `SELECT gr.*, u.id as guru_id, u.name as guru_display_name
       FROM guru_referrals gr
       JOIN users u ON u.id = gr.guru_id
       WHERE gr.referral_code = $1 AND gr.revoked_at IS NULL`,
      [token]
    );

    if (guruResult.rowCount > 0) {
      const guruData = guruResult.rows[0];

      // Return validation success
      return res.json({
        error: false,
        message: "Referral token is valid.",
        data: {
          valid: true,
          guru_id: guruData.guru_id,
          guru_display_name: guruData.guru_display_name,
          token_type: "guru_referral"
        },
      });
    }

    // Token not found in either system
    return res.status(401).json({
      error: true,
      message: "Referral token is invalid.",
      data: { 
        valid: false,
        token
      },
    });

  } catch (err) {
    console.error("Validate referral token error:", err);
    return res.status(500).json({
      error: true,
      message: "An error occurred while validating the referral token. Please try again later.",
      data: null,
    });
  }
}

/**
 * POST /api/v1/network-managers/guru/invites
 * Create Guru Invite Token (Network Manager or Kings Account)
 * 
 * Requirements:
 * - Only Network Managers and Kings Accounts can create Guru invites
 * - Generate a signed invite token
 * - Store invite in guru_invites table with expiry
 * - Return invite token and registration URL
 * 
 * Request: { email, expires_in_minutes?: 15 }
 * Response: { invite_token, registration_url, email, expires_at }
 */
async function createGuruInvite(req, res) {
  try {
    // AUTHORIZATION: Only network_manager or kings_account can create guru invites
    const allowedRoles = ['network_manager', 'kings_account'];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: true,
        message: "Only Network Managers and Kings Accounts can create guru invites.",
        data: null,
      });
    }

    const { email, expires_in_minutes = 15 } = req.body;
    const networkManagerId = req.user.id;

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
    const existingUser = await pool.query(
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

    // Generate invite token (UUID-like token)
    const inviteToken = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + expires_in_minutes * 60 * 1000); // Convert minutes to milliseconds

    // Create invite record
    const inviteResult = await pool.query(
      `INSERT INTO guru_invites (email, name, role, invite_token, network_manager_user_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, invite_token, expires_at, email`,
      [email, '', 'guru', inviteToken, networkManagerId, networkManagerId, expiresAt]
    );

    const invite = inviteResult.rows[0];

    // Build registration URL
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const registrationUrl = `${baseUrl}/auth/guru/register?token=${inviteToken}`;

    // SEND EMAIL with invite link
    try {
      await sendGuruInviteEmail({
        email,
        registrationUrl,
        expiresInMinutes: expires_in_minutes,
      });
    } catch (emailError) {
      console.warn(`[GURU INVITE] Email sending failed for ${email}:`, emailError.message);
      // Continue - don't fail the API if email fails
    }

    // Return success response
    return res.status(201).json({
      error: false,
      message: `Guru invitation has been sent to ${email}. The link expires in ${expires_in_minutes} minutes. Check your email to verify the invitation.`,
      data: {
        email: invite.email,
        sent_at: new Date(),
        expires_at: invite.expires_at,
        expires_in_minutes: expires_in_minutes,
        // For testing/admin purposes only:
        invite_token: invite.invite_token,
        registration_url: registrationUrl,
      },
    });

  } catch (err) {
    console.error("Create guru invite error:", err);
    return res.status(500).json({
      error: true,
      message: "An error occurred while creating the guru invite.",
      data: null,
    });
  }
}

/**
 * POST /api/v1/auth/guru/invites/resend
 * Resend Guru Invite (Token Expired) - PUBLIC ENDPOINT
 * 
 * ⭐ THIS IS A PUBLIC ENDPOINT (NO AUTHENTICATION REQUIRED)
 * 
 * When a guru's invitation token expires, the frontend shows a "Resend Invitation" button.
 * The guru (without login) provides their email to request a new invite.
 * 
 * Flow:
 * 1. Guru receives invite email with token + link
 * 2. Guru doesn't click link for 15+ minutes (token expires)
 * 3. Guru clicks "Resend Invitation" button on frontend (unauthenticated)
 * 4. Frontend makes POST to this endpoint with email
 * 5. Backend generates NEW token, updates invite record, sends NEW email
 * 6. Guru receives fresh invite email with new token + link
 * 
 * Request: { email } OR { invite_token }
 * - email: The email address guru was invited with (PREFERRED)
 * - invite_token: The old expired token (fallback if email lost)
 * 
 * Response: 
 * - 200: Invitation resent successfully
 * - 400: Missing email and invite_token
 * - 404: No invitation found for this email/token
 * - 409: Invitation already used (guru already registered)
 * - 500: Server error
 */
async function resendGuruInvite(req, res) {
  try {
    const { invite_token, email } = req.body;

    // VALIDATION: Either invite_token or email must be provided
    if (!invite_token && !email) {
      return res.status(400).json({
        error: true,
        message: "Either 'email' or 'invite_token' is required.",
        data: null,
      });
    }

    // Find the original invitation
    let inviteResult;
    if (email) {
      // PREFERRED: Search by email (guru knows their own email)
      inviteResult = await pool.query(
        `SELECT gi.*, u.name as created_by_name, nm.name as network_manager_name
         FROM guru_invites gi
         LEFT JOIN users u ON u.id = gi.created_by
         LEFT JOIN users nm ON nm.id = gi.network_manager_user_id
         WHERE gi.email = $1 AND gi.used_at IS NULL
         ORDER BY gi.created_at DESC
         LIMIT 1`,
        [email]
      );
    } else {
      // FALLBACK: Search by old token
      inviteResult = await pool.query(
        `SELECT gi.*, u.name as created_by_name, nm.name as network_manager_name
         FROM guru_invites gi
         LEFT JOIN users u ON u.id = gi.created_by
         LEFT JOIN users nm ON nm.id = gi.network_manager_user_id
         WHERE gi.invite_token = $1`,
        [invite_token]
      );
    }

    if (inviteResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        message: "No invitation found. Please check your email. If you don't have an invitation, contact your Network Manager.",
        data: { email: email || null },
      });
    }

    const originalInvite = inviteResult.rows[0];

    // Check if invitation was already used
    if (originalInvite.used_at) {
      return res.status(409).json({
        error: true,
        message: "This invitation was already accepted. Please log in to your account.",
        data: { email: originalInvite.email },
      });
    }

    // Get expiration time (default 15 minutes)
    const expires_in_minutes = 15;
    const newExpiresAt = new Date(Date.now() + expires_in_minutes * 60 * 1000);

    // Generate new invite token
    const newInviteToken = require('crypto').randomBytes(32).toString('hex');

    // Update the invitation with new token and expiry
    const updateResult = await pool.query(
      `UPDATE guru_invites
       SET invite_token = $1,
           expires_at = $2
       WHERE id = $3
       RETURNING id, invite_token, expires_at, email, role`,
      [newInviteToken, newExpiresAt, originalInvite.id]
    );

    const updatedInvite = updateResult.rows[0];

    // Build registration URL
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const registrationUrl = `${baseUrl}/auth/guru/register?token=${newInviteToken}`;

    // SEND EMAIL with new invite link
    try {
      await sendGuruInviteResendEmail({
        email: updatedInvite.email,
        registrationUrl,
        expiresInMinutes: expires_in_minutes,
      });
    } catch (emailError) {
      console.warn(`[GURU INVITE RESEND] ⚠️ Email failed for ${updatedInvite.email}:`, emailError.message);
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
        invite_token: updatedInvite.invite_token,
        registration_url: registrationUrl,
      },
    });

  } catch (err) {
    console.error("Resend guru invite error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to resend invitation. Please try again later.",
      data: null,
    });
  }
}

/**
 * POST /api/v1/auth/guru/register
 * Guru Registration via Invite Token (Module 4: Guru — Registration via Invite)
 * 
 * Requirements:
 * - Validate invite token: check not expired, check not already used
 * - Create user record with role = GURU and assign network_manager_id from token
 * - Set credit_balance = -295 (via guru_profile), level = 1, sprint_active = false
 * - Return JWT access token and refresh token on success
 * - Invalidate invite token immediately after successful registration to prevent reuse
 * - Reject duplicate email registration
 * 
 * Request: { invite_token, name, contract_name, password, phone }
 * Response: { access_token, refresh_token, user: { id, name, email, role, network_manager_id, credit_balance: -295, level: 1, sprint_active: false } }
 * 
 * Error Responses:
 * - 400: Missing required fields
 * - 401: Invite token invalid
 * - 410: Invite token expired
 * - 409: Email already registered
 */
async function guruRegisterViaInvite(req, res) {
  const client = await pool.connect();
  try {
    const { invite_token, name, contract_name, password, phone } = req.body;

    // VALIDATION: All fields are required
    const errors = [];
    if (!invite_token) errors.push("Invite token is required.");
    if (!name || typeof name !== "string" || name.trim().length === 0) errors.push("Name is required.");
    if (!contract_name || typeof contract_name !== "string" || contract_name.trim().length === 0) {
      errors.push("Contract name is required.");
    }
    if (!password) errors.push("Password is required.");
    if (!phone) errors.push("Phone number is required.");

    if (errors.length > 0) {
      return res.status(400).json({
        error: true,
        message: "Missing required fields.",
        data: { 
          errors,
          invite_token: invite_token || null
        },
      });
    }

    // VALIDATION: Password strength
    const passwordErrors = validatePasswordStrength(password);
    if (passwordErrors.length > 0) {
      return res.status(400).json({
        error: true,
        message: "Password does not meet strength requirements.",
        data: { 
          errors: passwordErrors,
          invite_token
        },
      });
    }

    // VALIDATION: Phone format (E.164)
    const phoneRegex = /^\+[1-9]\d{1,14}$/; // E.164 format
    if (!phoneRegex.test(phone)) {
      return res.status(422).json({
        error: true,
        message: "Phone number must be in E.164 format (e.g., +447911123456).",
        data: { 
          phone,
          invite_token
        },
      });
    }

    // STEP 1: Validate invite token
    const inviteResult = await client.query(
      `SELECT gi.*, u.name as network_manager_name 
       FROM guru_invites gi
       LEFT JOIN users u ON u.id = gi.network_manager_user_id
       WHERE gi.invite_token = $1`,
      [invite_token]
    );

    if (inviteResult.rowCount === 0) {
      client.release();
      return res.status(401).json({
        error: true,
        message: "Invite token is invalid.",
        data: { invite_token },
      });
    }

    const inviteData = inviteResult.rows[0];

    // Check if invite is already used
    if (inviteData.used_at) {
      client.release();
      return res.status(410).json({
        error: true,
        message: "Invite token has already been used and is no longer valid.",
        data: { invite_token },
      });
    }

    // Check if invite is expired
    if (new Date(inviteData.expires_at) < new Date()) {
      client.release();
      return res.status(410).json({
        error: true,
        message: "Invite token has expired.",
        data: { invite_token },
      });
    }

    // Check if email from invite already exists
    const existingUser = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [inviteData.email]
    );

    if (existingUser.rowCount > 0) {
      client.release();
      return res.status(409).json({
        error: true,
        message: "Email address is already registered.",
        data: { email: inviteData.email },
      });
    }

    // STEP 2: Create user record with role = GURU
    await client.query('BEGIN');

    const passwordHash = await bcrypt.hash(password, 12);

    // console.log(`[GURU REGISTER] Creating user for email: ${inviteData.email}`);

    const userResult = await client.query(
      `INSERT INTO users (
         email,
         password_hash,
         name,
         phone,
         role,
         status,
         account_status,
         email_status,
         email_verified_at,
         guru_active,
         guru_active_until,
         guru_activation_date
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), TRUE, NOW() + INTERVAL '1 year', NOW())
       RETURNING *`,
      [
        inviteData.email,
        passwordHash,
        name.trim(),
        phone,
        'guru',
        'active',
        'active', // Guru from invite is active immediately
        'verified' // Email is verified via invite
      ]
    );

    if (!userResult.rows[0]) {
      throw new Error('User creation failed - no user returned');
    }

    const user = userResult.rows[0];
    // console.log(`[GURU REGISTER] User created with ID: ${user.id}`);

    // STEP 3: Create guru_profile with credit_balance = -295, level = 1
    // Note: credit_balance is stored in guru_profiles as licence_balance
    // According to API contract: credit_balance: -295, level: 1, sprint_active: false
    // console.log(`[GURU REGISTER] Creating guru profile for user ${user.id}`);
    
    const guruProfileResult = await client.query(
      `INSERT INTO guru_profiles (user_id, level, licence_balance, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [user.id, 1, -295]
    );

    const guruProfile = guruProfileResult.rows[0];
    // console.log(`[GURU REGISTER] Guru profile created: ${guruProfile.id}`);

    // STEP 4: Assign network_manager_id from invite token
    if (inviteData.network_manager_user_id) {
      // console.log(`[GURU REGISTER] Assigning network manager ${inviteData.network_manager_user_id}`);
      // Check if guru_network_manager table exists, otherwise use user.network_id
      try {
        await client.query(
          `INSERT INTO guru_network_manager (guru_user_id, network_manager_user_id, assigned_at, assigned_by)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (guru_user_id) DO UPDATE SET network_manager_user_id = EXCLUDED.network_manager_user_id, assigned_at = NOW()`,
          [user.id, inviteData.network_manager_user_id, inviteData.created_by]
        );
        // console.log(`[GURU REGISTER] Network manager assigned successfully`);
      } catch (err) {
        // guru_network_manager table might not exist, log warning and continue
        console.warn("Note: guru_network_manager assignment skipped (table may not exist):", err.message);
      }
    }

    // STEP 4B: Store Guru application metadata from invite registration
    await client.query(
      `INSERT INTO guru_applications
        (user_id, network_manager_user_id, contract_name, phone, agreed_to_terms, agreed_to_guru_agreement, account_status, reviewed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, TRUE, 'approved', NOW(), NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET contract_name = EXCLUDED.contract_name,
           phone = EXCLUDED.phone,
           network_manager_user_id = EXCLUDED.network_manager_user_id,
           updated_at = NOW()`,
      [
        user.id,
        inviteData.network_manager_user_id || null,
        contract_name.trim(),
        phone,
      ]
    );

    // STEP 5: Invalidate invite token
    // console.log(`[GURU REGISTER] Invalidating invite token`);
    await client.query(
      `UPDATE guru_invites SET used_at = NOW() WHERE id = $1`,
      [inviteData.id]
    );

    // STEP 5B: Ensure guru has a referral code (for promoters). Expose in response — must be outer-scoped.
    let referralCode = null;
    const existingReferral = await client.query(
      `SELECT referral_code FROM guru_referrals WHERE guru_id = $1 AND revoked_at IS NULL LIMIT 1`,
      [user.id]
    );
    if (existingReferral.rowCount > 0) {
      referralCode = existingReferral.rows[0].referral_code;
    } else {
      let created = false;
      let attempts = 0;
      while (!created && attempts < 10) {
        const code = ReferralService.generateReferralCode();
        try {
          const insertResult = await client.query(
            `INSERT INTO guru_referrals (guru_id, referral_code, created_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (referral_code) DO NOTHING
             RETURNING id`,
            [user.id, code]
          );
          if (insertResult.rowCount > 0) {
            referralCode = code;
            created = true;
          }
        } catch (refErr) {
          if (refErr && refErr.code !== "23505") {
            throw refErr;
          }
        }
        attempts++;
      }
      if (!created) {
        throw new Error("Unable to create guru referral code");
      }
    }

    // console.log(`[GURU REGISTER] Committing transaction`);
    await client.query('COMMIT');
    // console.log(`[GURU REGISTER] Transaction committed successfully`);
    
    client.release();

    // STEP 6: Create session AFTER transaction commits (separate DB connection)
    // console.log(`[GURU REGISTER] Creating session for user ${user.id}`);
    const session = await createSession({
      userId: user.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      roles: ['guru'],
      rolesVersion: user.roles_version || 1,
    });
    // console.log(`[GURU REGISTER] Session created successfully`);

    // STEP 7: Return response per API contract
    return res.status(201).json({
      error: false,
      message: "Registration successful! You are now logged in. Complete your profile to get started.",
      data: {
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: 'GURU',
          network_manager_id: inviteData.network_manager_user_id || null,
          network_manager_name: inviteData.network_manager_name || null,
          contract_name: contract_name.trim(),
          credit_balance: -295,
          level: 1,
          sprint_active: false,
          referral_code: referralCode,
          email_verification_sent: false,
        },
        expires_at: session.expiresAt,
      },
    });

  } catch (err) {
    // Only rollback if client is still in transaction
    try {
      await client.query('ROLLBACK');
    } catch (_) { }
    try {
      client.release();
    } catch (_) { }
    console.error("Guru registration error:", err);
    return res.status(500).json({
      error: true,
      message: "An error occurred during Guru registration. Please try again later.",
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
  refreshToken,
  logoutAll,
  setActiveRole,
  // OTP verification
  verifyOtpEmail,
  // Guru checkout
  guruCheckout,
  // Settings module - change password
  changePasswordV1,
  // Guru registration via invite
  guruRegisterViaInvite,
  createGuruInvite,
  resendGuruInvite,
  // Promoter registration via referral
  promoterRegisterViaReferral,
  validateReferralToken,
  createPromoterReferralInvite,
  resendPromoterReferralInvite,
};
