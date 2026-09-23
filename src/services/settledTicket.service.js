const pool = require("../db");

/**
 * Settled Ticket Service
 * Single source of truth for "settled" tickets: event concluded + settlement complete + not refunded.
 * Refunded tickets are excluded from settled counts.
 */

const REFUNDED_STATUSES = ["REFUNDED", "CANCELLED", "VOID"];

/**
 * Base WHERE conditions for settled tickets
 * - Event completion_status = 'completed'
 * - Event settlement_status = 'SETTLED' (or pending/legacy treated as SETTLED for MVP)
 * - Ticket not refunded
 */
const SETTLED_TICKET_CONDITIONS = `
  e.completion_status = 'completed'
  AND COALESCE(e.settlement_status, 'SETTLED') = 'SETTLED'
  AND t.status NOT IN (${REFUNDED_STATUSES.map((s) => `'${s}'`).join(",")})
  AND t.refunded_at IS NULL
`;

/**
 * Count settled tickets for a guru within date range
 * @param {number} guruId
 * @param {Date|string|null} dateFrom - optional
 * @param {Date|string|null} dateTo - optional
 * @returns {Promise<number>}
 */
/**
 * Count settled, non-refunded tickets for all events owned by a promoter (users.id).
 * Used for credit wallet unlock threshold (575 settled tickets).
 * @param {number} promoterUserId - events.promoter_id
 * @returns {Promise<number>}
 */
async function countSettledTicketsForPromoter(promoterUserId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     WHERE e.promoter_id = $1
       AND ${SETTLED_TICKET_CONDITIONS.replace(/\n/g, " ")}`,
    [promoterUserId]
  );
  return parseInt(result.rows[0]?.cnt, 10) || 0;
}

async function countSettledTicketsForGuru(guruId, dateFrom, dateTo) {
  const params = [guruId];
  let dateFilter = "";
  if (dateFrom) {
    params.push(dateFrom);
    dateFilter += ` AND t.created_at >= $${params.length}`;
  }
  if (dateTo) {
    params.push(dateTo);
    dateFilter += ` AND t.created_at <= $${params.length}`;
  }

  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     WHERE e.guru_id = $1
       AND ${SETTLED_TICKET_CONDITIONS.replace(/\n/g, " ")}
       ${dateFilter}`,
    params
  );
  return parseInt(result.rows[0]?.cnt, 10) || 0;
}

/**
 * Count refunded tickets for a guru within date range
 * @param {number} guruId
 * @param {Date|string|null} dateFrom - optional
 * @param {Date|string|null} dateTo - optional
 * @returns {Promise<number>}
 */
async function countRefundedTicketsForGuru(guruId, dateFrom, dateTo) {
  const params = [guruId];
  let dateFilter = "";
  if (dateFrom) {
    params.push(dateFrom);
    dateFilter += ` AND (t.refunded_at >= $${params.length} OR t.updated_at >= $${params.length})`;
  }
  if (dateTo) {
    params.push(dateTo);
    dateFilter += ` AND (t.refunded_at <= $${params.length} OR t.updated_at <= $${params.length})`;
  }

  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     WHERE e.guru_id = $1
       AND (t.status IN (${REFUNDED_STATUSES.map((s) => `'${s}'`).join(",")}) OR t.refunded_at IS NOT NULL)
       ${dateFilter}`,
    params
  );
  return parseInt(result.rows[0]?.cnt, 10) || 0;
}

/**
 * Get settled ticket counts for a guru by period (MTD, 90D, quarter, YTD)
 * @param {number} guruId
 * @returns {Promise<{ mtd: number, last90d: number, quarter: number, ytd: number }>}
 */
async function getSettledCountsByPeriod(guruId) {
  const now = new Date();
  const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const ytdStart = new Date(now.getFullYear(), 0, 1);
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const [mtd, last90d, quarter, ytd] = await Promise.all([
    countSettledTicketsForGuru(guruId, mtdStart.toISOString(), now.toISOString()),
    countSettledTicketsForGuru(guruId, ninetyDaysAgo.toISOString(), now.toISOString()),
    countSettledTicketsForGuru(guruId, quarterStart.toISOString(), now.toISOString()),
    countSettledTicketsForGuru(guruId, ytdStart.toISOString(), now.toISOString()),
  ]);

  return { mtd, last90d, quarter, ytd };
}

/**
 * Count settled tickets for a promoter under a guru (events where promoter_id and guru_id)
 * @param {number} promoterId
 * @param {number} guruId
 * @returns {Promise<number>}
 */
async function countSettledTicketsForPromoterInGuruNetwork(promoterId, guruId) {
  const now = new Date();
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     WHERE e.promoter_id = $1 AND e.guru_id = $2
       AND ${SETTLED_TICKET_CONDITIONS.replace(/\n/g, " ")}
       AND t.created_at >= $3 AND t.created_at <= $4`,
    [promoterId, guruId, quarterStart.toISOString(), now.toISOString()]
  );
  return parseInt(result.rows[0]?.cnt, 10) || 0;
}

/**
 * Count refunded tickets for a promoter under a guru
 * @param {number} promoterId
 * @param {number} guruId
 * @returns {Promise<number>}
 */
async function countRefundedTicketsForPromoterInGuruNetwork(promoterId, guruId) {
  const now = new Date();
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     WHERE e.promoter_id = $1 AND e.guru_id = $2
       AND (t.status IN (${REFUNDED_STATUSES.map((s) => `'${s}'`).join(",")}) OR t.refunded_at IS NOT NULL)
       AND COALESCE(t.refunded_at, t.updated_at, t.created_at) >= $3
       AND COALESCE(t.refunded_at, t.updated_at, t.created_at) <= $4`,
    [promoterId, guruId, quarterStart.toISOString(), now.toISOString()]
  );
  return parseInt(result.rows[0]?.cnt, 10) || 0;
}

/**
 * Get refund counts for a guru by period
 * @param {number} guruId
 * @returns {Promise<{ mtd: number, quarter: number }>}
 */
async function getRefundCountsByPeriod(guruId) {
  const now = new Date();
  const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);

  const [mtd, quarter] = await Promise.all([
    countRefundedTicketsForGuru(guruId, mtdStart.toISOString(), now.toISOString()),
    countRefundedTicketsForGuru(guruId, quarterStart.toISOString(), now.toISOString()),
  ]);

  return { mtd, quarter };
}

module.exports = {
  REFUNDED_STATUSES,
  SETTLED_TICKET_CONDITIONS,
  countSettledTicketsForPromoter,
  countSettledTicketsForGuru,
  countRefundedTicketsForGuru,
  countSettledTicketsForPromoterInGuruNetwork,
  countRefundedTicketsForPromoterInGuruNetwork,
  getSettledCountsByPeriod,
  getRefundCountsByPeriod,
};
