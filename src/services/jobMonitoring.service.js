/**
 * Job Monitoring Service
 *
 * Handles tracking and monitoring of background job executions
 * Provides visibility into job health, failures, and performance
 */

const pool = require('../db/index');

/**
 * Start a job run and record it in the database
 * @param {string} jobName - Name of the job
 * @param {Object} metadata - Additional metadata about the job run
 * @returns {Promise<number>} - ID of the job run
 */
async function startJob(jobName, metadata = {}) {
  try {
    const query = `
      INSERT INTO job_runs (job_name, status, metadata)
      VALUES ($1, $2, $3)
      RETURNING id
    `;

    const result = await pool.query(query, [
      jobName,
      'running',
      metadata
    ]);

    return result.rows[0].id;
  } catch (err) {
    console.error(`Error starting job ${jobName}:`, err);
    throw err;
  }
}

/**
 * Mark a job run as completed
 * @param {number} runId - Job run ID
 * @param {string} status - Status ('success' or 'failed')
 * @param {string} errorMessage - Error message if failed (optional)
 * @returns {Promise<void>}
 */
async function finishJob(runId, status, errorMessage = null) {
  try {
    const query = `
      UPDATE job_runs
      SET status = $1, finished_at = NOW(), error_message = $2
      WHERE id = $3
    `;

    await pool.query(query, [
      status,
      errorMessage,
      runId
    ]);
  } catch (err) {
    console.error(`Error finishing job run ${runId}:`, err);
    throw err;
  }
}

/**
 * Mark a job run as successful
 * @param {number} runId - Job run ID
 * @returns {Promise<void>}
 */
async function markJobSuccess(runId) {
  await finishJob(runId, 'success', null);
}

/**
 * Mark a job run as failed
 * @param {number} runId - Job run ID
 * @param {string} errorMessage - Error message
 * @returns {Promise<void>}
 */
async function markJobFailed(runId, errorMessage) {
  // Truncate error message to fit in database column
  const truncatedMessage = errorMessage.substring(0, 500);
  await finishJob(runId, 'failed', truncatedMessage);
}

/**
 * Increment attempt count for a job run (for retries)
 * @param {number} runId - Job run ID
 * @returns {Promise<void>}
 */
async function incrementAttempts(runId) {
  try {
    const query = `
      UPDATE job_runs
      SET attempts = attempts + 1
      WHERE id = $1
    `;

    await pool.query(query, [runId]);
  } catch (err) {
    console.error(`Error incrementing attempts for job run ${runId}:`, err);
    throw err;
  }
}

/**
 * Get job run history with filtering
 * @param {Object} options - Query options
 * @param {string} options.jobName - Filter by job name
 * @param {string} options.status - Filter by status ('running', 'success', 'failed')
 * @param {Date} options.dateFrom - Filter from date
 * @param {Date} options.dateTo - Filter to date
 * @param {number} options.page - Page number
 * @param {number} options.pageSize - Page size
 * @returns {Promise<Object>} - Object with jobs and pagination info
 */
