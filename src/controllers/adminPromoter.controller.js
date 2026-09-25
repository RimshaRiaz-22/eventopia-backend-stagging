const pool = require("../db");
const { revokeAllUserSessions } = require("../services/session.service");
const { ok, fail } = require("../utils/standardResponse");
const { approvePromoterApplication } = require("./admin.controller");

/**
 * King's Account Promoter module (King's Account / founder / admin).
 *
 *   Create   -> invite a Promoter:          POST /auth/promoters/invites  (accepted invites are active immediately)
 *   Read     -> list / details:             GET  /admin/promoters, GET /admin/promoters/:promoterId
 *   Approve  -> self-registered Promoters:  PATCH /admin/promoters/:promoterId/application-status  { status, comment }
 *   Update   -> profile details:            PATCH /admin/promoters/:promoterId
 *   Block    -> stop a Promoter logging in: POST /admin/promoters/:promoterId/block | unblock
 *   Delete   -> delete a Promoter for good: DELETE /admin/promoters/:promoterId  (permanent; refused if records must be kept)
 */

const PHONE_E164_REGEX = /^\+[1-9]\d{1,14}$/;
const APPLICATION_STATUSES = ["pending", "approved", "rejected"];

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function trimmedOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Best-effort audit trail: a logging problem must never fail the action itself. */
async function logPromoterAction({ adminId, promoterId, actionType, oldValue, newValue, reason, metadata }) {
  try {
    await pool.query(
      `INSERT INTO admin_promoter_actions (admin_id, promoter_id, action_type, old_value, new_value, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [adminId, promoterId, actionType, oldValue ?? null, newValue ?? null, reason ?? null, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    console.error("Promoter admin action log error:", err.message);
  }
}

// Matches a Promoter by id whether they're an approved/invited Promoter (users.role = 'promoter')
// or a self-registered applicant (has a promoter_applications row).
async function findPromoter(promoterId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.status, u.account_status
     FROM users u
     LEFT JOIN promoter_applications pa ON pa.user_id = u.id
     WHERE u.id = $1 AND (u.role = 'promoter' OR pa.id IS NOT NULL)`,
    [promoterId]
  );
  return result.rows[0] || null;
}

// Application status of a Promoter row (query aliases: u = users, pa = promoter_applications).
// A self-registered Promoter who has not submitted the application yet is 'incomplete'; a Promoter who
// was invited (or otherwise has no application row) counts as approved.
const APPLICATION_STATUS_SQL =
  "CASE WHEN pa.id IS NOT NULL THEN pa.account_status " +
  "WHEN u.role = 'promoter' AND u.account_status = 'pending' AND u.password_hash IS NOT NULL THEN 'incomplete' " +
  "WHEN u.role = 'promoter' THEN 'approved' END";
// The King's comment: the rejection reason when rejected, otherwise the note left when approving.
const APPLICATION_COMMENT_SQL = `CASE WHEN pa.account_status = 'rejected' THEN pa.rejection_reason
  ELSE (SELECT a.reason FROM admin_promoter_actions a
        WHERE a.promoter_id = u.id AND a.action_type = 'application_approved'
        ORDER BY a.id DESC LIMIT 1) END`;

const PROMOTER_SELECT = `
  u.id, u.user_no, u.email, u.name, u.phone, u.avatar_url, u.status, u.account_status, u.role,
  u.email_status, u.created_at, (u.password_hash IS NULL) AS invite_pending,
  pa.id AS application_id, pa.territory_name,
  ${APPLICATION_STATUS_SQL} AS application_status,
  ${APPLICATION_COMMENT_SQL} AS application_comment,
  (SELECT COUNT(*)::int FROM events e WHERE e.promoter_id = u.id) AS events_count`;

const PROMOTER_FROM = `
  FROM users u
  LEFT JOIN promoter_applications pa ON pa.user_id = u.id`;

function mapPromoterRow(p) {
  return {
    id: p.id,
    userNo: p.user_no ?? null,
    email: p.email,
    name: p.name,
    phone: p.phone,
    avatarUrl: p.avatar_url,
    territoryName: p.territory_name,
    status: p.status,
    accountStatus: p.account_status,
    emailStatus: p.email_status,
    // true while an invited Promoter has not yet accepted the invite and set a password
    invitePending: !!p.invite_pending,
    applicationId: p.application_id ?? null,
    applicationStatus: p.application_status ?? null,
    applicationComment: p.application_comment ?? null,
    eventsCount: p.events_count,
    createdAt: p.created_at,
  };
}

/**
 * List Promoters, including self-registered applicants waiting for a decision and invited
 * Promoters who haven't accepted their invite yet.
 * GET /admin/promoters?applicationStatus=pending|approved|rejected&status=active|blocked|inactive&search=&page=1&limit=20
 */
async function listPromoters(req, res) {
  try {
    const { search, status, applicationStatus } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? req.query.pageSize, 10) || 20));
    const offset = (page - 1) * limit;

    const conditions = ["(u.role = 'promoter' OR pa.id IS NOT NULL)"];
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
      `SELECT COUNT(*)::int AS total ${PROMOTER_FROM} ${where}`,
      values
    );
    const total = countResult.rows[0].total;

    const result = await pool.query(
      `SELECT ${PROMOTER_SELECT}
       ${PROMOTER_FROM}
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const promoters = result.rows.map(mapPromoterRow);

    return ok(
      res,
      req,
      {
        promoters,
        count: promoters.length,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 },
      },
      total === 0 ? "No Promoters found." : "Promoters have been fetched successfully."
    );
  } catch (err) {
    console.error("List Promoters error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not fetch the Promoters. Please try again.");
  }
}

/**
 * Get Promoter details (works for approved Promoters and for applicants waiting for a decision).
 * GET /admin/promoters/:promoterId
 */
async function getPromoterDetails(req, res) {
  try {
    const promoterId = parseId(req.params.promoterId);
    if (!promoterId) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");

    const promoterResult = await pool.query(
      `SELECT ${PROMOTER_SELECT},
         u.last_login_at,
         pa.avatar_url AS application_avatar_url,
         pa.agreed_to_terms, pa.agreed_to_promoter_agreement, pa.agreed_to_activation_fee_terms,
         pa.created_at AS application_created_at, pa.reviewed_at AS application_reviewed_at
       ${PROMOTER_FROM}
       WHERE u.id = $1 AND (u.role = 'promoter' OR pa.id IS NOT NULL)`,
      [promoterId]
    );

    if (promoterResult.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");
    }

    const row = promoterResult.rows[0];

    const eventsResult = await pool.query(
      `SELECT id, title, status, completion_status, tickets_sold, start_at, end_at, created_at
       FROM events
       WHERE promoter_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [promoterId]
    );

    return ok(
      res,
      req,
      {
        promoter: {
          ...mapPromoterRow(row),
          lastLoginAt: row.last_login_at,
          application: row.application_id
            ? {
                id: row.application_id,
                status: row.application_status,
                comment: row.application_comment ?? null,
                submittedAt: row.application_created_at,
                reviewedAt: row.application_reviewed_at,
                agreedToTerms: row.agreed_to_terms,
                agreedToPromoterAgreement: row.agreed_to_promoter_agreement,
                agreedToActivationFeeTerms: row.agreed_to_activation_fee_terms,
              }
            : null,
        },
        events: eventsResult.rows,
      },
      "Promoter details have been fetched successfully."
    );
  } catch (err) {
    console.error("Get Promoter details error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not fetch this Promoter. Please try again.");
  }
}

