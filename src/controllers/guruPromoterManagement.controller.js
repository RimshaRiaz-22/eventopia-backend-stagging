const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");
const { ensurePromoterCreditWallet } = require("../services/promoterCreditWallet.service");

/**
 * Guru -> promoter management (Guru only, promoter must be attached to the calling Guru).
 * These sit next to the existing list/details/approve/reject endpoints and do not replace them.
 *
 *   Update -> PATCH  /gurus/promoters/:promoterId          { full_name | name, phone, avatar_url, city }
 *   Status -> PATCH  /gurus/promoters/:promoterId/status   { status: "approved" | "rejected", comment }
 *   Delete -> DELETE /gurus/promoters/:promoterId          { reason? }
 *
 * :promoterId is the same id the Guru dashboard list returns as `promoterId`
 * (a user id, or an invite id for an invited promoter who has not registered yet).
 */

const PHONE_E164_REGEX = /^\+[1-9]\d{1,14}$/;

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function trimmedOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolves :promoterId to the promoter's user and checks it is attached to this Guru.
 * Same resolution order as activatePendingPromoter: an open invite of this Guru with that id
 * wins, otherwise the id is a user id.
 *
 * @returns {Promise<{ error?: { status: number, code: string, message: string }, user?: object, invite?: object|null }>}
 */
async function resolvePromoter(client, guruId, rawId) {
  const requestedId = parseId(rawId);
  if (!requestedId) {
    return { error: { status: 404, code: "NOT_FOUND", message: "Promoter not found." } };
  }

  const inviteResult = await client.query(
    `SELECT id, email
     FROM promoter_referral_invites
     WHERE id = $1 AND guru_user_id = $2 AND used_at IS NULL
     LIMIT 1`,
    [requestedId, guruId]
  );
  const invite = inviteResult.rows[0] || null;

  const userResult = invite
    ? await client.query(
        `SELECT id, user_no, email, name, phone, city, avatar_url, role, account_status, email_status
         FROM users WHERE email = $1 ORDER BY created_at ASC LIMIT 1`,
        [invite.email]
      )
    : await client.query(
        `SELECT id, user_no, email, name, phone, city, avatar_url, role, account_status, email_status
         FROM users WHERE id = $1 LIMIT 1`,
        [requestedId]
      );

  const user = userResult.rows[0] || null;
  if (!user) {
    // An invite with no user yet can still be handled by delete (revokes the invite).
    if (invite) return { user: null, invite };
    return { error: { status: 404, code: "NOT_FOUND", message: "Promoter not found." } };
  }

  const link = await client.query(
    `SELECT guru_user_id, source FROM promoter_guru_links WHERE promoter_user_id = $1 LIMIT 1`,
    [user.id]
  );
  if (link.rowCount === 0 || Number(link.rows[0].guru_user_id) !== Number(guruId)) {
    return {
      error: {
        status: 403,
        code: "NOT_AUTHORIZED",
        message: "You can only manage promoters attached to you.",
      },
    };
  }

  return { user, invite, linkSource: link.rows[0].source };
}

/**
 * Update a promoter's profile details
 * PATCH /gurus/promoters/:promoterId
 * Body (any of): { full_name | name, phone, avatar_url, city }
 */
