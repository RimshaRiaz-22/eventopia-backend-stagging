const pool = require("../db");
const SettledTicketService = require("./settledTicket.service");
const GuruRiskScoreService = require("./guruRiskScore.service");

/**
 * Guru Metrics Service
 * Refreshes guru_metrics_daily and guru_metrics_rollups for fast dashboards.
 */

/**
 * Get active promoters count for a guru
 * @param {number} guruId
 * @returns {Promise<number>}
 */
async function getActivePromotersCount(guruId) {
  const result = await pool.query(
    `SELECT COUNT(DISTINCT pgl.promoter_user_id)::int AS cnt
     FROM promoter_guru_links pgl
     JOIN users u ON u.id = pgl.promoter_user_id
     WHERE pgl.guru_user_id = $1
       AND COALESCE(u.account_status, 'active') = 'active'`,
    [guruId]
  );
  return parseInt(result.rows[0]?.cnt, 10) || 0;
}

/**
 * Get last settlement date for a guru (max completed_at of settled events)
 * @param {number} guruId
 * @returns {Promise<Date|null>}
 */
async function getLastSettlementAt(guruId) {
  const result = await pool.query(
    `SELECT MAX(e.completed_at) AS last_at
     FROM events e
     WHERE e.guru_id = $1
       AND e.completion_status = 'completed'
       AND COALESCE(e.settlement_status, 'SETTLED') = 'SETTLED'`,
    [guruId]
  );
  return result.rows[0]?.last_at || null;
}

/**
 * Refresh guru_metrics_daily for a single guru for a given date
 * @param {number} guruId
 * @param {number|null} networkLicenceId
 * @param {number|null} territoryId
 * @param {string} metricDate - ISO date string (YYYY-MM-DD)
 */
async function refreshDailyForGuru(guruId, networkLicenceId, territoryId, metricDate) {
  const dayStart = `${metricDate}T00:00:00.000Z`;
  const dayEnd = `${metricDate}T23:59:59.999Z`;

  const [settledCount, refundCount] = await Promise.all([
    SettledTicketService.countSettledTicketsForGuru(guruId, dayStart, dayEnd),
    SettledTicketService.countRefundedTicketsForGuru(guruId, dayStart, dayEnd),
  ]);
  const activePromoters = await getActivePromotersCount(guruId);

  const updateResult = await pool.query(
    `UPDATE guru_metrics_daily SET
       territory_id = $2, settled_tickets_count = $5, refunds_count = $6,
       active_promoters_count = $7, computed_at = NOW()
     WHERE guru_id = $1 AND (network_licence_id IS NOT DISTINCT FROM $3) AND metric_date = $4::date`,
    [guruId, territoryId, networkLicenceId, metricDate, settledCount, refundCount, activePromoters]
  );

  if (updateResult.rowCount === 0) {
    await pool.query(
      `INSERT INTO guru_metrics_daily
         (guru_id, territory_id, network_licence_id, metric_date, settled_tickets_count, refunds_count, active_promoters_count, computed_at)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, NOW())`,
      [guruId, territoryId, networkLicenceId, metricDate, settledCount, refundCount, activePromoters]
    );
  }
}

/**
 * Refresh guru_metrics_rollups for a single guru
 * @param {number} guruId
 * @param {number|null} networkLicenceId
 * @param {number|null} territoryId
 */
