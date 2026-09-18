const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");

/**
 * Validate Guru Invite
 * GET /invites/validate/:inviteToken
 * 
 * Returns invite details and validation status
 * Handles errors:
 * - A: Invite expired
 * - B: Invite already used
 */
async function validateInvite(req, res) {
  try {
    const { inviteToken } = req.params;

    if (!inviteToken) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invite token is required");
    }

    // Find invite
    const inviteResult = await pool.query(
      `SELECT gi.*, u.name as created_by_name
       FROM guru_invites gi
       LEFT JOIN users u ON u.id = gi.created_by
       WHERE gi.invite_token = $1`,
      [inviteToken]
    );

    if (inviteResult.rowCount === 0) {
      return fail(res, req, 404, "INVITE_NOT_FOUND", "This invitation link is invalid or has been removed");
    }

    const invite = inviteResult.rows[0];

    // Check if invite is expired
    if (new Date(invite.expires_at) < new Date()) {
      return fail(res, req, 410, "INVITE_EXPIRED", "This invitation has expired. Please request a new invitation from your Network Manager or Admin");
    }

    // Check if invite has already been used
    if (invite.used_at) {
      return fail(res, req, 409, "INVITE_ALREADY_USED", "This invitation has already been accepted. Please log in to your account");
    }

    // Invite is valid
    const inviteData = {
      inviteToken: invite.invite_token,
      email: invite.email,
      name: invite.name,
      role: invite.role,
      expiresAt: invite.expires_at,
      createdAt: invite.created_at,
      createdBy: invite.created_by_name || 'Eventopia Admin',
      isValid: true,
      status: 'active'
    };

    return ok(res, req, "Invitation is valid", inviteData);
  } catch (err) {
    console.error('Validate invite error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to validate invitation");
  }
}

module.exports = {
  validateInvite
};
