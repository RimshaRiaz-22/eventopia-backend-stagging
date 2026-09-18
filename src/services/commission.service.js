const pool = require("../db");
const GuruService = require("./guru.service");
const PlatformLedgerService = require("./platformLedger.service");

/**
 * Commission Service
 * Handles Guru commission calculations and tracking
 */
class CommissionService {
  /**
   * Calculate commission for an order
   * @param {number} orderId - Order ID
   * @returns {Promise<Object>} Commission calculation
   */
  static async calculateOrderCommission(orderId) {
    const client = await pool.connect();
    try {
      // Get order with event and promoter info (include network_manager_id for ledger)
      const orderResult = await client.query(
        `SELECT
           o.*,
           e.promoter_id,
           e.guru_id,
           e.network_manager_id,
           e.id as event_id
         FROM orders o
         JOIN events e ON e.id = o.event_id
         WHERE o.id = $1`,
        [orderId]
      );

      if (orderResult.rowCount === 0) {
        throw new Error('Order not found');
      }

      const order = orderResult.rows[0];

      // Check if event has a guru
      if (!order.guru_id) {
        return {
          hasGuru: false,
          commission: 0,
          reason: 'Event has no attached Guru'
        };
      }

      // Get Guru's current level
      const level = await GuruService.getCurrentLevel(order.guru_id);
      const commissionRate = level.rate_per_ticket; // In pence per ticket

      // Count tickets for this order (sold = issued for order)
      const ticketsResult = await client.query(
        `SELECT COUNT(*) as ticket_count
         FROM tickets t
         JOIN order_items oi ON oi.id = t.order_item_id
         WHERE oi.order_id = $1`,
        [orderId]
      );

      const ticketCount = parseInt(ticketsResult.rows[0].ticket_count);
      const totalCommission = ticketCount * commissionRate;

      let networkManagerId = order.network_manager_id || null;
      if (!networkManagerId) {
        const nmResult = await client.query(
          "SELECT network_manager_user_id FROM guru_network_manager WHERE guru_user_id = $1",
          [order.guru_id]
        );
        networkManagerId = nmResult.rows[0]?.network_manager_user_id || null;
      }

      return {
        hasGuru: true,
        guruId: order.guru_id,
        promoterId: order.promoter_id,
        eventId: order.event_id,
        orderId: order.id,
        networkManagerId,
        ticketCount: ticketCount,
        commissionRate: commissionRate,
        totalCommission: totalCommission,
        level: level.level
      };
    } finally {
      client.release();
    }
  }