async function getJobRuns(options = {}) {
  const {
    jobName,
    status,
    dateFrom,
    dateTo,
    page = 1,
    pageSize = 100
  } = options;

  try {
    let whereClause = '';
    const params = [];
    let paramCount = 0;

    if (jobName) {
      paramCount++;
      whereClause += paramCount === 1 ? 'WHERE ' : ' AND ';
      whereClause += `job_name = $${paramCount}`;
      params.push(jobName);
    }

    if (status) {
      paramCount++;
      whereClause += paramCount === 1 ? 'WHERE ' : ' AND ';
      whereClause += `status = $${paramCount}`;
      params.push(status);
    }

    if (dateFrom) {
      paramCount++;
      whereClause += paramCount === 1 ? 'WHERE ' : ' AND ';
      whereClause += `started_at >= $${paramCount}`;
      params.push(dateFrom);
    }

    if (dateTo) {
      paramCount++;
      whereClause += `started_at <= $${paramCount}`;
      params.push(dateTo);
    }

    const offset = (page - 1) * pageSize;
    paramCount++;
    const limitClause = `LIMIT $${paramCount}`;
    params.push(pageSize);

    paramCount++;
    const offsetClause = `OFFSET $${paramCount}`;
    params.push(offset);

    const query = `
      SELECT
        id,
        job_name,
        status,
        started_at,
        finished_at,
        error_message,
        attempts,
        metadata,
        EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at)) as duration_seconds
      FROM job_runs
      ${whereClause}
      ORDER BY started_at DESC
      ${limitClause} ${offsetClause}
    `;

    const result = await pool.query(query, params);

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM job_runs
      ${whereClause}
    `;

    const countResult = await pool.query(countQuery, params.slice(0, -2)); // Remove limit and offset params
    const total = parseInt(countResult.rows[0].total, 10);

    return {
      jobs: result.rows,
      pagination: {
        page,
        pageSize,
        total
      }
    };
  } catch (err) {
    console.error('Error fetching job runs:', err);
    throw err;
  }
}

/**
 * Get job summary statistics
 * @param {number} eventId - Event ID (optional)
 * @returns {Promise<Object>} - Summary statistics
 */
async function getJobSummary(eventId = null) {
  try {
    let whereClause = '';
    const params = [];

    if (eventId) {
      whereClause = 'WHERE metadata->>\'eventId\' = $1';
      params.push(String(eventId));
    }

    const query = `
      SELECT
        job_name,
        COUNT(*) as total_runs,
        COUNT(*) FILTER (WHERE status = 'success') as successes,
        COUNT(*) FILTER (WHERE status = 'failed') as failures,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours') as runs_last_24h,
        AVG(EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))) as avg_duration_seconds
      FROM job_runs
      ${whereClause}
      GROUP BY job_name
      ORDER BY job_name
    `;

    const result = await pool.query(query, params);
    return result.rows;
  } catch (err) {
    console.error('Error fetching job summary:', err);
    throw err;
  }
}

/**
 * Get failed job runs in the last N hours
 * @param {number} hours - Number of hours to look back (default: 24)
 * @returns {Promise<Array>} - Array of failed job runs
 */
async function getRecentFailures(hours = 24) {
  try {
    const query = `
      SELECT
        id,
        job_name,
        status,
        started_at,
        finished_at,
        error_message,
        attempts,
        metadata,
        EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at)) as duration_seconds
      FROM job_runs
      WHERE status = 'failed'
        AND started_at > NOW() - INTERVAL '${hours} hours'
      ORDER BY started_at DESC
      LIMIT 100
    `;

    const result = await pool.query(query);
    return result.rows;
  } catch (err) {
    console.error('Error fetching recent failures:', err);
    throw err;
  }
}

/**
 * Get job run by ID
 * @param {number} runId - Job run ID
 * @returns {Promise<Object|null>} - Job run object or null
 */
async function getJobRunById(runId) {
  try {
    const query = `
      SELECT
        id,
        job_name,
        status,
        started_at,
        finished_at,
        error_message,
        attempts,
        metadata,
        EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at)) as duration_seconds
      FROM job_runs
      WHERE id = $1
    `;

    const result = await pool.query(query, [runId]);
    return result.rows[0] || null;
  } catch (err) {
    console.error(`Error fetching job run ${runId}:`, err);
    throw err;
  }
}

/**
 * Clean up old job runs (run periodically)
 * @param {number} daysToKeep - Number of days to keep records (default: 90)
 * @returns {Promise<number>} - Number of records deleted
 */
async function cleanupOldJobRuns(daysToKeep = 90) {
  try {
    const query = `
      DELETE FROM job_runs
      WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'
      RETURNING id
    `;

    const result = await pool.query(query);
    return result.rows.length;
  } catch (err) {
    console.error('Error cleaning up old job runs:', err);
    throw err;
  }
}

module.exports = {
  startJob,
  finishJob,
  markJobSuccess,
  markJobFailed,
  incrementAttempts,
  getJobRuns,
  getJobSummary,
  getRecentFailures,
  getJobRunById,
  cleanupOldJobRuns
};
