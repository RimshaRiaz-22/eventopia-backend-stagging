const pool = require("../db");

/**
 * Network scope service (Phase 10)
 * Strict scope: network manager sees only gurus linked to them and promoters under those gurus.
 */
class NetworkScopeService {
  /**
   * Get guru user IDs that belong to this network manager.
   * @param {number} networkManagerId
   * @returns {Promise<number[]>}
   */
  static async getGuruIdsForNetworkManager(networkManagerId) {
    const result = await pool.query(
      `SELECT guru_user_id FROM guru_network_manager WHERE network_manager_user_id = $1`,
      [networkManagerId]
    );
    return result.rows.map((r) => r.guru_user_id);
  }

  /**
   * Assert that a guru belongs to this network manager (for param validation).
   * @returns {Promise<boolean>} true if guru is in scope
   */
  static async isGuruInScope(networkManagerId, guruId) {
    const result = await pool.query(
      `SELECT 1 FROM guru_network_manager
       WHERE network_manager_user_id = $1 AND guru_user_id = $2`,
      [networkManagerId, guruId]
    );
    return result.rowCount > 0;
  }

  /**
   * Get promoter user IDs that belong to this network (under any of the NM's gurus).
   * @param {number} networkManagerId
   * @returns {Promise<number[]>}
   */
  static async getPromoterIdsForNetworkManager(networkManagerId) {
    const result = await pool.query(
      `SELECT DISTINCT pgl.promoter_user_id
       FROM promoter_guru_links pgl
       JOIN guru_network_manager gnm ON gnm.guru_user_id = pgl.guru_user_id
       WHERE gnm.network_manager_user_id = $1`,
      [networkManagerId]
    );
    return result.rows.map((r) => r.promoter_user_id);
  }

  /**
   * Get counts for dashboard summary: gurus_count, promoters_count, tickets_sold_total, active_gurus_count.
   * active_gurus_count = gurus in scope where users.guru_active is true.
   * @param {number} networkManagerId
   * @returns {Promise<{ gurus_count: number, promoters_count: number, tickets_sold_total: number, active_gurus_count: number }>}
   */
  static async getSummaryCounts(networkManagerId) {
    const gurusResult = await pool.query(
      `SELECT COUNT(*)::int AS c FROM guru_network_manager WHERE network_manager_user_id = $1`,
      [networkManagerId]
    );
    const promotersResult = await pool.query(
      `SELECT COUNT(DISTINCT pgl.promoter_user_id)::int AS c
       FROM promoter_guru_links pgl
       JOIN guru_network_manager gnm ON gnm.guru_user_id = pgl.guru_user_id
       WHERE gnm.network_manager_user_id = $1`,
      [networkManagerId]
    );
    const ticketsResult = await pool.query(
      `SELECT COALESCE(SUM(tickets_sold), 0)::bigint AS total
       FROM events
       WHERE network_manager_id = $1`,
      [networkManagerId]
    );
    const activeGurusResult = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM guru_network_manager gnm
       JOIN users u ON u.id = gnm.guru_user_id
       WHERE gnm.network_manager_user_id = $1 AND COALESCE(u.guru_active, FALSE) = TRUE`,
      [networkManagerId]
    );
    return {
      gurus_count: gurusResult.rows[0]?.c || 0,
      promoters_count: promotersResult.rows[0]?.c || 0,
      tickets_sold_total: parseInt(ticketsResult.rows[0]?.total, 10) || 0,
      active_gurus_count: activeGurusResult.rows[0]?.c || 0,
    };
  }
}

module.exports = NetworkScopeService;
