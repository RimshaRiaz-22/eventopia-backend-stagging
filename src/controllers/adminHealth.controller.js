/**
 * Admin Health Controller
 *
 * Provides admin endpoints for monitoring system health
 * including job execution status, failures, and operational metrics
 */

const pool = require('../db/index');
const { ok, fail } = require('../utils/standardResponse');
const { getJobRuns, getJobSummary } = require('../services/jobMonitoring.service');
const { getValidationLogsByEvent } = require('../services/validationLog.service');

/**
 * Get health summary - overall system health metrics
 * GET /api/admin/health/summary
 */
async function getHealthSummary(req, res) {
  try {
    // Job failures (last 24h)
    const jobStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
        COUNT(*) FILTER (WHERE status = 'success') as success_count,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours') as total_runs_24h
      FROM job_runs
      WHERE started_at > NOW() - INTERVAL '24 hours'
    `);

    return ok(res, req, {
      jobs: {
        last_24h: {
          total_runs: parseInt(jobStats.rows[0].total_runs_24h),
          successes: parseInt(jobStats.rows[0].success_count),
          failures: parseInt(jobStats.rows[0].failed_count)
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Health summary error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get job runs with filtering and pagination
 * GET /api/admin/health/jobs
 *
 * Query params:
 * - job_name: Filter by job name
 * - status: Filter by status ('running', 'success', 'failed')
 * - date_from: Filter from date (ISO string)
 * - date_to: Filter to date (ISO string)
 * - page: Page number (default: 1)
 * - page_size: Page size (default: 100, max: 500)
 */
async function getJobRunsHandler(req, res) {
  try {
    const {
      job_name,
      status,
      date_from,
      date_to,
      page = 1,
      page_size = 100
    } = req.query;

    // Validate and convert parameters
    const options = {
      jobName: job_name,
      status,
      page: parseInt(page, 10),
      pageSize: Math.min(parseInt(page_size, 10), 500) // Cap at 500
    };

    if (date_from) {
      const fromDate = new Date(date_from);
      if (isNaN(fromDate.getTime())) {
        return fail(res, req, 400, "INVALID_DATE_FROM", "Invalid date_from parameter");
      }
      options.dateFrom = fromDate;
    }

    if (date_to) {
      const toDate = new Date(date_to);
      if (isNaN(toDate.getTime())) {
        return fail(res, req, 400, "INVALID_DATE_TO", "Invalid date_to parameter");
      }
      options.dateTo = toDate;
    }

    const result = await getJobRuns(options);

    return ok(res, req, result);
  } catch (err) {
    console.error('Get job runs error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get audit logs with admin-level filtering
 * GET /api/admin/audit
 *
 * Query params:
 * - date_from: Filter from date (ISO string)
 * - date_to: Filter to date (ISO string)
 * - actor: Filter by actor user ID
 * - action_type: Filter by action type
 * - table: Filter by table ('ticket_audit_logs', 'event_audit_logs', 'admin_guru_actions')
 * - page: Page number (default: 1)
 * - page_size: Page size (default: 100, max: 500)
 */
async function getAuditLogs(req, res) {
  try {
    const {
      date_from,
      date_to,
      actor,
      action_type,
      table = 'all',
      page = 1,
      page_size = 100
    } = req.query;

    const pageNum = parseInt(page, 10);
    const sizeNum = Math.min(parseInt(page_size, 10), 500);
    const offset = (pageNum - 1) * sizeNum;

    const allLogs = [];

    // Helper function to build WHERE clause for a query
    const buildWhereClause = (filters) => {
      const conditions = [];
      const params = [];

      if (filters.date_from) {
        params.push(new Date(filters.date_from));
        conditions.push(`${filters.column_prefix}created_at >= $${params.length}`);
      }

      if (filters.date_to) {
        params.push(new Date(filters.date_to));
        conditions.push(`${filters.column_prefix}created_at <= $${params.length}`);
      }

      if (filters.actor) {
        params.push(parseInt(filters.actor, 10));
        conditions.push(`${filters.actor_column} = $${params.length}`);
      }

      if (filters.action_type) {
        params.push(filters.action_type);
        conditions.push(`${filters.action_column} = $${params.length}`);
      }

      return { whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
    };

    // Query ticket_audit_logs
    if (table === 'all' || table === 'ticket_audit_logs') {
      const { whereClause, params } = buildWhereClause({
        date_from,
        date_to,
        actor,
        action_type,
        column_prefix: 'tal.',
        actor_column: 'tal.actor_user_id',
        action_column: 'tal.action'
      });

      const ticketQuery = `
        SELECT
          'ticket_audit_logs' as table_name,
          tal.id,
          tal.created_at,
          tal.action,
          tal.ticket_id as entity_id,
          t.ticket_code as entity_title,
          COALESCE(u.name, tal.metadata->>'buyerName') as actor_name,
          tal.metadata
        FROM ticket_audit_logs tal
        LEFT JOIN tickets t ON t.id = tal.ticket_id
        LEFT JOIN users u ON u.id = tal.actor_user_id
        ${whereClause}
        ORDER BY tal.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

      const ticketParams = [...params, sizeNum, offset];
      const ticketResult = await pool.query(ticketQuery, ticketParams);
      allLogs.push(...ticketResult.rows);
    }

    // Query event_audit_logs
    if (table === 'all' || table === 'event_audit_logs') {
      const { whereClause, params } = buildWhereClause({
        date_from,
        date_to,
        actor,
        action_type,
        column_prefix: 'eal.',
        actor_column: 'eal.promoter_id',
        action_column: 'eal.action'
      });

      const eventQuery = `
        SELECT
          'event_audit_logs' as table_name,
          eal.id,
          eal.created_at,
          eal.action,
          eal.event_id as entity_id,
          e.title as entity_title,
          u.name as actor_name,
          NULL as metadata
        FROM event_audit_logs eal
        LEFT JOIN events e ON e.id = eal.event_id
        LEFT JOIN users u ON u.id = eal.promoter_id
        ${whereClause}
        ORDER BY eal.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

      const eventParams = [...params, sizeNum, offset];
      const eventResult = await pool.query(eventQuery, eventParams);
      allLogs.push(...eventResult.rows);
    }

    // Query admin_guru_actions
    if (table === 'all' || table === 'admin_guru_actions') {
      const { whereClause, params } = buildWhereClause({
        date_from,
        date_to,
        actor,
        action_type,
        column_prefix: 'aga.',
        actor_column: 'aga.admin_id',
        action_column: 'aga.action_type'
      });

      const guruQuery = `
        SELECT
          'admin_guru_actions' as table_name,
          aga.id,
          aga.created_at,
          aga.action_type as action,
          aga.guru_id as entity_id,
          u.name as entity_title,
          u2.name as actor_name,
          aga.metadata
        FROM admin_guru_actions aga
        LEFT JOIN users u ON u.id = aga.guru_id
        LEFT JOIN users u2 ON u2.id = aga.admin_id
        ${whereClause}
        ORDER BY aga.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

      const guruParams = [...params, sizeNum, offset];
      const guruResult = await pool.query(guruQuery, guruParams);
      allLogs.push(...guruResult.rows);
    }

    // If no queries were executed (e.g., invalid table name)
    if (allLogs.length === 0 && table !== 'all' && table !== 'ticket_audit_logs' && table !== 'event_audit_logs' && table !== 'admin_guru_actions') {
      return ok(res, req, {
        logs: [],
        pagination: {
          page: pageNum,
          pageSize: sizeNum,
          total: 0
        }
      });
    }

    // Sort all logs by created_at DESC
    allLogs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Apply pagination to combined results
    const paginatedLogs = allLogs.slice(0, sizeNum);

    return ok(res, req, {
      logs: paginatedLogs,
      pagination: {
        page: pageNum,
        pageSize: sizeNum,
        total: allLogs.length
      }
    });
  } catch (err) {
    console.error('Get audit logs error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

module.exports = {
  getHealthSummary,
  getJobRuns: getJobRunsHandler,
  getAuditLogs
};
