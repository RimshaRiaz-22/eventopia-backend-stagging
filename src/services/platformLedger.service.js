const pool = require("../db");

/**
 * Platform Ledger Service (Phase 10)
 * Single source of truth for money flow; commission derived from ledger_allocations.
 */
class PlatformLedgerService {
  static ENTITY_TYPES = ["Event", "Order", "Promoter", "Payout"];
  static ENTRY_TYPES = ["Sale", "Fee", "Refund", "Payout", "Waiver"];
  static ALLOCATION_TYPES = [
    "promoter_commission",
    "platform_profit",
    "charity_pot",
  ];

  /**
   * Get ledger entries with filters (for admin ledger view).
   */
  static async getEntries(filters = {}) {
    const {
      date_from,
      date_to,
      entity_type,
      entry_type,
      promoter_id,
      event_id,
      limit = 100,
      offset = 0,
    } = filters;
    const params = [];
    let where = "1=1";
    if (date_from) {
      params.push(date_from);
      where += ` AND pl.created_at >= $${params.length}`;
    }
    if (date_to) {
      params.push(date_to);
      where += ` AND pl.created_at <= $${params.length}`;
    }
    if (entity_type) {
      params.push(entity_type);
      where += ` AND pl.entity_type = $${params.length}`;
    }
    if (entry_type) {
      params.push(entry_type);
      where += ` AND pl.entry_type = $${params.length}`;
    }
    if (promoter_id) {
      params.push(promoter_id);
      where += ` AND pl.promoter_id = $${params.length}`;
    }
    if (event_id) {
      params.push(event_id);
      where += ` AND pl.event_id = $${params.length}`;
    }
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT pl.id, pl.created_at, pl.entity_type, pl.entity_id, pl.entry_type,
              pl.amount, pl.currency, pl.description, pl.order_id, pl.event_id, pl.promoter_id, pl.metadata
       FROM platform_ledger pl
       WHERE ${where}
       ORDER BY pl.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return result.rows;
  }

  /**
   * Get allocations for a ledger entry (for drill-down).
   */
  static async getAllocationsForEntry(ledgerEntryId) {
    const result = await pool.query(
      `SELECT id, allocation_type, beneficiary_type, beneficiary_id, amount, created_at
       FROM ledger_allocations
       WHERE ledger_entry_id = $1
       ORDER BY id`,
      [ledgerEntryId]
    );
    return result.rows;
  }

  /**
   * Totals for King's Account overview: gross, booking fees, platform profit from platform_ledger.
   */
  static async getOverviewTotals() {
    const grossResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint as total
       FROM platform_ledger
       WHERE entry_type = 'Sale' AND amount > 0`
    );
    const feeResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint as total
       FROM platform_ledger
       WHERE entry_type = 'Fee' AND amount > 0`
    );
    const profitResult = await pool.query(
      `SELECT COALESCE(SUM(la.amount), 0)::bigint as total
       FROM ledger_allocations la
       WHERE la.allocation_type = 'platform_profit'`
    );
    return {
      totalGrossPayments: parseInt(grossResult.rows[0].total, 10) || 0,
      totalBookingFees: parseInt(feeResult.rows[0].total, 10) || 0,
      totalPlatformProfit: parseInt(profitResult.rows[0].total, 10) || 0,
    };
  }
}

module.exports = PlatformLedgerService;
