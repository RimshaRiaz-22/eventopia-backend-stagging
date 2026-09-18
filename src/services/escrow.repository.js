/**
 * EscrowRepository
 * Data access layer for escrow system (Contracts 15, 16, 17)
 * Handles all queries for escrow accounts, liabilities, and interest tracking
 * 
 * Timeline: Day 6 (March 2, 2026)
 * Contracts: 15 (GET /escrow/coverage/:territory_id)
 *            16 (GET /promoter/finance/escrow)
 *            17 (GET /escrow/interest/:territory_id)
 */

const db = require('../db');

class EscrowRepository {

  // ============ TERRITORY QUERIES ============

  /**
   * Check if territory exists
   * @param {number} territoryId
   * @returns {object} territory or null
   */
  async fetchTerritory(territoryId) {
    const query = `
      SELECT id, name 
      FROM territories 
      WHERE id = $1
    `;
    const result = await db.query(query, [territoryId]);
    return result.rows[0] || null;
  }

  // ============ ESCROW ACCOUNTS QUERIES ============

  /**
   * Fetch single escrow account by territory_id
   * Works with existing escrow_accounts table schema
   * @param {number} territoryId
   * @returns {object} account with balances, or null if not found
   */
  async fetchEscrowAccount(territoryId) {
    const query = `
      SELECT
        COALESCE(
          NULLIF(to_jsonb(ea)->>'id', '')::bigint,
          NULLIF(to_jsonb(ea)->>'escrow_account_id', '')::bigint
        ) AS id,
        ea.territory_id,
        COALESCE(
          NULLIF(to_jsonb(ea)->>'current_balance', '')::numeric,
          NULLIF(to_jsonb(ea)->>'balance', '')::numeric,
          0::numeric
        ) AS current_balance,
        COALESCE(NULLIF(to_jsonb(ea)->>'pending_liabilities', '')::numeric, 0::numeric) AS pending_liabilities,
        NULLIF(to_jsonb(ea)->>'coverage_ratio', '')::numeric AS coverage_ratio,
        COALESCE(NULLIF(to_jsonb(ea)->>'interest_earned', '')::numeric, 0::numeric) AS interest_earned,
        ea.created_at,
        ea.updated_at
      FROM escrow_accounts ea
      WHERE ea.territory_id = $1
      AND (
        to_jsonb(ea)->>'account_type' IS NULL
        OR to_jsonb(ea)->>'account_type' = 'escrow'
      )
      ORDER BY CASE WHEN to_jsonb(ea)->>'account_type' = 'escrow' THEN 0 ELSE 1 END, ea.created_at DESC
      LIMIT 1
    `;
    const result = await db.query(query, [territoryId]);
    return result.rows[0] || null;
  }

  // ============ ESCROW LIABILITIES QUERIES ============

  /**
   * Fetch all liabilities for a territory with specific statuses
   * @param {number} territoryId
   * @param {array} statusFilter - e.g., ['HOLDING', 'PAYOUT_ELIGIBLE']
   * @returns {array} liability records
   */
  async fetchLiabilitiesForTerritory(territoryId, statusFilter = ['HOLDING', 'PAYOUT_ELIGIBLE']) {
    const query = `
      SELECT liability_id, territory_id, promoter_id, event_id,
             gross_ticket_revenue, refund_deductions, net_liability, 
             status, created_at, updated_at
      FROM escrow_liabilities
      WHERE territory_id = $1 AND status = ANY($2::text[])
      ORDER BY created_at DESC
    `;
    const result = await db.query(query, [territoryId, statusFilter]);
    return result.rows;
  }

