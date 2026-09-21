const pool = require("../db");
const { revokeAllUserSessions } = require("../services/session.service");
const { ok, fail } = require("../utils/standardResponse");
const { approveGuruApplication, rejectGuruApplication } = require("./admin.controller");

/**
 * King's Account Guru module (King's Account / founder / admin).
 *
 *   Create   -> invite a Guru:            POST /auth/gurus/invites
 *   Read     -> list / details:           GET  /admin/gurus, GET /admin/gurus/:guruId
 *   Approve  -> self-registered Gurus:    PATCH /admin/gurus/:guruId/application-status  { status, comment }
 *   Update   -> profile details:          PATCH /admin/gurus/:guruId
 *   Block    -> stop a Guru logging in:   POST /admin/gurus/:guruId/block | unblock
 *   Delete   -> delete a Guru for good:   DELETE /admin/gurus/:guruId   (permanent; refused if records must be kept)
 */

const PHONE_E164_REGEX = /^\+[1-9]\d{1,14}$/;

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function trimmedOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Best-effort audit trail: a logging problem must never fail the action itself. */
async function logGuruAction({ adminId, guruId, actionType, oldValue, newValue, reason, metadata }) {
  try {
    await pool.query(
      `INSERT INTO admin_guru_actions (admin_id, guru_id, action_type, old_value, new_value, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [adminId, guruId, actionType, oldValue ?? null, newValue ?? null, reason ?? null, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    console.error("Guru admin action log error:", err.message);
  }
}

async function findGuru(guruId) {
  const result = await pool.query(
    `SELECT id, email, name, status, account_status FROM users WHERE id = $1 AND role = 'guru'`,
    [guruId]
  );
  return result.rows[0] || null;
}

// Application status of a Guru row (query aliases: u = users, ga = guru_applications).
// A Guru who was invited, or who has no application row, counts as approved.
const APPLICATION_STATUS_SQL =
  "CASE WHEN ga.id IS NOT NULL THEN ga.account_status WHEN u.role = 'guru' THEN 'approved' END";
// The King's comment: the rejection reason when rejected, otherwise the note left when approving.
const APPLICATION_COMMENT_SQL = `CASE WHEN ga.account_status = 'rejected' THEN ga.rejection_reason
  ELSE (SELECT a.reason FROM admin_guru_actions a
        WHERE a.guru_id = u.id AND a.action_type = 'application_approved'
        ORDER BY a.id DESC LIMIT 1) END`;
const APPLICATION_STATUSES = ["pending", "approved", "rejected"];

const GURU_SELECT = `
  u.id, u.user_no, u.email, u.name, u.phone, u.avatar_url, u.status, u.account_status, u.role,
  u.guru_active, u.guru_active_until, u.guru_activation_date, u.created_at,
  ga.id AS application_id, ga.contract_name, ga.territory_name,
  ga.activation_fee_status, ga.activation_fee_balance,
  ${APPLICATION_STATUS_SQL} AS application_status,
  ${APPLICATION_COMMENT_SQL} AS application_comment,
  gl.level, gl.rate_per_ticket,
  (SELECT COUNT(*)::int FROM promoter_guru_links pgl WHERE pgl.guru_user_id = u.id) AS promoters_count`;

const GURU_FROM = `
  FROM users u
  LEFT JOIN guru_applications ga ON ga.user_id = u.id
  LEFT JOIN guru_levels gl ON gl.guru_id = u.id AND gl.effective_until IS NULL`;

function mapGuruRow(g) {
  const fee = ["committed_upfront", "committed_negative_balance"].includes(g.activation_fee_status);
  return {
    id: g.id,
    userNo: g.user_no ?? null,
    email: g.email,
    name: g.name,
    phone: g.phone,
    avatarUrl: g.avatar_url,
    contractName: g.contract_name,
    territoryName: g.territory_name,
    status: g.status,
    accountStatus: g.account_status,
    applicationId: g.application_id ?? null,
    applicationStatus: g.application_status ?? null,
    applicationComment: g.application_comment ?? null,
    activationFeeStatus: g.activation_fee_status ?? null,
    // true when the King can approve right now: the application is waiting and the activation fee is committed
    readyForApproval: g.application_status === "pending" && fee,
    guruActive: g.guru_active,
    guruActiveUntil: g.guru_active_until,
    activationDate: g.guru_activation_date,
    level: g.level ?? null,
    ratePerTicket: g.rate_per_ticket ?? null,
    promotersCount: g.promoters_count,
    createdAt: g.created_at,
  };
}

/**
 * List Gurus, including self-registered applicants who are waiting for a decision.
 * GET /admin/gurus?applicationStatus=pending|approved|rejected&status=active|blocked|inactive&search=&page=1&limit=20
 */
async function listGurus(req, res) {
  try {
    const { search, status, applicationStatus } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? req.query.pageSize, 10) || 20));
    const offset = (page - 1) * limit;

    const conditions = ["(u.role = 'guru' OR ga.id IS NOT NULL)"];
    const values = [];

    if (applicationStatus) {
      if (!APPLICATION_STATUSES.includes(applicationStatus)) {
        return fail(res, req, 400, "VALIDATION_ERROR", "Application status must be one of: pending, approved, rejected.");
      }
      values.push(applicationStatus);
      conditions.push(`${APPLICATION_STATUS_SQL} = $${values.length}`);
    }

    if (status) {
      if (status === "active") conditions.push("u.status = 'active' AND COALESCE(u.account_status, 'active') = 'active'");
      else if (status === "blocked") conditions.push("u.account_status = 'blocked'");
      else if (status === "inactive") conditions.push("u.status <> 'active'");
      else return fail(res, req, 400, "VALIDATION_ERROR", "Status must be one of: active, blocked, inactive.");
    }

    if (search && String(search).trim()) {
      values.push(`%${String(search).trim()}%`);
      conditions.push(`(u.name ILIKE $${values.length} OR u.email ILIKE $${values.length} OR u.phone ILIKE $${values.length})`);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users u LEFT JOIN guru_applications ga ON ga.user_id = u.id ${where}`,
      values
    );
    const total = countResult.rows[0].total;

    const result = await pool.query(
      `SELECT ${GURU_SELECT}
       ${GURU_FROM}
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const gurus = result.rows.map(mapGuruRow);

    return ok(
      res,
      req,
      {
        gurus,
        count: gurus.length,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 },
      },
      total === 0 ? "No Gurus found." : "Gurus have been fetched successfully."
    );
  } catch (err) {
    console.error("List Gurus error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not fetch the Gurus. Please try again.");
  }
}

/**
 * Get Guru details (works for approved Gurus and for applicants waiting for a decision).
 * GET /admin/gurus/:guruId
 */
async function getGuruDetails(req, res) {
  try {
    const guruId = parseId(req.params.guruId);
    if (!guruId) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");

    const guruResult = await pool.query(
      `SELECT ${GURU_SELECT},
         u.email_status, u.last_login_at,
         ga.phone AS application_phone, ga.avatar_url AS application_avatar_url,
         ga.agreed_to_terms, ga.agreed_to_guru_agreement, ga.activation_fee_payment_method,
         ga.created_at AS application_created_at, ga.reviewed_at AS application_reviewed_at,
         gp.licence_balance
       ${GURU_FROM}
       LEFT JOIN guru_profiles gp ON gp.user_id = u.id
       WHERE u.id = $1 AND (u.role = 'guru' OR ga.id IS NOT NULL)`,
      [guruId]
    );

    if (guruResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Guru not found.");
    }

    const row = guruResult.rows[0];

    const promotersResult = await pool.query(
      `SELECT pgl.promoter_user_id, u.name, u.email, pgl.created_at AS attached_at, pgl.source
       FROM promoter_guru_links pgl
       JOIN users u ON u.id = pgl.promoter_user_id
       WHERE pgl.guru_user_id = $1
       ORDER BY pgl.created_at DESC`,
      [guruId]
    );

    const commissionsResult = await pool.query(
      `SELECT gc.*, u.name AS promoter_name, e.title AS event_title
       FROM guru_commissions gc
       JOIN users u ON u.id = gc.promoter_id
       LEFT JOIN events e ON e.id = gc.event_id
       WHERE gc.guru_id = $1
       ORDER BY gc.created_at DESC
       LIMIT 20`,
      [guruId]
    );

    return ok(
      res,
      req,
      {
        guru: {
          ...mapGuruRow(row),
          emailStatus: row.email_status,
          lastLoginAt: row.last_login_at,
          licenceBalance: row.licence_balance != null ? Number(row.licence_balance) : null,
          application: row.application_id
            ? {
                id: row.application_id,
                status: row.application_status,
                comment: row.application_comment ?? null,
                submittedAt: row.application_created_at,
                reviewedAt: row.application_reviewed_at,
                agreedToTerms: row.agreed_to_terms,
                agreedToGuruAgreement: row.agreed_to_guru_agreement,
                activationFeeStatus: row.activation_fee_status,
                activationFeeBalance: row.activation_fee_balance != null ? Number(row.activation_fee_balance) : null,
                activationFeePaymentMethod: row.activation_fee_payment_method,
              }
            : null,
        },
        promoters: promotersResult.rows,
        recentCommissions: commissionsResult.rows,
      },
      "Guru details have been fetched successfully."
    );
  } catch (err) {
    console.error("Get Guru details error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not fetch this Guru. Please try again.");
  }
}

/**
 * Approve or reject a Guru's application (self-registered Gurus).
 * PATCH /admin/gurus/:guruId/application-status
 * Body: { status: "approved" | "rejected", comment }   (comment is required when rejecting)
 */
async function updateApplicationStatus(req, res) {
  try {
    const guruId = parseId(req.params.guruId);
    if (!guruId) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");

    const status = String(req.body?.status || "").trim().toLowerCase();
    const comment = trimmedOrNull(req.body?.comment);

    if (!["approved", "rejected"].includes(status)) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Status must be either approved or rejected.");
    }
    if (status === "rejected" && !comment) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Please add a comment explaining why the application is rejected.");
    }

    const application = await pool.query(
      `SELECT id, account_status FROM guru_applications WHERE user_id = $1`,
      [guruId]
    );
    if (application.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "This user has no Guru application to review.");
    }

    // Reuse the existing approve / reject logic (activation-fee check, wallet, level, sessions...)
    req.params.applicationId = String(application.rows[0].id);
    if (status === "approved") {
      await approveGuruApplication(req, res);
    } else {
      req.body.rejection_reason = comment;
      await rejectGuruApplication(req, res);
    }

    if (res.statusCode < 400) {
      await logGuruAction({
        adminId: req.user.id,
        guruId,
        actionType: status === "approved" ? "application_approved" : "application_rejected",
        oldValue: application.rows[0].account_status,
        newValue: status,
        reason: comment || "Approved by King's Account",
      });
    }
  } catch (err) {
    console.error("Update Guru application status error:", err);
    if (!res.headersSent) {
      return fail(res, req, 500, "INTERNAL_ERROR", "We could not update the application status. Please try again.");
    }
  }
}


/**
 * Update a Guru's profile details
 * PATCH /admin/gurus/:guruId
 * Body (any of): { full_name | name, phone, avatar_url, contract_name, territory_name }
 */
async function updateGuru(req, res) {
  try {
    const guruId = parseId(req.params.guruId);
    if (!guruId) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");

    const guru = await findGuru(guruId);
    if (!guru) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");

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

    const userChanges = {};
    if (fullName) userChanges.name = fullName;
    if (has("phone")) userChanges.phone = phone;
    if (has("avatar_url")) userChanges.avatar_url = trimmedOrNull(body.avatar_url);

    const applicationChanges = {};
    if (has("contract_name")) applicationChanges.contract_name = trimmedOrNull(body.contract_name);
    if (has("territory_name")) applicationChanges.territory_name = trimmedOrNull(body.territory_name);
    if (has("phone")) applicationChanges.phone = phone;
    if (has("avatar_url")) applicationChanges.avatar_url = trimmedOrNull(body.avatar_url);

    if (Object.keys(userChanges).length === 0 && Object.keys(applicationChanges).length === 0) {
      return fail(
        res,
        req,
        400,
        "VALIDATION_ERROR",
        "Please provide at least one field to update: full_name, phone, avatar_url, contract_name or territory_name."
      );
    }

    const runUpdate = async (table, changes, whereColumn) => {
      const keys = Object.keys(changes);
      if (keys.length === 0) return;
      const sets = keys.map((k, i) => `${k} = $${i + 1}`);
      await pool.query(
        `UPDATE ${table} SET ${sets.join(", ")}, updated_at = NOW() WHERE ${whereColumn} = $${keys.length + 1}`,
        [...keys.map((k) => changes[k]), guruId]
      );
    };

    await runUpdate("users", userChanges, "id");
    await runUpdate("guru_applications", applicationChanges, "user_id");

    await logGuruAction({
      adminId: req.user.id,
      guruId,
      actionType: "profile_update",
      newValue: Object.keys({ ...userChanges, ...applicationChanges }).join(", "),
      reason: "Profile updated by King's Account",
      metadata: { user: userChanges, application: applicationChanges },
    });

    return getGuruDetailsAfterUpdate(req, res, guruId);
  } catch (err) {
    console.error("Update Guru error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not update this Guru. Please try again.");
  }
}

async function getGuruDetailsAfterUpdate(req, res, guruId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.phone, u.avatar_url, ga.contract_name, ga.territory_name
     FROM users u
     LEFT JOIN guru_applications ga ON ga.user_id = u.id
     WHERE u.id = $1`,
    [guruId]
  );
  return ok(res, req, { guru: result.rows[0] }, "Guru details have been updated successfully.");
}

/**
 * Block a Guru: cannot log in, existing sessions end, no longer shown as an active Guru.
 * POST /admin/gurus/:guruId/block   Body: { reason }
 */
async function blockGuru(req, res) {
  try {
    const guruId = parseId(req.params.guruId);
    if (!guruId) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");

    const reason = trimmedOrNull(req.body?.reason);
    if (!reason) return fail(res, req, 400, "VALIDATION_ERROR", "Please provide a reason for blocking this Guru.");

    const guru = await findGuru(guruId);
    if (!guru) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");
    if (guru.account_status === "blocked") {
      return fail(res, req, 409, "ALREADY_BLOCKED", "This Guru is already blocked.");
    }

    await pool.query(
      `UPDATE users
       SET account_status = 'blocked', guru_active = FALSE, roles_version = roles_version + 1, updated_at = NOW()
       WHERE id = $1`,
      [guruId]
    );
    await revokeAllUserSessions(guruId, "guru_blocked");
    await logGuruAction({
      adminId: req.user.id,
      guruId,
      actionType: "block",
      oldValue: guru.account_status,
      newValue: "blocked",
      reason,
    });

    return ok(res, req, { guruId, accountStatus: "blocked" }, "Guru has been blocked successfully. They can no longer log in.");
  } catch (err) {
    console.error("Block Guru error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not block this Guru. Please try again.");
  }
}

/**
 * Unblock a Guru.
 * POST /admin/gurus/:guruId/unblock
 */
async function unblockGuru(req, res) {
  try {
    const guruId = parseId(req.params.guruId);
    if (!guruId) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");

    const guru = await findGuru(guruId);
    if (!guru) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");
    if (guru.account_status !== "blocked") {
      return fail(res, req, 409, "NOT_BLOCKED", "This Guru is not blocked.");
    }

    await pool.query(
      `UPDATE users
       SET account_status = 'active', guru_active = TRUE, roles_version = roles_version + 1, updated_at = NOW()
       WHERE id = $1`,
      [guruId]
    );
    await logGuruAction({
      adminId: req.user.id,
      guruId,
      actionType: "unblock",
      oldValue: "blocked",
      newValue: "active",
      reason: trimmedOrNull(req.body?.reason) || "Unblocked by King's Account",
    });

    return ok(res, req, { guruId, accountStatus: "active" }, "Guru has been unblocked successfully. They can log in again.");
  } catch (err) {
    console.error("Unblock Guru error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not unblock this Guru. Please try again.");
  }
}

/**
 * Permanently delete a Guru account (hard delete, cannot be undone).
 * The user and everything that belongs to them (profile, application, wallet, sessions, referral
 * codes, commissions...) are removed, and the email can be used again.
 *
 * Refused with 409 when:
 *  - promoters are still attached (detach them first), or
 *  - the Guru has records that must be kept, such as ledger entries, orders or refunds.
 *    Block the account instead in that case.
 *
 * DELETE /admin/gurus/:guruId   Body (optional): { reason }
 */
async function deleteGuru(req, res) {
  const guruId = parseId(req.params.guruId);
  if (!guruId) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");

  const client = await pool.connect();
  try {
    const guru = await findGuru(guruId);
    if (!guru) return fail(res, req, 404, "NOT_FOUND", "Guru not found.");

    const promoters = await client.query(
      `SELECT COUNT(*)::int AS total FROM promoter_guru_links WHERE guru_user_id = $1`,
      [guruId]
    );
    if (promoters.rows[0].total > 0) {
      return fail(
        res,
        req,
        409,
        "GURU_HAS_PROMOTERS",
        `This Guru still has ${promoters.rows[0].total} promoter(s) attached. Detach them first, then delete the Guru.`
      );
    }

    await client.query("BEGIN");

    // Rows that would otherwise block the delete (they have no ON DELETE rule) or that only make sense
    // while the Guru exists. Audit rows about this Guru are removed; the deletion itself is logged below.
    await client.query(`DELETE FROM admin_guru_actions WHERE guru_id = $1`, [guruId]);
    await client.query(`DELETE FROM referral_events WHERE guru_id = $1 OR user_id = $1`, [guruId]);
    await client.query(`DELETE FROM user_attributions WHERE guru_id = $1`, [guruId]);
    // Invites and OTPs are keyed by email, so clear them to let the address be used again.
    await client.query(`DELETE FROM guru_invites WHERE email = $1`, [guru.email]);
    await client.query(`DELETE FROM otps WHERE email = $1`, [guru.email]);

    await client.query(`DELETE FROM users WHERE id = $1 AND role = 'guru'`, [guruId]);
    await client.query("COMMIT");

    await logGuruAction({
      adminId: req.user.id,
      guruId: null, // the Guru row no longer exists
      actionType: "delete",
      oldValue: guru.email,
      newValue: "deleted",
      reason: trimmedOrNull(req.body?.reason) || trimmedOrNull(req.query?.reason) || "Deleted by King's Account",
      metadata: { deletedGuruId: guruId, email: guru.email, name: guru.name },
    });

    return ok(res, req, { guruId, deleted: true }, "Guru account has been deleted successfully.");
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
        "GURU_HAS_RECORDS",
        "This Guru has financial or order records that must be kept, so the account cannot be deleted permanently. Block the account instead.",
        blockedBy ? { blockedBy } : undefined
      );
    }

    console.error("Delete Guru error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not delete this Guru. Please try again.");
  } finally {
    client.release();
  }
}

module.exports = {
  listGurus,
  getGuruDetails,
  updateApplicationStatus,
  updateGuru,
  blockGuru,
  unblockGuru,
  deleteGuru,
};
