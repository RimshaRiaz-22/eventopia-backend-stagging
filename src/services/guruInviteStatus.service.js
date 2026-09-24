/**
 * Resolves the login-blocking state for a Guru who was invited by the King but
 * hasn't finished registration yet (no password_hash set).
 *
 * Invite acceptance has two checkpoints, each backed by an existing column
 * (no schema changes needed):
 *   1. Invite opened   -> users.email_status = 'verified' (GET /gurus/invites/validate/:token)
 *   2. Password set     -> users.password_hash IS NOT NULL (POST /auth/guru/register,
 *                          which also sets name/contract_name/phone/agreed_to_terms
 *                          in the same call — there is no separate "profile submitted"
 *                          checkpoint since that call is atomic)
 *
 * Used by auth.controller.js#login() BEFORE the generic "pending approval" gate,
 * so an invited Guru mid-checkpoints gets a specific, actionable error instead of
 * a vague "Invalid email or password." or "pending approval." message.
 */
const pool = require("../db");

const CODES = {
  ACCOUNT_SETUP_REQUIRED: "ACCOUNT_SETUP_REQUIRED",
  PASSWORD_NOT_SET: "PASSWORD_NOT_SET",
  ACCOUNT_SETUP_ERROR: "ACCOUNT_SETUP_ERROR",
  // Self-registered Guru codes (distinct from the invite codes above so the web
  // client can tell the two flows apart).
  PROMOTER_INVITE_PENDING: "PROMOTER_INVITE_PENDING",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
};

/**
 * @param {{ id: number, email: string, password_hash: string|null, email_status: string|null }} user
 * @returns {Promise<null | { code: string, message: string, data: object }>}
 *   null means "not an invite-in-progress account, let login() continue as normal."
 */
async function getPendingGuruInviteLoginBlock(user) {
  if (user.password_hash) return null;

  const inviteResult = await pool.query(
    `SELECT invite_token, expires_at, used_at
     FROM guru_invites
     WHERE email = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [user.email]
  );

  if (inviteResult.rowCount === 0) return null;

  const invite = inviteResult.rows[0];

  // password_hash is null but this invite was already marked used — a data
  // inconsistency (e.g. a crash mid-acceptance-transaction), not a normal checkpoint.
  if (invite.used_at) {
    return {
      code: CODES.ACCOUNT_SETUP_ERROR,
      message: "There was a problem completing your account setup. Please contact support.",
      data: { email: user.email },
    };
  }

  const isExpired = new Date(invite.expires_at) < new Date();

  let code;
  let message;
  if (user.email_status !== "verified") {
    code = CODES.ACCOUNT_SETUP_REQUIRED;
    message = "Your account setup is remaining. Please check your email for the invite link.";
  } else {
    code = CODES.PASSWORD_NOT_SET;
    message = "Please set your password to activate your account.";
  }

  if (isExpired) {
    message += " Your invitation link has expired — please resend it.";
  }

  return {
    code,
    message,
    data: {
      email: user.email,
      inviteToken: isExpired ? null : invite.invite_token,
    },
  };
}

/**
 * Same idea for a Guru who SELF-registered (POST /auth/register with role guru) and
 * has not finished onboarding. Such a user is created with account_status 'requested'
 * and only moves to 'pending' once POST /gurus/applications succeeds, so
 * "requested + no guru_applications row" means onboarding is unfinished:
 *   1. email_status != 'verified'  -> EMAIL_NOT_VERIFIED (verify the email OTP)
 *   2. verified, no application    -> PROFILE_INCOMPLETE (submit the Guru application)
 * Anything else returns null so login() continues exactly as before.
 *
 * @returns {Promise<null | { code: string, message: string, data: object }>}
 */
async function getIncompleteSelfRegisteredGuruLoginBlock(user) {
  if (user.account_status !== "requested") return null;
  return buildOnboardingBlock(user, "guru", "guru_applications");
}

/**
 * Promoter equivalent. A self-registered promoter is created with role 'promoter' and
 * account_status 'pending'; it moves to 'pending_approval' once POST /promoters/applications
 * succeeds. Invited promoters have no password until they accept the invite and become
 * 'active' on acceptance, so they never match here (login() also requires a password_hash).
 */
async function getIncompleteSelfRegisteredPromoterLoginBlock(user) {
  if (user.role !== "promoter" || user.account_status !== "pending") return null;
  return buildOnboardingBlock(user, "promoter", "promoter_applications");
}

async function buildOnboardingBlock(user, role, applicationsTable) {
  const appResult = await pool.query(
    `SELECT 1 FROM ${applicationsTable} WHERE user_id = $1 LIMIT 1`,
    [user.id]
  );
  if (appResult.rowCount > 0) return null;

  const emailStatus = user.email_status || "pending";
  const data = { email: user.email, emailStatus, role };
  const roleLabel = role === "promoter" ? "Promoter" : "Guru";

  if (emailStatus !== "verified") {
    return {
      code: CODES.EMAIL_NOT_VERIFIED,
      message: "Your account setup is remaining. Please verify your email to continue.",
      data,
    };
  }

  return {
    code: CODES.PROFILE_INCOMPLETE,
    message: `Your profile is incomplete. Please submit your ${roleLabel} application to continue.`,
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
 * A Promoter invited by a Guru/King who hasn't accepted the invite yet (pre-created
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
  getPendingGuruInviteLoginBlock,
  getPendingPromoterInviteLoginBlock,
  getUnverifiedBuyerLoginBlock,
  getIncompleteSelfRegisteredGuruLoginBlock,
  getIncompleteSelfRegisteredPromoterLoginBlock,
  GURU_INVITE_LOGIN_CODES: CODES,
};