  /**
   * Calculate total net liability for a territory (specific statuses)
   * @param {number} territoryId
   * @param {array} statuses - ['HOLDING', 'PAYOUT_ELIGIBLE']
   * @returns {number} total sum
   */
  async calculateTotalLiabilities(territoryId, statuses = ['HOLDING', 'PAYOUT_ELIGIBLE']) {
    const query = `
      SELECT COALESCE(SUM(net_liability), 0::numeric) as total
      FROM escrow_liabilities
      WHERE territory_id = $1 AND status = ANY($2::text[])
    `;
    const result = await db.query(query, [territoryId, statuses]);
    return parseFloat(result.rows[0].total);
  }

  /**
   * Fetch liabilities for a specific promoter (their personal view)
   * Excludes PAID_OUT liabilities
   * @param {number} promoterId - promoter_profiles.id (not user_id)
   * @returns {array} liability records for that promoter
   */
  async fetchLiabilitiesForPromoter(promoterId) {
    const query = `
      SELECT el.liability_id, el.territory_id, el.promoter_id, el.event_id,
             el.gross_ticket_revenue, el.refund_deductions, el.net_liability,
             el.status, el.created_at, el.updated_at,
             e.title as event_title, e.start_at as event_date, e.status as event_status, e.completed_at as concluded_at,
             COALESCE(COUNT(CASE WHEN t.status = 'ACTIVE' THEN 1 END), 0) as tickets_sold
      FROM escrow_liabilities el
      JOIN events e ON el.event_id = e.id
      LEFT JOIN tickets t ON e.id = t.event_id AND t.status = 'ACTIVE'
      WHERE el.promoter_id = $1 AND el.status != 'PAID_OUT'
      GROUP BY el.liability_id, e.id
      ORDER BY e.start_at DESC
    `;
    const result = await db.query(query, [promoterId]);
    return result.rows;
  }

  /**
   * Fetch liability breakdown by status for a territory
   * @param {number} territoryId
   * @returns {object} {holding, payoutEligible, totalCount}
   */
  async fetchLiabilityBreakdown(territoryId) {
    const query = `
      SELECT 
        status,
        COUNT(*) as event_count,
        COALESCE(SUM(net_liability), 0::numeric) as total_amount
      FROM escrow_liabilities
      WHERE territory_id = $1 AND status IN ('HOLDING', 'PAYOUT_ELIGIBLE')
      GROUP BY status
    `;
    const result = await db.query(query, [territoryId]);
    
    const breakdown = {
      holding_liabilities: 0.00,
      payout_eligible_liabilities: 0.00,
      liability_event_count: 0
    };

    result.rows.forEach(row => {
      if (row.status === 'HOLDING') {
        breakdown.holding_liabilities = parseFloat(row.total_amount);
      } else if (row.status === 'PAYOUT_ELIGIBLE') {
        breakdown.payout_eligible_liabilities = parseFloat(row.total_amount);
      }
      breakdown.liability_event_count += row.event_count;
    });

    return breakdown;
  }

  // ============ INTEREST LOG QUERIES ============