/**
 * Approve or reject a self-registered Promoter's application.
 * Invited Promoters are active as soon as they accept the invite and need no approval.
 * PATCH /admin/promoters/:promoterId/application-status
 * Body: { status: "approved" | "rejected", comment }   (comment is required when rejecting)
 */
async function updateApplicationStatus(req, res) {
  try {
    const promoterId = parseId(req.params.promoterId);
    if (!promoterId) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");

    const status = String(req.body?.status || "").trim().toLowerCase();
    const comment = trimmedOrNull(req.body?.comment);

    if (!["approved", "rejected"].includes(status)) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Status must be either approved or rejected.");
    }
    if (status === "rejected" && !comment) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Please add a comment explaining why the application is rejected.");
    }

    const application = await pool.query(
      `SELECT id, account_status FROM promoter_applications WHERE user_id = $1`,
      [promoterId]
    );
    if (application.rowCount === 0) {
      return fail(res, req, 404, "NOT_FOUND", "This user has no Promoter application to review.");
    }
    const applicationId = application.rows[0].id;

    if (status === "approved") {
      // Reuse the existing approve logic (role, wallets, session revocation...)
      req.params.applicationId = String(applicationId);
      await approvePromoterApplication(req, res);
    } else {
      await pool.query(
        `UPDATE promoter_applications
         SET account_status = 'rejected', reviewed_by = $1, reviewed_at = NOW(),
             rejection_reason = $2, updated_at = NOW()
         WHERE id = $3`,
        [req.user.id, comment, applicationId]
      );
      ok(
        res,
        req,
        { promoterId, applicationId, applicationStatus: "rejected", comment },
        "Promoter application has been rejected."
      );
    }

    if (res.statusCode < 400) {
      await logPromoterAction({
        adminId: req.user.id,
        promoterId,
        actionType: status === "approved" ? "application_approved" : "application_rejected",
        oldValue: application.rows[0].account_status,
        newValue: status,
        reason: comment || "Approved by King's Account",
      });
    }
  } catch (err) {
    console.error("Update Promoter application status error:", err);
    if (!res.headersSent) {
      return fail(res, req, 500, "INTERNAL_ERROR", "We could not update the application status. Please try again.");
    }
  }
}

