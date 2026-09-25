/**
 * Resolves login-blocking states for accounts that have not finished onboarding.
 *
 * Used by auth.controller.js#login() BEFORE the generic "pending approval" gate, so a
 * user mid-onboarding gets a specific, actionable error instead of a vague
 * "Invalid email or password." or "pending approval." message.
 *
 * Roles are King, Promoter and Buyer:
 *   - Promoter invited by the King  -> PROMOTER_INVITE_PENDING until they accept the invite
 *   - Promoter who self-registered  -> EMAIL_NOT_VERIFIED, then PROFILE_INCOMPLETE until the
 *                                      application is submitted, then approval by the King
 *   - Buyer                         -> EMAIL_NOT_VERIFIED until the email OTP is verified
 */
const pool = require("../db");

const CODES = {
  PROMOTER_INVITE_PENDING: "PROMOTER_INVITE_PENDING",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
};

/**
 * A self-registered Promoter is created with role 'promoter' and account_status 'pending';
 * it moves to 'pending_approval' once POST /promoters/applications succeeds, so
 * "pending + no promoter_applications row" means onboarding is unfinished:
 *   1. email_status != 'verified'  -> EMAIL_NOT_VERIFIED (verify the email OTP)
 *   2. verified, no application    -> PROFILE_INCOMPLETE (submit the Promoter application)
 * Invited promoters have no password until they accept the invite and become 'active'
 * on acceptance, so they never match here (login() also requires a password_hash).
 *
 * @returns {Promise<null | { code: string, message: string, data: object }>}
 */
async function getIncompleteSelfRegisteredPromoterLoginBlock(user) {
  if (user.role !== "promoter" || user.account_status !== "pending") return null;

  const appResult = await pool.query(
    `SELECT 1 FROM promoter_applications WHERE user_id = $1 LIMIT 1`,
    [user.id]
  );
  if (appResult.rowCount > 0) return null;

  const emailStatus = user.email_status || "pending";
  const data = { email: user.email, emailStatus, role: "promoter" };

  if (emailStatus !== "verified") {
    return {
      code: CODES.EMAIL_NOT_VERIFIED,
      message: "Your account setup is remaining. Please verify your email to continue.",
      data,
    };
  }

  return {
    code: CODES.PROFILE_INCOMPLETE,
    message: "Your profile is incomplete. Please submit your Promoter application to continue.",
    data,
  };
}

/**
 * A Buyer who registered but never verified their email. Buyers are active on registration
 * (no approval step), so the only thing left is the email OTP. Only an explicit
 * email_status = 'pending' counts; a null status (older/seeded accounts) is left alone.
 */
function getUnverifiedBuyerLoginBlock(user) {
  if (user.role !== "buyer" || user.email_status !== "pending") return null;

  return {
    code: CODES.EMAIL_NOT_VERIFIED,
    message: "Your account setup is remaining. Please verify your email to continue.",
    data: { email: user.email, emailStatus: "pending", role: "buyer" },
  };
}

/**
 * A Promoter invited by the King who hasn't accepted the invite yet (pre-created
 * user with no password_hash, open row in promoter_referral_invites).
 * Login is blocked with PROMOTER_INVITE_PENDING so the web client can offer
 * "Continue Setup" (valid token) or "Resend Invite" (expired).
 */
async function getPendingPromoterInviteLoginBlock(user) {
  if (user.password_hash || user.role !== "promoter") return null;

  const inviteResult = await pool.query(
    `SELECT referral_token, expires_at
     FROM promoter_referral_invites
     WHERE email = $1 AND used_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [user.email]
  );
  if (inviteResult.rowCount === 0) return null;

  const invite = inviteResult.rows[0];
  const isExpired = new Date(invite.expires_at) < new Date();

  let message = "Your account setup is remaining. Please complete your registration from the invite link in your email.";
  if (isExpired) {
    message += " Your invitation link has expired — please resend it.";
  }

  return {
    code: CODES.PROMOTER_INVITE_PENDING,
    message,
    data: {
      email: user.email,
      inviteToken: isExpired ? null : invite.referral_token,
    },
  };
}

module.exports = {
  getPendingPromoterInviteLoginBlock,
  getUnverifiedBuyerLoginBlock,
  getIncompleteSelfRegisteredPromoterLoginBlock,
  ONBOARDING_LOGIN_CODES: CODES,
};
