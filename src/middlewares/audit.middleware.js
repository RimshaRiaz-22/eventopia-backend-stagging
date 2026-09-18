const pool = require("../db");

async function logEventChange(req, action, eventId, changes = {}) {
  try {
    await pool.query(
      `INSERT INTO event_audit_logs
       (event_id, promoter_id, action, field_name, old_value, new_value, request_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        eventId,
        req.user.id,
        action,
        changes.fieldName || null,
        changes.oldValue || null,
        changes.newValue || null,
        req.requestId || null,
        req.ip || null,
        req.get('user-agent') || null
      ]
    );
  } catch (err) {
    console.error("Audit log error:", err);
  }
}

async function logCharityChange(req, action, applicationId, changes = {}) {
  try {
    await pool.query(
      `INSERT INTO charity_pot_audit_logs
       (application_id, action, actor_user_id, field_name, old_value, new_value, request_id, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        applicationId,
        action,
        req.user?.id || null,
        changes.fieldName || null,
        changes.oldValue || null,
        changes.newValue || null,
        req.requestId || null,
        req.ip || null,
        req.get('user-agent') || null,
        changes.metadata ? JSON.stringify(changes.metadata) : null
      ]
    );
  } catch (err) {
    console.error("Charity audit log error:", err);
  }
}

async function logAdminAudit(req, action, resource = null, metadata = null) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, resource, metadata, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.user?.id || null,
        action,
        resource,
        metadata ? JSON.stringify(metadata) : null,
        req.ip || null,
        req.get("user-agent") || null,
      ]
    );
  } catch (err) {
    console.error("Admin audit log error:", err);
  }
}

module.exports = { logEventChange, logCharityChange, logAdminAudit };
