const pool = require("../db");

/**
 * Log Network Manager actions for audit
 * @param {Object} params
 * @param {number} params.actorUserId
 * @param {string} params.action
 * @param {string} params.resource
 * @param {number} [params.resourceId]
 * @param {Object} [params.beforeSnapshot]
 * @param {Object} [params.afterSnapshot]
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 */
async function logAction(params) {
  const {
    actorUserId,
    action,
    resource,
    resourceId,
    beforeSnapshot,
    afterSnapshot,
    ip,
    userAgent,
  } = params;

  await pool.query(
    `INSERT INTO network_manager_audit_log
       (actor_user_id, action, resource, resource_id, before_snapshot, after_snapshot, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actorUserId,
      action,
      resource,
      resourceId ?? null,
      beforeSnapshot ? JSON.stringify(beforeSnapshot) : null,
      afterSnapshot ? JSON.stringify(afterSnapshot) : null,
      ip ?? null,
      userAgent ?? null,
    ]
  );
}

module.exports = { logAction };