async function updatePromoter(req, res) {
  const client = await pool.connect();
  try {
    const resolved = await resolvePromoter(client, req.user.id, req.params.promoterId);
    if (resolved.error) {
      return fail(res, req, resolved.error.status, resolved.error.code, resolved.error.message);
    }
    if (!resolved.user) {
      return fail(res, req, 404, "NOT_FOUND", "This promoter has not registered yet, so there is nothing to edit.");
    }
    const { user } = resolved;

    const body = req.body || {};
    const has = (key) => body[key] !== undefined;
    const fullName = trimmedOrNull(body.full_name ?? body.name);
    const phone = trimmedOrNull(body.phone);

    if (fullName && fullName.length < 2) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Full name must be at least 2 characters long.");
    }
    if (has("phone") && phone && !PHONE_E164_REGEX.test(phone)) {
      return fail(res, req, 422, "VALIDATION_ERROR", "Phone number must be in E.164 format (e.g., +447911123456).");
    }

    const changes = {};
    if (fullName) changes.name = fullName;
    if (has("phone")) changes.phone = phone;
    if (has("avatar_url")) changes.avatar_url = trimmedOrNull(body.avatar_url);
    if (has("city")) changes.city = trimmedOrNull(body.city);

    if (Object.keys(changes).length === 0) {
      return fail(
        res,
        req,
        400,
        "VALIDATION_ERROR",
        "Please provide at least one field to update: full_name, phone, avatar_url or city."
      );
    }

    const keys = Object.keys(changes);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    await client.query(
      `UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => changes[k]), user.id]
    );

    // Keep the application's copy of the avatar in step with the profile.
    if (has("avatar_url")) {
      await client.query(
        `UPDATE promoter_applications SET avatar_url = $1, updated_at = NOW() WHERE user_id = $2`,
        [changes.avatar_url, user.id]
      );
    }

    const updated = await client.query(
      `SELECT id, user_no, email, name, phone, city, avatar_url, account_status FROM users WHERE id = $1`,
      [user.id]
    );
    const row = updated.rows[0];

    return ok(
      res,
      req,
      {
        promoter: {
          promoterId: row.id,
          userNo: row.user_no ?? null,
          email: row.email,
          name: row.name,
          phone: row.phone,
          city: row.city,
          avatarUrl: row.avatar_url,
          accountStatus: row.account_status,
        },
      },
      "Promoter details have been updated successfully."
    );
  } catch (err) {
    console.error("Guru update promoter error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not update this promoter. Please try again.");
  } finally {
    client.release();
  }
}

/**
 * Approve or reject a promoter with a single endpoint
 * PATCH /gurus/promoters/:promoterId/status
 * Body: { status: "approved" | "rejected", comment }   (comment is required when rejecting)
 *
 * "approved" does what POST /gurus/dashboard/promoters/:promoterId/activate does;
 * "rejected" does what POST /gurus/promoters/:applicationId/reject does.
 */
async function updatePromoterStatus(req, res) {
  const status = String(req.body?.status || "").trim().toLowerCase();
  if (!["approved", "rejected"].includes(status)) {
    return fail(res, req, 400, "VALIDATION_ERROR", "Status must be either 'approved' or 'rejected'.");
  }

  const comment = trimmedOrNull(req.body?.comment ?? req.body?.rejection_reason);
  if (status === "rejected" && !comment) {
    return fail(res, req, 400, "VALIDATION_ERROR", "Please provide a reason for rejecting this promoter.");
  }

  const guruId = req.user.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const resolved = await resolvePromoter(client, guruId, req.params.promoterId);
    if (resolved.error) {
      await client.query("ROLLBACK");
      return fail(res, req, resolved.error.status, resolved.error.code, resolved.error.message);
    }
    if (!resolved.user) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "This promoter has not registered yet.");
    }
    const { user, linkSource } = resolved;

    const appResult = await client.query(
      `SELECT id, account_status
       FROM promoter_applications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [user.id]
    );
    const application = appResult.rows[0] || null;
    const isActive = String(user.account_status || "").toLowerCase() === "active";

    if (status === "approved") {
      if (isActive) {
        await client.query("ROLLBACK");
        return fail(res, req, 409, "ALREADY_ACTIVE", "This promoter is already active.");
      }
      if (
        application?.account_status === "rejected" ||
        String(user.account_status || "").toLowerCase() === "rejected"
      ) {
        await client.query("ROLLBACK");
        return fail(res, req, 400, "APPLICATION_REJECTED", "A rejected promoter cannot be approved.");
      }
      // Invite-linked promoters can be activated without an application (same rule as /activate).
      const isInviteLinked = String(linkSource || "").toLowerCase() === "invite_referral";
      if (!application && !isInviteLinked) {
        await client.query("ROLLBACK");
        return fail(res, req, 404, "NO_APPLICATION", "No promoter application found for this user.");
      }

      if (application) {
        await client.query(
          `UPDATE promoter_applications
           SET account_status = 'approved', reviewed_by = $1, reviewed_at = NOW()
           WHERE id = $2`,
          [guruId, application.id]
        );
      }

      const promoted = await client.query(
        `UPDATE users
         SET role = 'promoter', account_status = 'active', roles_version = roles_version + 1, updated_at = NOW()
         WHERE id = $1
         RETURNING user_no, email, name, roles_version`,
        [user.id]
      );
      await ensurePromoterCreditWallet(client, user.id);
      await client.query(
        `UPDATE promoter_referral_invites
         SET used_at = NOW(), updated_at = NOW()
         WHERE guru_user_id = $1 AND email = $2 AND used_at IS NULL`,
        [guruId, promoted.rows[0].email]
      );

      await client.query("COMMIT");
      return ok(
        res,
        req,
        {
          application: application ? { id: application.id, accountStatus: "approved" } : null,
          user: {
            userId: promoted.rows[0].user_no ?? user.id,
            email: promoted.rows[0].email,
            name: promoted.rows[0].name,
            role: "promoter",
            accountStatus: "active",
            rolesVersion: promoted.rows[0].roles_version,
          },
        },
        "Promoter approved successfully. They can now sell tickets."
      );
    }

    // status === "rejected"
    if (isActive) {
      await client.query("ROLLBACK");
      return fail(res, req, 409, "ALREADY_ACTIVE", "An active promoter cannot be rejected.");
    }
    if (!application) {
      // An invited promoter has no application. Rejecting them closes the invite: the user is marked
      // rejected and the invite is used up, so it can neither be resent nor registered with.
      const isInviteLinked = String(linkSource || "").toLowerCase() === "invite_referral";
      if (!isInviteLinked) {
        await client.query("ROLLBACK");
        return fail(res, req, 404, "NO_APPLICATION", "This promoter has no application to reject.");
      }
      if (String(user.account_status || "").toLowerCase() === "rejected") {
        await client.query("ROLLBACK");
        return fail(res, req, 409, "ALREADY_REJECTED", "This promoter has already been rejected.");
      }

      await client.query(
        `UPDATE users SET account_status = 'rejected', updated_at = NOW() WHERE id = $1`,
        [user.id]
      );
      await client.query(
        `UPDATE promoter_referral_invites
         SET used_at = NOW(), updated_at = NOW()
         WHERE guru_user_id = $1 AND email = $2 AND used_at IS NULL`,
        [guruId, user.email]
      );

      await client.query("COMMIT");
      return ok(
        res,
        req,
        { user: { promoterId: user.id, accountStatus: "rejected", rejectionReason: comment } },
        "Promoter invitation rejected."
      );
    }
    if (application.account_status === "rejected") {
      await client.query("ROLLBACK");
      return fail(res, req, 409, "ALREADY_REJECTED", "This application has already been rejected.");
    }
    if (application.account_status === "approved") {
      await client.query("ROLLBACK");
      return fail(res, req, 409, "ALREADY_APPROVED", "This application has already been approved.");
    }

    await client.query(
      `UPDATE promoter_applications
       SET account_status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), rejection_reason = $2
       WHERE id = $3`,
      [guruId, comment, application.id]
    );

    await client.query("COMMIT");
    return ok(
      res,
      req,
      { application: { id: application.id, accountStatus: "rejected", rejectionReason: comment } },
      "Promoter application rejected."
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error("Guru update promoter status error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not update the promoter status. Please try again.");
  } finally {
    client.release();
  }
}