  /**
   * Process and record commission for an order
   * @param {number} orderId - Order ID
   * @returns {Promise<Object>} Commission record
   */
  static async processOrderCommission(orderId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Calculate commission
      const calculation = await this.calculateOrderCommission(orderId);

      if (!calculation.hasGuru) {
        await client.query('COMMIT');
        return {
          skipped: true,
          reason: calculation.reason
        };
      }

      // Check if commission already exists
      const existing = await client.query(
        'SELECT id FROM guru_commissions WHERE order_id = $1',
        [orderId]
      );

      if (existing.rowCount > 0) {
        await client.query('COMMIT');
        return {
          exists: true,
          commissionId: existing.rows[0].id
        };
      }

      // Record commission
      const result = await client.query(
        `INSERT INTO guru_commissions
          (guru_id, promoter_id, event_id, order_id, tickets_count, commission_rate, total_commission, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING *`,
        [
          calculation.guruId,
          calculation.promoterId,
          calculation.eventId,
          calculation.orderId,
          calculation.ticketCount,
          calculation.commissionRate,
          calculation.totalCommission
        ]
      );
      const commissionRow = result.rows[0];

      // Ledger: record allocations (guru_commission + network_manager_cash) for Phase 10
      await PlatformLedgerService.recordCommissionAllocations(
        {
          orderId: calculation.orderId,
          eventId: calculation.eventId,
          promoterId: calculation.promoterId,
          guruId: calculation.guruId,
          networkManagerId: calculation.networkManagerId || null,
          totalCommission: calculation.totalCommission,
          guruCommissionId: commissionRow.id,
        },
        client
      );

      await client.query('COMMIT');
      return commissionRow;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Process commission error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get commissions for a Guru
   * @param {number} guruId - Guru user ID
   * @param {Date} dateFrom - Start date
   * @param {Date} dateTo - End date
   * @param {string} status - Commission status filter
   * @returns {Promise<Array>} Commissions list
   */
  static async getCommissions(guruId, dateFrom, dateTo, status) {
    const params = [guruId];
    let whereClause = 'WHERE gc.guru_id = $1';

    if (status) {
      params.push(status);
      whereClause += ` AND gc.status = $${params.length}`;
    }

    if (dateFrom) {
      params.push(dateFrom);
      whereClause += ` AND gc.created_at >= $${params.length}`;
    }

    if (dateTo) {
      params.push(dateTo);
      whereClause += ` AND gc.created_at <= $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         gc.*,
         u.name as promoter_name,
         e.title as event_title,
         o.order_number
       FROM guru_commissions gc
       JOIN users u ON u.id = gc.promoter_id
       LEFT JOIN events e ON e.id = gc.event_id
       LEFT JOIN orders o ON o.id = gc.order_id
       ${whereClause}
       ORDER BY gc.created_at DESC`,
      params
    );

    return result.rows;
  }

  /**
   * Get commission breakdown for a promoter
   * @param {number} promoterId - Promoter user ID
   * @param {Date} dateFrom - Start date
   * @param {Date} dateTo - End date
   * @returns {Promise<Object>} Breakdown
   */
  static async getPromoterCommissionBreakdown(promoterId, dateFrom, dateTo) {
    const params = [promoterId];
    let whereClause = 'WHERE gc.promoter_id = $1';

    if (dateFrom) {
      params.push(dateFrom);
      whereClause += ` AND gc.created_at >= $${params.length}`;
    }

    if (dateTo) {
      params.push(dateTo);
      whereClause += ` AND gc.created_at <= $${params.length}`;
    }

    // Get totals
    const totalsResult = await pool.query(
      `SELECT
         COUNT(*) as commission_count,
         SUM(gc.tickets_count) as total_tickets,
         SUM(gc.total_commission) as total_commission
       FROM guru_commissions gc
       ${whereClause}`,
      params
    );

    // Get by status
    const statusResult = await pool.query(
      `SELECT
         gc.status,
         COUNT(*) as count,
         SUM(gc.total_commission) as total
       FROM guru_commissions gc
       ${whereClause}
       GROUP BY gc.status`,
      params
    );

    return {
      total: {
        count: parseInt(totalsResult.rows[0].commission_count || 0),
        tickets: parseInt(totalsResult.rows[0].total_tickets || 0),
        commission: parseInt(totalsResult.rows[0].total_commission || 0)
      },
      byStatus: statusResult.rows
    };
  }

  /**
   * Get total earnings for a Guru
   * @param {number} guruId - Guru user ID
   * @param {Date} dateFrom - Start date
   * @param {Date} dateTo - End date
   * @returns {Promise<Object>} Earnings summary
   */
  static async getTotalEarnings(guruId, dateFrom, dateTo) {
    const params = [guruId];
    let whereClause = 'WHERE gc.guru_id = $1';

    if (dateFrom) {
      params.push(dateFrom);
      whereClause += ` AND gc.created_at >= $${params.length}`;
    }

    if (dateTo) {
      params.push(dateTo);
      whereClause += ` AND gc.created_at <= $${params.length}`;
    }

    // Get paid commissions
    const paidResult = await pool.query(
      `SELECT
         COALESCE(SUM(gc.total_commission), 0) as paid,
         COUNT(*) as count
       FROM guru_commissions gc
       ${whereClause} AND gc.status = 'paid'`,
      params
    );

    // Get pending commissions
    const pendingResult = await pool.query(
      `SELECT
         COALESCE(SUM(gc.total_commission), 0) as pending,
         COUNT(*) as count
       FROM guru_commissions gc
       ${whereClause} AND gc.status = 'pending'`,
      params
    );

    return {
      paid: {
        amount: parseInt(paidResult.rows[0].paid),
        count: parseInt(paidResult.rows[0].count)
      },
      pending: {
        amount: parseInt(pendingResult.rows[0].pending),
        count: parseInt(pendingResult.rows[0].count)
      },
      total: parseInt(paidResult.rows[0].paid) + parseInt(pendingResult.rows[0].pending)
    };
  }

  /**
   * Mark commission as paid
   * @param {number} commissionId - Commission ID
   * @returns {Promise<Object>} Updated commission
   */
  static async markCommissionAsPaid(commissionId) {
    const result = await pool.query(
      `UPDATE guru_commissions
       SET status = 'paid', paid_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [commissionId]
    );

    return result.rows[0];
  }

  /**
   * Cancel a commission
   * @param {number} commissionId - Commission ID
   * @returns {Promise<Object>} Updated commission
   */
  static async cancelCommission(commissionId) {
    const result = await pool.query(
      `UPDATE guru_commissions
       SET status = 'cancelled'
       WHERE id = $1
       RETURNING *`,
      [commissionId]
    );

    return result.rows[0];
  }
}

module.exports = CommissionService;