async function refreshRollupForGuru(guruId, networkLicenceId, territoryId) {
  const settled = await SettledTicketService.getSettledCountsByPeriod(guruId);
  const refunds = await SettledTicketService.getRefundCountsByPeriod(guruId);
  const activePromoters = await getActivePromotersCount(guruId);
  const lastSettlementAt = await getLastSettlementAt(guruId);

  const refundRateQuarter =
    settled.quarter > 0 ? (refunds.quarter / (settled.quarter + refunds.quarter)) * 100 : 0;

  const { risk_score, risk_level, risk_reasons } = GuruRiskScoreService.compute({
    quarterRefundRate: refundRateQuarter,
    priorQuarterRefundRate: null, // TODO: pass from prior period if available
  });

  const updateResult = await pool.query(
    `UPDATE guru_metrics_rollups SET
       territory_id = $2,
       settled_tickets_mtd = $4, settled_tickets_90d = $5, settled_tickets_quarter = $6, settled_tickets_ytd = $7,
       refunds_quarter = $8, refund_rate_quarter_percent = $9,
       risk_score = $10, risk_level = $11, risk_reasons = $12,
       active_promoters_count = $13, last_settlement_at = $14, computed_at = NOW()
     WHERE guru_id = $1 AND (network_licence_id IS NOT DISTINCT FROM $3)`,
    [
      guruId,
      territoryId,
      networkLicenceId,
      settled.mtd,
      settled.last90d,
      settled.quarter,
      settled.ytd,
      refunds.quarter,
      refundRateQuarter,
      risk_score,
      risk_level,
      JSON.stringify(risk_reasons),
      activePromoters,
      lastSettlementAt,
    ]
  );

  if (updateResult.rowCount === 0) {
    await pool.query(
      `INSERT INTO guru_metrics_rollups
         (guru_id, territory_id, network_licence_id,
          settled_tickets_mtd, settled_tickets_90d, settled_tickets_quarter, settled_tickets_ytd,
          refunds_quarter, refund_rate_quarter_percent,
          risk_score, risk_level, risk_reasons,
          active_promoters_count, last_settlement_at, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
      [
        guruId,
        territoryId,
        networkLicenceId,
        settled.mtd,
        settled.last90d,
        settled.quarter,
        settled.ytd,
        refunds.quarter,
        refundRateQuarter,
        risk_score,
        risk_level,
        JSON.stringify(risk_reasons),
        activePromoters,
        lastSettlementAt,
      ]
    );
  }
}

/**
 * Refresh all guru metrics (daily + rollups)
 * Called by scheduler. Populates yesterday's daily metrics and current rollups.
 */
async function refreshAllGuruMetrics() {
  const client = await pool.connect();
  try {
    const gnmResult = await client.query(
      `SELECT guru_user_id, network_licence_id, network_manager_user_id
       FROM guru_network_manager`
    );

    const licenceTerritory = {};
    if (gnmResult.rows.some((r) => r.network_licence_id)) {
      const tlResult = await client.query(
        `SELECT id, territory_id FROM territory_licences WHERE id = ANY($1::bigint[])`,
        [gnmResult.rows.map((r) => r.network_licence_id).filter(Boolean)]
      );
      tlResult.rows.forEach((r) => {
        licenceTerritory[r.id] = r.territory_id;
      });
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const metricDateStr = yesterday.toISOString().slice(0, 10);

    for (const row of gnmResult.rows) {
      const territoryId = row.network_licence_id
        ? licenceTerritory[row.network_licence_id] || null
        : null;
      await refreshDailyForGuru(row.guru_user_id, row.network_licence_id, territoryId, metricDateStr);
      await refreshRollupForGuru(row.guru_user_id, row.network_licence_id, territoryId);
    }
  } finally {
    client.release();
  }
}

/**
 * Get rollup for a guru (or compute on-the-fly if missing)
 * @param {number} guruId
 * @param {number|null} networkLicenceId
 * @returns {Promise<object>}
 */
async function getRollupForGuru(guruId, networkLicenceId) {
  const result = await pool.query(
    `SELECT * FROM guru_metrics_rollups
     WHERE guru_id = $1 AND (network_licence_id = $2 OR (network_licence_id IS NULL AND $2 IS NULL))
     LIMIT 1`,
    [guruId, networkLicenceId]
  );

  if (result.rowCount > 0) {
    return result.rows[0];
  }

  // Compute on-the-fly and persist
  const gnmResult = await pool.query(
    `SELECT network_licence_id FROM guru_network_manager WHERE guru_user_id = $1`,
    [guruId]
  );
  const gnm = gnmResult.rows[0];
  const nlId = networkLicenceId ?? gnm?.network_licence_id ?? null;
  let tId = null;
  if (nlId) {
    const tlResult = await pool.query(
      `SELECT territory_id FROM territory_licences WHERE id = $1`,
      [nlId]
    );
    tId = tlResult.rows[0]?.territory_id ?? null;
  }
  await refreshRollupForGuru(guruId, nlId, tId);

  const retry = await pool.query(
    `SELECT * FROM guru_metrics_rollups
     WHERE guru_id = $1 AND (network_licence_id = $2 OR (network_licence_id IS NULL AND $2 IS NULL))
     LIMIT 1`,
    [guruId, nlId]
  );
  return retry.rows[0] || null;
}

module.exports = {
  getActivePromotersCount,
  getLastSettlementAt,
  refreshDailyForGuru,
  refreshRollupForGuru,
  refreshAllGuruMetrics,
  getRollupForGuru,
};