/**
 * Permanently delete a promoter attached to this Guru (hard delete, cannot be undone).
 * Removes the user and what belongs to them (application, profile, wallet, invites, OTPs), so the
 * email can be registered again. For an invited promoter who has not registered yet it revokes the invite.
 *
 * Refused with 409 when the promoter has events, or other records that must be kept
 * (orders, ledger entries, refunds...).
 *
 * DELETE /gurus/promoters/:promoterId   Body (optional): { reason }
 */
async function deletePromoter(req, res) {
  const guruId = req.user.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const resolved = await resolvePromoter(client, guruId, req.params.promoterId);
    if (resolved.error) {
      await client.query("ROLLBACK");
      return fail(res, req, resolved.error.status, resolved.error.code, resolved.error.message);
    }

    // Invited but never registered: just revoke the invite.
    if (!resolved.user) {
      await client.query(`DELETE FROM promoter_referral_invites WHERE id = $1`, [resolved.invite.id]);
      await client.query("COMMIT");
      return ok(res, req, { promoterId: resolved.invite.id, deleted: true }, "Promoter invitation has been revoked.");
    }

    const { user } = resolved;

    const events = await client.query(
      `SELECT COUNT(*)::int AS total FROM events WHERE promoter_id = $1`,
      [user.id]
    );
    if (events.rows[0].total > 0) {
      await client.query("ROLLBACK");
      return fail(
        res,
        req,
        409,
        "PROMOTER_HAS_EVENTS",
        `This promoter has ${events.rows[0].total} event(s), so the account cannot be deleted.`
      );
    }

    // Invites and OTPs are keyed by email, so clear them to let the address be used again.
    await client.query(`DELETE FROM promoter_referral_invites WHERE email = $1`, [user.email]);
    await client.query(`DELETE FROM otps WHERE email = $1`, [user.email]);
    await client.query(`DELETE FROM users WHERE id = $1`, [user.id]);

    await client.query("COMMIT");
    return ok(res, req, { promoterId: user.id, deleted: true }, "Promoter has been deleted successfully.");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    // 23503 = still referenced by a required record, P0001 = the immutable ledger refused the change
    if (err.code === "23503" || err.code === "P0001") {
      const blockedBy = /referenced from table "([^"]+)"/.exec(err.detail || "")?.[1] || err.table || null;
      return fail(
        res,
        req,
        409,
        "PROMOTER_HAS_RECORDS",
        "This promoter has financial or order records that must be kept, so the account cannot be deleted.",
        blockedBy ? { blockedBy } : undefined
      );
    }

    console.error("Guru delete promoter error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not delete this promoter. Please try again.");
  } finally {
    client.release();
  }
}

module.exports = {
  updatePromoter,
  updatePromoterStatus,
  deletePromoter,
};
