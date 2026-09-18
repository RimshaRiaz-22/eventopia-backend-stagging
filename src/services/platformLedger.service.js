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
    "guru_commission",
    "network_manager_cash",
    "platform_profit",
    "charity_pot",
  ];

  /**
   * Record a commission allocation: platform_ledger entry + ledger_allocations (guru_commission, network_manager_cash).
   * NM commission = same amount as guru commission (sum of guru commissions in network is NM commission).
   * @param {Object} params
   * @param {number} params.orderId
   * @param {number} params.eventId
   * @param {number} params.promoterId
   * @param {number} params.guruId
   * @param {number|null} params.networkManagerId - from event or guru_network_manager
   * @param {number} params.totalCommission - pence
   * @param {number} params.guruCommissionId - guru_commissions.id for reference
   * @param {Object} [client] - optional pg client for transaction
   */
  static async recordCommissionAllocations(
    {
      orderId,
      eventId,
      promoterId,
      guruId,
      networkManagerId,
      totalCommission,
      guruCommissionId,
    },
    client = null
  ) {
    const useClient = client || (await pool.connect());
    const release = !client;
    try {
      if (!client) await useClient.query("BEGIN");

      const ledgerResult = await useClient.query(
        `INSERT INTO platform_ledger
          (entity_type, entity_id, entry_type, amount, currency, description, order_id, event_id, promoter_id, metadata)
         VALUES ('Order', $1, 'Sale', $2, 'GBP', $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          orderId,
          totalCommission,
          `Commission allocation for order ${orderId}`,
          orderId,
          eventId,
          promoterId,
          JSON.stringify({ guru_commission_id: guruCommissionId }),
        ]
      );
      const ledgerEntryId = ledgerResult.rows[0].id;

      await useClient.query(
        `INSERT INTO ledger_allocations
          (ledger_entry_id, allocation_type, beneficiary_type, beneficiary_id, amount, reference_id, reference_type)
         VALUES ($1, 'guru_commission', 'guru', $2, $3, $4, 'guru_commission')`,
        [ledgerEntryId, guruId, totalCommission, guruCommissionId]
      );

      if (networkManagerId && totalCommission > 0) {
        await useClient.query(
          `INSERT INTO ledger_allocations
            (ledger_entry_id, allocation_type, beneficiary_type, beneficiary_id, amount, reference_id, reference_type)
           VALUES ($1, 'network_manager_cash', 'network_manager', $2, $3, $4, 'guru_commission')`,
          [ledgerEntryId, networkManagerId, totalCommission, guruCommissionId]
        );
      }

      if (!client) await useClient.query("COMMIT");
      return { ledgerEntryId };
    } catch (err) {
      if (!client) await useClient.query("ROLLBACK");
      throw err;
    } finally {
      if (release) useClient.release();
    }
  }

  /**
   * Sum of network_manager_cash allocations for a network manager (commission total from ledger).
   */
  static async getNetworkManagerCommissionTotal(networkManagerId, dateFrom = null, dateTo = null) {
    const params = [networkManagerId];
    let where = "WHERE allocation_type = 'network_manager_cash' AND beneficiary_id = $1";
    if (dateFrom) {
      params.push(dateFrom);
      where += ` AND la.created_at >= $${params.length}`;
    }
    if (dateTo) {
      params.push(dateTo);
      where += ` AND la.created_at <= $${params.length}`;
    }
    const result = await pool.query(
      `SELECT COALESCE(SUM(la.amount), 0)::bigint as total
       FROM ledger_allocations la
       ${where}`,
      params
    );
    return parseInt(result.rows[0].total, 10) || 0;
  }

  /**
   * Sum of guru_commission allocations per guru (for a given network manager's gurus).
   */
  static async getGuruCommissionTotalsByGuru(guruIds) {
    if (!guruIds || guruIds.length === 0) return {};
    const placeholders = guruIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query(
      `SELECT beneficiary_id as guru_id, COALESCE(SUM(amount), 0)::bigint as total
       FROM ledger_allocations
       WHERE allocation_type = 'guru_commission' AND beneficiary_id IN (${placeholders})
       GROUP BY beneficiary_id`,
      guruIds
    );
    const map = {};
    guruIds.forEach((id) => (map[id] = 0));
    result.rows.forEach((r) => (map[r.guru_id] = parseInt(r.total, 10)));
    return map;
  }

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
