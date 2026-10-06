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

module.exports = {
  REFUNDED_STATUSES,
  SETTLED_TICKET_CONDITIONS,
  countSettledTicketsForPromoter,
};