/**
 * Update a Promoter's profile details
 * PATCH /admin/promoters/:promoterId
 * Body (any of): { full_name | name, phone, avatar_url, territory_name }
 */
async function updatePromoter(req, res) {
  try {
    const promoterId = parseId(req.params.promoterId);
    if (!promoterId) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");

    const promoter = await findPromoter(promoterId);
    if (!promoter) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");

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
    if (has("territory_name")) applicationChanges.territory_name = trimmedOrNull(body.territory_name);
    if (has("avatar_url")) applicationChanges.avatar_url = trimmedOrNull(body.avatar_url);

    if (Object.keys(userChanges).length === 0 && Object.keys(applicationChanges).length === 0) {
      return fail(
        res,
        req,
        400,
        "VALIDATION_ERROR",
        "Please provide at least one field to update: full_name, phone, avatar_url or territory_name."
      );
    }

    const runUpdate = async (table, changes, whereColumn) => {
      const keys = Object.keys(changes);
      if (keys.length === 0) return;
      const sets = keys.map((k, i) => `${k} = $${i + 1}`);
      await pool.query(
        `UPDATE ${table} SET ${sets.join(", ")}, updated_at = NOW() WHERE ${whereColumn} = $${keys.length + 1}`,
        [...keys.map((k) => changes[k]), promoterId]
      );
    };

    await runUpdate("users", userChanges, "id");
    await runUpdate("promoter_applications", applicationChanges, "user_id");

    await logPromoterAction({
      adminId: req.user.id,
      promoterId,
      actionType: "profile_update",
      newValue: Object.keys({ ...userChanges, ...applicationChanges }).join(", "),
      reason: "Profile updated by King's Account",
      metadata: { user: userChanges, application: applicationChanges },
    });

    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.phone, u.avatar_url, pa.territory_name
       FROM users u
       LEFT JOIN promoter_applications pa ON pa.user_id = u.id
       WHERE u.id = $1`,
      [promoterId]
    );
    return ok(res, req, { promoter: result.rows[0] }, "Promoter details have been updated successfully.");
  } catch (err) {
    console.error("Update Promoter error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not update this Promoter. Please try again.");
  }
}

/**
 * Block a Promoter: cannot log in and existing sessions end.
 * POST /admin/promoters/:promoterId/block   Body: { reason }
 */
async function blockPromoter(req, res) {
  try {
    const promoterId = parseId(req.params.promoterId);
    if (!promoterId) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");

    const reason = trimmedOrNull(req.body?.reason);
    if (!reason) return fail(res, req, 400, "VALIDATION_ERROR", "Please provide a reason for blocking this Promoter.");

    const promoter = await findPromoter(promoterId);
    if (!promoter) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");
    if (promoter.account_status === "blocked") {
      return fail(res, req, 409, "ALREADY_BLOCKED", "This Promoter is already blocked.");
    }

    await pool.query(
      `UPDATE users
       SET account_status = 'blocked', roles_version = roles_version + 1, updated_at = NOW()
       WHERE id = $1`,
      [promoterId]
    );
    await revokeAllUserSessions(promoterId, "promoter_blocked");
    await logPromoterAction({
      adminId: req.user.id,
      promoterId,
      actionType: "block",
      oldValue: promoter.account_status,
      newValue: "blocked",
      reason,
    });

    return ok(res, req, { promoterId, accountStatus: "blocked" }, "Promoter has been blocked successfully. They can no longer log in.");
  } catch (err) {
    console.error("Block Promoter error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not block this Promoter. Please try again.");
  }
}

/**
 * Unblock a Promoter.
 * POST /admin/promoters/:promoterId/unblock
 */
async function unblockPromoter(req, res) {
  try {
    const promoterId = parseId(req.params.promoterId);
    if (!promoterId) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");

    const promoter = await findPromoter(promoterId);
    if (!promoter) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");
    if (promoter.account_status !== "blocked") {
      return fail(res, req, 409, "NOT_BLOCKED", "This Promoter is not blocked.");
    }

    await pool.query(
      `UPDATE users
       SET account_status = 'active', roles_version = roles_version + 1, updated_at = NOW()
       WHERE id = $1`,
      [promoterId]
    );
    await logPromoterAction({
      adminId: req.user.id,
      promoterId,
      actionType: "unblock",
      oldValue: "blocked",
      newValue: "active",
      reason: trimmedOrNull(req.body?.reason) || "Unblocked by King's Account",
    });

    return ok(res, req, { promoterId, accountStatus: "active" }, "Promoter has been unblocked successfully. They can log in again.");
  } catch (err) {
    console.error("Unblock Promoter error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not unblock this Promoter. Please try again.");
  }
}

/**
 * Permanently delete a Promoter account (hard delete, cannot be undone).
 * Refused with 409 when the Promoter has records that must be kept (events, orders, ledger
 * entries...). Block the account instead in that case.
 *
 * DELETE /admin/promoters/:promoterId   Body (optional): { reason }
 */
async function deletePromoter(req, res) {
  const promoterId = parseId(req.params.promoterId);
  if (!promoterId) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");

  const client = await pool.connect();
  try {
    const promoter = await findPromoter(promoterId);
    if (!promoter) return fail(res, req, 404, "NOT_FOUND", "Promoter not found.");

    await client.query("BEGIN");

    // Rows that would otherwise block the delete (they have no ON DELETE rule).
    await client.query(`DELETE FROM admin_promoter_actions WHERE promoter_id = $1`, [promoterId]);
    // Invites and OTPs are keyed by email, so clear them to let the address be used again.
    await client.query(`DELETE FROM promoter_referral_invites WHERE email = $1`, [promoter.email]);
    await client.query(`DELETE FROM otps WHERE email = $1`, [promoter.email]);

    await client.query(`DELETE FROM users WHERE id = $1`, [promoterId]);
    await client.query("COMMIT");

    await logPromoterAction({
      adminId: req.user.id,
      promoterId: null, // the Promoter row no longer exists
      actionType: "delete",
      oldValue: promoter.email,
      newValue: "deleted",
      reason: trimmedOrNull(req.body?.reason) || trimmedOrNull(req.query?.reason) || "Deleted by King's Account",
      metadata: { deletedPromoterId: promoterId, email: promoter.email, name: promoter.name },
    });

    return ok(res, req, { promoterId, deleted: true }, "Promoter account has been deleted successfully.");
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
        "This Promoter has events, financial or order records that must be kept, so the account cannot be deleted permanently. Block the account instead.",
        blockedBy ? { blockedBy } : undefined
      );
    }

    console.error("Delete Promoter error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", "We could not delete this Promoter. Please try again.");
  } finally {
    client.release();
  }
}

module.exports = {
  listPromoters,
  getPromoterDetails,
  updateApplicationStatus,
  updatePromoter,
  blockPromoter,
  unblockPromoter,
  deletePromoter,
};