  /**
   * Fetch interest entries for a territory with optional date range
   * Ordered by period_end DESC (most recent first)
   * @param {number} territoryId
   * @param {string} fromDate - YYYY-MM-DD (optional)
   * @param {string} toDate - YYYY-MM-DD (optional)
   * @returns {array} interest entries
   */
  async fetchInterestEntries(territoryId, fromDate = null, toDate = null) {
    let query = `
      SELECT eil.interest_id, eil.territory_id, eil.period_start, eil.period_end,
             eil.opening_balance, eil.interest_rate, eil.interest_amount, eil.source,
             eil.recorded_by, eil.created_at,
             CONCAT(u.name) as recorded_by_name
      FROM escrow_interest_log eil
      LEFT JOIN users u ON eil.recorded_by = u.id
      WHERE eil.territory_id = $1
    `;
    const params = [territoryId];

    if (fromDate) {
      params.push(fromDate);
      query += ` AND eil.period_end >= $${params.length}`;
    }

    if (toDate) {
      params.push(toDate);
      query += ` AND eil.period_start <= $${params.length}`;
    }

    query += ` ORDER BY eil.period_end DESC`;

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Calculate total interest earned (all-time)
   * @param {number} territoryId
   * @returns {number} total
   */
  async calculateTotalInterestEarned(territoryId) {
    const query = `
      SELECT COALESCE(SUM(interest_amount), 0::numeric) as total
      FROM escrow_interest_log
      WHERE territory_id = $1
    `;
    const result = await db.query(query, [territoryId]);
    return parseFloat(result.rows[0].total);
  }

  /**
   * Calculate interest earned within date range
   * @param {number} territoryId
   * @param {string} fromDate - YYYY-MM-DD
   * @param {string} toDate - YYYY-MM-DD
   * @returns {number} total
   */
  async calculateInterestInPeriod(territoryId, fromDate, toDate) {
    const query = `
      SELECT COALESCE(SUM(interest_amount), 0::numeric) as total
      FROM escrow_interest_log
      WHERE territory_id = $1 
      AND period_end >= $2 
      AND period_start <= $3
    `;
    const result = await db.query(query, [territoryId, fromDate, toDate]);
    return parseFloat(result.rows[0].total);
  }

  /**
   * Insert new interest entry (immutable after creation)
   * @param {object} data - {territory_id, period_start, period_end, opening_balance, interest_rate, interest_amount, source, recorded_by}
   * @returns {object} created interest record
   */
  async createInterestEntry(data) {
    const query = `
      INSERT INTO escrow_interest_log 
      (territory_id, period_start, period_end, opening_balance, interest_rate, interest_amount, source, recorded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const result = await db.query(query, [
      data.territory_id,
      data.period_start,
      data.period_end,
      data.opening_balance,
      data.interest_rate,
      data.interest_amount,
      data.source || 'bank_statement',
      data.recorded_by
    ]);
    return result.rows[0];
  }

  // ============ TERRITORY VERIFICATION ============

  /**
   * Verify territory exists and get name
   * @param {number} territoryId
   * @returns {object} territory record or null
   */
  async fetchTerritory(territoryId) {
    const query = `
      SELECT id, name FROM territories
      WHERE id = $1
    `;
    const result = await db.query(query, [territoryId]);
    return result.rows[0] || null;
  }

  // ============ PROMOTER PROFILE VERIFICATION ============

  /**
   * Verify promoter profile exists and get user_id
   * @param {number} promoterId - promoter_profiles.id
   * @returns {object} promoter profile record or null
   */
  async fetchPromoterProfile(promoterId) {
    const query = `
      SELECT id, user_id, territory_id FROM promoter_profiles
      WHERE id = $1
    `;
    const result = await db.query(query, [promoterId]);
    return result.rows[0] || null;
  }

  // ============ ALERT QUERIES ============

  /**
   * Fetch active (unresolved) RED coverage alert for territory
   * @param {number} territoryId
   * @returns {object} alert record or null
   */
  async fetchActiveRedAlert(territoryId) {
    const query = `
      SELECT id, territory_id, alert_type, level, title, message, created_at, triggered_at
      FROM alerts
      WHERE territory_id = $1
      AND alert_type = 'ESCROW_COVERAGE_RED'
      AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const result = await db.query(query, [territoryId]);
    return result.rows[0] || null;
  }

  /**
   * Insert audit log entry for alert action
   * @param {object} data - {alert_id, territory_id, action, actor_id, metadata}
   * @returns {object} created audit log record
   */
  async createAlertAuditLog(data) {
    const query = `
      INSERT INTO alert_audit_logs (alert_id, territory_id, action, actor_id, metadata)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, alert_id, action, created_at
    `;
    const result = await db.query(query, [
      data.alert_id,
      data.territory_id,
      data.action,
      data.actor_id,
      JSON.stringify(data.metadata || {})
    ]);
    return result.rows[0];
  }
}

module.exports = new EscrowRepository();
