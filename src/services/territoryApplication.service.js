const pool = require("../db");

const APPLICATION_TYPE = { WAITLIST: "WAITLIST", REQUEST_ACCESS: "REQUEST_ACCESS" };
const STATUS = {
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
};

/**
 * Submit a waitlist/request access application for a territory.
 */
async function submitWaitlistApplication(territoryId, userId, applicationType = "WAITLIST", notes = null) {
  const result = await pool.query(
    `INSERT INTO territory_applications (territory_id, user_id, application_type, status, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [territoryId, userId, applicationType, STATUS.SUBMITTED, notes]
  );
  return result.rows[0];
}

/**
 * List territory applications for admin (filter by status).
 */
async function listForAdmin(options = {}) {
  const { status } = options;
  let where = "1=1";
  const params = [];
  if (status) {
    params.push(status);
    where += ` AND ta.status = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT ta.*, tli.region_name, tli.country_code, u.email, u.name
     FROM territory_applications ta
     JOIN territory_licence_inventory tli ON tli.id = ta.territory_id
     JOIN users u ON u.id = ta.user_id
     WHERE ${where}
     ORDER BY ta.submitted_at DESC`,
    params
  );
  return result.rows;
}

/**
 * Get single territory application by id.
 */
async function getById(applicationId) {
  const result = await pool.query(
    `SELECT * FROM territory_applications WHERE id = $1`,
    [applicationId]
  );
  return result.rowCount ? result.rows[0] : null;
}

/**
 * Approve a territory application (waitlist). Sets status to APPROVED.
 */
async function approve(applicationId, reviewedBy) {
  const result = await pool.query(
    `UPDATE territory_applications
     SET status = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $3 AND status IN ($4, $5)
     RETURNING *`,
    [STATUS.APPROVED, reviewedBy, applicationId, STATUS.SUBMITTED, STATUS.UNDER_REVIEW]
  );
  return result.rowCount ? result.rows[0] : null;
}

/**
 * Reject a territory application.
 */
async function reject(applicationId, reviewedBy, reason = null) {
  const result = await pool.query(
    `UPDATE territory_applications
     SET status = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW(),
         notes = CASE WHEN $4::text IS NOT NULL AND $4::text <> '' THEN $4 ELSE notes END
     WHERE id = $3
     RETURNING *`,
    [STATUS.REJECTED, reviewedBy, applicationId, reason]
  );
  return result.rowCount ? result.rows[0] : null;
}

module.exports = {
  submitWaitlistApplication,
  listForAdmin,
  getById,
  approve,
  reject,
  STATUS,
  APPLICATION_TYPE,
};
