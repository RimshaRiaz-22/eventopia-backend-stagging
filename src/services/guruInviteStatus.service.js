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

module.exports = { getPendingGuruInviteLoginBlock, GURU_INVITE_LOGIN_CODES: CODES };
