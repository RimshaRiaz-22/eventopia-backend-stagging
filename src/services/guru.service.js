const pool = require("../db");
const settledTicket = require("./settledTicket.service");

function parseIsoDateOnly(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime())) return null;
  if (!d.toISOString().startsWith(s)) return null;
  return d;
}

function manualWindowForGranularity(granularity, params = {}) {
  const hasManual =
    params.date != null ||
    params.weekStart != null ||
    params.weekEnd != null ||
    params.year != null ||
    params.month != null;
  if (!hasManual) return null;

  const g = String(granularity || "").toLowerCase();
  if (g === "daily") {
    const date = parseIsoDateOnly(params.date);
    if (!date) {
      const err = new Error("INVALID_DATE_PARAMS");
      err.code = "INVALID_DATE_PARAMS";
      throw err;
    }
    const start = new Date(date);
    const end = new Date(date);
    end.setUTCHours(23, 59, 59, 999);
    return { start, end, label: "custom_day" };
  }

  if (g === "weekly") {
    const ws = parseIsoDateOnly(params.weekStart);
    if (!ws) {
      const err = new Error("INVALID_DATE_PARAMS");
      err.code = "INVALID_DATE_PARAMS";
      throw err;
    }
    const we = params.weekEnd != null ? parseIsoDateOnly(params.weekEnd) : null;
    const start = new Date(ws);
    const end = we ? new Date(we) : new Date(ws);
    if (!we) end.setUTCDate(end.getUTCDate() + 6);
    end.setUTCHours(23, 59, 59, 999);
    if (end < start) {
      const err = new Error("INVALID_DATE_PARAMS");
      err.code = "INVALID_DATE_PARAMS";
      throw err;
    }
    return { start, end, label: "custom_week" };
  }

  if (g === "monthly") {
    const y = Number(params.year);
    const m = Number(params.month);
    if (!Number.isInteger(y) || y < 1970 || y > 3000 || !Number.isInteger(m) || m < 1 || m > 12) {
      const err = new Error("INVALID_DATE_PARAMS");
      err.code = "INVALID_DATE_PARAMS";
      throw err;
    }
    const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
    return { start, end, label: "custom_month" };
  }

  return null;
}

/**
 * Guru Service
 * Handles Guru activation, levels, and dashboard data
 */
class GuruService {
  /**
   * Check if Guru account is active
   * @param {number} guruId - Guru user ID
   * @returns {Promise<boolean>} Is active
   */
  static async isGuruActive(guruId) {
    const result = await pool.query(
      'SELECT guru_active, guru_active_until FROM users WHERE id = $1',
      [guruId]
    );

    if (result.rowCount === 0) {
      return false;
    }

    const { guru_active, guru_active_until } = result.rows[0];

    if (!guru_active) {
      return false;
    }

    // Check if activation hasn't expired
    if (guru_active_until && new Date() > new Date(guru_active_until)) {
      return false;
    }

    return true;
  }

  /**
   * Get Guru's current level
   * @param {number} guruId - Guru user ID
   * @returns {Promise<Object>} Level info
   */
  static async getCurrentLevel(guruId) {
    const result = await pool.query(
      `SELECT gl.*, gcr.rate_per_ticket
       FROM guru_levels gl
       LEFT JOIN guru_commission_rates gcr ON gcr.level = gl.level
       WHERE gl.guru_id = $1 AND gl.effective_until IS NULL
       ORDER BY gl.effective_from DESC
       LIMIT 1`,
      [guruId]
    );

    if (result.rowCount === 0) {
      // Create default level 1 if none exists
      return this.setGuruLevel(guruId, 1, null, 'Default level');
    }

    return result.rows[0];
  }

  /**
   * Set Guru level (creates new level record)
   * @param {number} guruId - Guru user ID
   * @param {number} level - Level (1-3)
   * @param {number|null} adminId - Admin who set the level
   * @param {string} reason - Reason for level change
   * @returns {Promise<Object>} New level record
   */
  static async setGuruLevel(guruId, level, adminId, reason) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Close current level
      await client.query(
        `UPDATE guru_levels
         SET effective_until = NOW()
         WHERE guru_id = $1 AND effective_until IS NULL`,
        [guruId]
      );

      // Get rate and service_fee_rate for level
      const rateResult = await client.query(
        'SELECT rate_per_ticket, service_fee_rate FROM guru_commission_rates WHERE level = $1',
        [level]
      );

      if (rateResult.rowCount === 0) {
        throw new Error(`Invalid level: ${level}`);
      }

      const { rate_per_ticket: ratePerTicket, service_fee_rate: serviceFeeRate } = rateResult.rows[0];
      const effectiveServiceFeeRate = serviceFeeRate != null ? serviceFeeRate : 0.2;

      // Create new level record
      const result = await client.query(
        `INSERT INTO guru_levels
          (guru_id, level, rate_per_ticket, service_fee_rate, created_by, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [guruId, level, ratePerTicket, effectiveServiceFeeRate, adminId, reason]
      );

      // Log admin action
      if (adminId) {
        await client.query(
          `INSERT INTO admin_guru_actions
            (admin_id, guru_id, action_type, old_value, new_value, reason)
           VALUES ($1, $2, 'level_change', NULL, $3, $4)`,
          [adminId, guruId, `Level ${level}`, reason]
        );
      }

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Set Guru level error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get Guru's level history
   * @param {number} guruId - Guru user ID
   * @returns {Promise<Array>} Level history
   */
  static async getLevelHistory(guruId) {
    const result = await pool.query(
      `SELECT gl.*, u.name as admin_name
       FROM guru_levels gl
       LEFT JOIN users u ON u.id = gl.created_by
       WHERE gl.guru_id = $1
       ORDER BY gl.effective_from DESC`,
      [guruId]
    );

    return result.rows;
  }

  /**
   * Get dashboard summary for Guru
   * @param {number} guruId - Guru user ID
   * @param {Date} dateFrom - Start date
   * @param {Date} dateTo - End date
   * @returns {Promise<Object>} Dashboard summary
   */
  static async getDashboardSummary(guruId, dateFrom, dateTo) {
    const params = [guruId];
    let whereClause = 'WHERE pgl.guru_user_id = $1';

    if (dateFrom) {
      params.push(dateFrom);
      whereClause += ` AND e.created_at >= $${params.length}`;
    }

    if (dateTo) {
      params.push(dateTo);
      whereClause += ` AND e.created_at <= $${params.length}`;
    }

    // Get promoters count
    const promotersResult = await pool.query(
      `SELECT COUNT(DISTINCT pgl.promoter_user_id) as count
       FROM promoter_guru_links pgl
       WHERE pgl.guru_user_id = $1`,
      [guruId]
    );

    // Get tickets sold through attached promoters
    const ticketsResult = await pool.query(
      `SELECT COUNT(DISTINCT t.id) as tickets_sold
       FROM promoter_guru_links pgl
       LEFT JOIN events e ON e.promoter_id = pgl.promoter_user_id
       LEFT JOIN tickets t ON t.event_id = e.id AND t.status = 'sold'
       ${whereClause}`,
      params
    );

    // Get total sales
    const salesResult = await pool.query(
      `SELECT COALESCE(SUM(o.total_amount), 0) as gross_sales
       FROM promoter_guru_links pgl
       LEFT JOIN events e ON e.promoter_id = pgl.promoter_user_id
       LEFT JOIN orders o ON o.event_id = e.id AND o.status = 'confirmed'
       ${whereClause}`,
      params
    );

    // Get commissions earned
    const commissionsResult = await pool.query(
      `SELECT COALESCE(SUM(total_commission), 0) as total_commissions
       FROM guru_commissions
       WHERE guru_id = $1 AND status = 'paid'`,
      [guruId]
    );

    // Get pending commissions
    const pendingResult = await pool.query(
      `SELECT COALESCE(SUM(total_commission), 0) as pending_commissions
       FROM guru_commissions
       WHERE guru_id = $1 AND status = 'pending'`,
      [guruId]
    );

    return {
      promotersCount: parseInt(promotersResult.rows[0].count),
      ticketsSoldTotal: parseInt(ticketsResult.rows[0].tickets_sold),
      grossSales: parseInt(salesResult.rows[0].gross_sales),
      commissionsEarned: parseInt(commissionsResult.rows[0].total_commissions),
      pendingCommissions: parseInt(pendingResult.rows[0].pending_commissions)
    };
  }

  /**
   * All-time network stats for Guru "Invite Promoters" (promoters linked, tickets sold on those events, guru credit from ledger).
   * Scoped to events where event.guru_id matches this guru and the promoter is in promoter_guru_links for this guru.
   * @param {number} guruId
   * @returns {Promise<{ promotersJoined: number, ticketsSold: number, earnedPence: number }>}
   */
  static async getInvitePromotersNetworkStats(guruId) {
    const promotersResult = await pool.query(
      `SELECT COUNT(DISTINCT pgl.promoter_user_id)::int AS count
       FROM promoter_guru_links pgl
       WHERE pgl.guru_user_id = $1`,
      [guruId]
    );

    const ticketsResult = await pool.query(
      `SELECT COUNT(DISTINCT t.id)::int AS tickets_sold
       FROM promoter_guru_links pgl
       JOIN events e ON e.promoter_id = pgl.promoter_user_id AND e.guru_id = pgl.guru_user_id
       JOIN tickets t ON t.event_id = e.id AND t.status = 'sold'
       WHERE pgl.guru_user_id = $1`,
      [guruId]
    );

    const earnedResult = await pool.query(
      `SELECT COALESCE(SUM(cl.amount), 0)::bigint AS earned_pence
       FROM credit_ledger cl
       JOIN events e ON e.id = cl.event_id
       WHERE cl.user_id = $1
         AND cl.role = 'guru'
         AND cl.entry_type = 'CREDIT_ALLOCATION'
         AND e.guru_id = $1
         AND EXISTS (
           SELECT 1 FROM promoter_guru_links pgl
           WHERE pgl.promoter_user_id = e.promoter_id AND pgl.guru_user_id = $1
         )`,
      [guruId]
    );

    return {
      promotersJoined: parseInt(promotersResult.rows[0].count, 10) || 0,
      ticketsSold: parseInt(ticketsResult.rows[0].tickets_sold, 10) || 0,
      earnedPence: Number(earnedResult.rows[0].earned_pence) || 0,
    };
  }

  /**
   * Get list of attached promoters (rich payload for guru dashboard / Figma promoter cards).
   * Metrics scoped to events where both promoter_id and guru_id match this guru–promoter pair.
   * @param {number} guruId - Guru user ID
   * @param {Date} dateFrom - Filter on link attached_at
   * @param {Date} dateTo - Filter on link attached_at
   * @param {{ onlyGuruPublicReferralSignups?: boolean, searchByName?: string, page?: number, limit?: number, includePagination?: boolean }} [options]
   * @returns {Promise<Array|{rows:Array,total:number}>} Promoters list or paginated result
   */
  static async getAttachedPromoters(guruId, dateFrom, dateTo, options = {}) {
    const {
      onlyGuruPublicReferralSignups = false,
      searchByName = "",
      page = 1,
      limit = 20,
      includePagination = false,
    } = options;
    const SETTLED = settledTicket.SETTLED_TICKET_CONDITIONS.replace(/\s+/g, " ").trim();
    const now = new Date();
    const q = Math.floor(now.getUTCMonth() / 3);
    const quarterStartUtc = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1, 0, 0, 0, 0));

    const params = [guruId];
    let linkDateClause = "";

    if (dateFrom) {
      params.push(dateFrom);
      linkDateClause += ` AND pgl.created_at >= $${params.length}`;
    }
    if (dateTo) {
      params.push(dateTo);
      linkDateClause += ` AND pgl.created_at <= $${params.length}`;
    }

    params.push(quarterStartUtc.toISOString());
    const idxQuarterStart = params.length;
    params.push(now.toISOString());
    const idxQuarterEnd = params.length;

    const guruReferralSignupClause = onlyGuruPublicReferralSignups
      ? ` AND (
          EXISTS (
            SELECT 1 FROM user_attributions ua
            INNER JOIN guru_referrals gr ON gr.guru_id = $1
              AND gr.referral_code = ua.referral_code
              AND gr.revoked_at IS NULL
            WHERE ua.user_id = u.id AND ua.guru_id = $1
          )
          OR EXISTS (
            SELECT 1 FROM referral_events re
            WHERE re.guru_id = $1
              AND re.event_type = 'signup'
              AND re.user_id = pgl.promoter_user_id
          )
        )`
      : "";
    const trimmedSearch = String(searchByName || "").trim();
    const shouldSearchByName = trimmedSearch.length > 0;
    let searchByNameClause = "";
    if (shouldSearchByName) {
      params.push(`%${trimmedSearch}%`);
      searchByNameClause = ` AND u.name ILIKE $${params.length}`;
    }

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (safePage - 1) * safeLimit;

    const baseFromWhere = `
       FROM promoter_guru_links pgl
       JOIN users u ON u.id = pgl.promoter_user_id
      WHERE pgl.guru_user_id = $1
            ${linkDateClause}
            ${guruReferralSignupClause}
            ${searchByNameClause}
    `;

    const selectSql = `SELECT
         pgl.promoter_user_id AS id,
         u.user_no,
         u.name,
         u.email,
         u.avatar_url,
         u.account_status,
         pgl.source AS link_source,
         pgl.created_at AS attached_at,
         (SELECT COALESCE(ua.signed_up_via_referral, FALSE)
            FROM user_attributions ua
           WHERE ua.user_id = u.id
           ORDER BY ua.created_at DESC NULLS LAST
           LIMIT 1) AS signed_up_via_referral,
         (SELECT COUNT(DISTINCT t.id)::bigint
            FROM tickets t
            JOIN events e ON e.id = t.event_id
           WHERE e.promoter_id = pgl.promoter_user_id
             AND e.guru_id = $1
             AND t.status = 'sold') AS tickets_sold,
         (SELECT COALESCE(SUM(o.total_amount), 0)::bigint
            FROM orders o
            JOIN events e ON e.id = o.event_id
           WHERE e.promoter_id = pgl.promoter_user_id
             AND e.guru_id = $1
             AND o.status = 'confirmed') AS gross_sales_pence,
         (SELECT COUNT(*)::bigint
            FROM tickets t
            JOIN events e ON e.id = t.event_id
           WHERE e.promoter_id = pgl.promoter_user_id
             AND e.guru_id = $1
             AND ${SETTLED}
             AND t.created_at >= $${idxQuarterStart}::timestamptz
             AND t.created_at <= $${idxQuarterEnd}::timestamptz) AS sprint_settled_tickets_quarter,
         (SELECT COUNT(*)::bigint
            FROM tickets t
            JOIN events e ON e.id = t.event_id
           WHERE e.promoter_id = pgl.promoter_user_id
             AND e.guru_id = $1
             AND (t.status IN ('REFUNDED', 'CANCELLED', 'VOID') OR t.refunded_at IS NOT NULL)
             AND COALESCE(t.refunded_at, t.updated_at, t.created_at) >= $${idxQuarterStart}::timestamptz
             AND COALESCE(t.refunded_at, t.updated_at, t.created_at) <= $${idxQuarterEnd}::timestamptz) AS refunds_count_quarter,
         (SELECT COALESCE(SUM(gc.total_commission), 0)::bigint
            FROM guru_commissions gc
           WHERE gc.guru_id = $1 AND gc.promoter_id = pgl.promoter_user_id) AS commission_total_pence,
         (SELECT COALESCE(SUM(cl.amount), 0)::bigint
            FROM credit_ledger cl
            JOIN events e ON e.id = cl.event_id
           WHERE cl.user_id = $1
             AND cl.role = 'guru'
             AND cl.entry_type = 'CREDIT_ALLOCATION'
             AND e.promoter_id = pgl.promoter_user_id
             AND e.guru_id = $1
             AND COALESCE(cl.metadata_json->>'status', 'PROJECTED') = 'PROJECTED') AS guru_credit_projected_pence,
         (SELECT COALESCE(SUM(cl.amount), 0)::bigint
            FROM credit_ledger cl
            JOIN events e ON e.id = cl.event_id
           WHERE cl.user_id = $1
             AND cl.role = 'guru'
             AND cl.entry_type = 'CREDIT_ALLOCATION'
             AND e.promoter_id = pgl.promoter_user_id
             AND e.guru_id = $1
             AND COALESCE(cl.metadata_json->>'status', 'PROJECTED') = 'CONFIRMED') AS guru_credit_confirmed_pence,
         (SELECT COUNT(DISTINCT e.id)::bigint
            FROM events e
           WHERE e.promoter_id = pgl.promoter_user_id AND e.guru_id = $1) AS events_count
      ${baseFromWhere}
      ORDER BY pgl.created_at DESC`;

    const queryParams = [...params];
    let paginationSql = "";
    if (includePagination) {
      queryParams.push(safeLimit);
      const idxLimit = queryParams.length;
      queryParams.push(offset);
      const idxOffset = queryParams.length;
      paginationSql = ` LIMIT $${idxLimit} OFFSET $${idxOffset}`;
    }

    const result = await pool.query(`${selectSql}${paginationSql}`, queryParams);

    if (!includePagination) {
      return result.rows;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM (${selectSql}) AS referral_signup_promoters`,
      params
    );

    return {
      rows: result.rows,
      total: parseInt(countResult.rows[0]?.total || 0, 10),
    };
  }

  /**
   * Get pending invite-only promoters created by Guru invite flow.
   * These records are not registered users yet, so they do not exist in promoter_guru_links.
   * @param {number} guruId - Guru user ID
   * @param {Date} dateFrom - Filter on invite created_at
   * @param {Date} dateTo - Filter on invite created_at
   * @returns {Promise<Array>} Pending invite list
   */
  static async getPendingPromoterInvites(guruId, dateFrom, dateTo) {
    const params = [guruId];
    let whereClause = `WHERE pri.guru_user_id = $1
      AND pri.used_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM users u
        JOIN promoter_guru_links pgl ON pgl.promoter_user_id = u.id
        WHERE u.email = pri.email
          AND pgl.guru_user_id = pri.guru_user_id
      )`;

    if (dateFrom) {
      params.push(dateFrom);
      whereClause += ` AND pri.created_at >= $${params.length}`;
    }
    if (dateTo) {
      params.push(dateTo);
      whereClause += ` AND pri.created_at <= $${params.length}`;
    }

    const result = await pool.query(
      `SELECT DISTINCT ON (LOWER(pri.email))
         pri.id,
         pri.name,
         pri.email,
         pri.created_at,
         pri.expires_at
       FROM promoter_referral_invites pri
       ${whereClause}
       ORDER BY LOWER(pri.email), pri.created_at DESC`,
      params
    );

    return result.rows;
  }

  /**
   * Get performance data for a specific promoter
   * @param {number} guruId - Guru user ID
   * @param {number} promoterId - Promoter user ID
   * @param {Date} dateFrom - Start date
   * @param {Date} dateTo - End date
   * @returns {Promise<Object>} Performance data
   */
  static async getPromoterPerformance(guruId, promoterId, dateFrom, dateTo) {
    // Verify attachment
    const linkResult = await pool.query(
      'SELECT * FROM promoter_guru_links WHERE promoter_user_id = $1 AND guru_user_id = $2',
      [promoterId, guruId]
    );

    if (linkResult.rowCount === 0) {
      throw new Error('Promoter is not attached to this Guru');
    }

    const params = [promoterId, guruId];
    let whereClause = 'WHERE e.promoter_id = $1 AND e.guru_id = $2';

    if (dateFrom) {
      params.push(dateFrom);
      whereClause += ` AND e.created_at >= $${params.length}`;
    }

    if (dateTo) {
      params.push(dateTo);
      whereClause += ` AND e.created_at <= $${params.length}`;
    }

    // Get promoter info
    const promoterResult = await pool.query(
      'SELECT id, name, email FROM users WHERE id = $1',
      [promoterId]
    );

    // Get events
    const eventsResult = await pool.query(
      `SELECT
         e.id,
         e.title,
         e.start_at,
         e.status,
         COUNT(DISTINCT t.id) as tickets_sold,
         COALESCE(SUM(o.total_amount), 0) as gross_sales
       FROM events e
       LEFT JOIN orders o ON o.event_id = e.id AND o.status = 'confirmed'
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN tickets t ON t.order_item_id = oi.id AND t.status = 'sold'
       ${whereClause}
       GROUP BY e.id, e.title, e.start_at, e.status
       ORDER BY e.start_at DESC`,
      params
    );

    return {
      promoter: promoterResult.rows[0],
      events: eventsResult.rows
    };
  }

  /**
   * Manually attach a promoter to a Guru (admin-controlled)
   * @param {number} guruId - Guru user ID
   * @param {number} promoterId - Promoter user ID
   * @param {number} adminId - Admin performing the action
   * @returns {Promise<Object>} Link record
   */
  static async manuallyAttachPromoter(guruId, promoterId, adminId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if link already exists
      const existing = await client.query(
        'SELECT * FROM promoter_guru_links WHERE promoter_user_id = $1',
        [promoterId]
      );

      if (existing.rowCount > 0) {
        // Update existing link
        const result = await client.query(
          `UPDATE promoter_guru_links
           SET guru_user_id = $1, source = 'admin', changed_at = NOW(), changed_by_admin_id = $2
           WHERE promoter_user_id = $3
           RETURNING *`,
          [guruId, adminId, promoterId]
        );

        // Log admin action
        await client.query(
          `INSERT INTO admin_guru_actions
            (admin_id, guru_id, action_type, old_value, new_value, reason)
           VALUES ($1, $2, 'promoter_attachment', $3, $4, 'Manual attachment')`,
          [adminId, guruId, `Attached to Guru ${existing.rows[0].guru_user_id}`, `Attached to Guru ${guruId}`]
        );

        await client.query('COMMIT');
        return result.rows[0];
      } else {
        // Create new link
        const result = await client.query(
          `INSERT INTO promoter_guru_links
            (promoter_user_id, guru_user_id, source, changed_by_admin_id)
           VALUES ($1, $2, 'admin', $3)
           RETURNING *`,
          [promoterId, guruId, adminId]
        );

        // Log admin action
        await client.query(
          `INSERT INTO admin_guru_actions
            (admin_id, guru_id, action_type, new_value, reason)
           VALUES ($1, $2, 'promoter_attachment', $3, 'Manual attachment')`,
          [adminId, guruId, `Attached promoter ${promoterId}`]
        );

        await client.query('COMMIT');
        return result.rows[0];
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Attach promoter error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Detach a promoter from a Guru
   * @param {number} guruId - Guru user ID
   * @param {number} promoterId - Promoter user ID
   * @param {number} adminId - Admin performing the action
   * @returns {Promise<void>}
   */
  static async detachPromoter(guruId, promoterId, adminId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify link exists
      const linkResult = await client.query(
        'SELECT * FROM promoter_guru_links WHERE promoter_user_id = $1 AND guru_user_id = $2',
        [promoterId, guruId]
      );

      if (linkResult.rowCount === 0) {
        throw new Error('Promoter is not attached to this Guru');
      }

      // Delete link
      await client.query(
        'DELETE FROM promoter_guru_links WHERE promoter_user_id = $1',
        [promoterId]
      );

      // Log admin action
      await client.query(
        `INSERT INTO admin_guru_actions
          (admin_id, guru_id, action_type, old_value, reason)
         VALUES ($1, $2, 'promoter_detachment', $3, 'Manual detachment')`,
        [adminId, guruId, `Detached promoter ${promoterId}`]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Detach promoter error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Guru sprint contribution goal (tickets) for UI — aligns with L2 quarterly sprint window.
   */
  static get defaultPromoterSprintGoalTickets() {
    return 5000;
  }

  /**
   * Profile + summary cards for guru promoter detail screen (scoped to this guru–promoter pair).
   */
  static async getPromoterDetailsForGuru(guruId, promoterId) {
    const linkR = await pool.query(
      `SELECT source, created_at FROM promoter_guru_links WHERE promoter_user_id = $1 AND guru_user_id = $2`,
      [promoterId, guruId]
    );
    if (linkR.rowCount === 0) {
      throw new Error("Promoter is not attached to this Guru");
    }
    const link = linkR.rows[0];

    const now = new Date();
    const qIdx = Math.floor(now.getUTCMonth() / 3);
    const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), qIdx * 3, 1, 0, 0, 0, 0));
    const prevQuarterStart = new Date(Date.UTC(now.getUTCFullYear(), qIdx * 3 - 3, 1, 0, 0, 0, 0));
    const prevQuarterEnd = new Date(quarterStart.getTime() - 1);
    const d30 = new Date(now);
    d30.setUTCDate(d30.getUTCDate() - 30);
    const d60 = new Date(now);
    d60.setUTCDate(d60.getUTCDate() - 60);

    const SETTLED = settledTicket.SETTLED_TICKET_CONDITIONS.replace(/\s+/g, " ").trim();

    const [
      profileR,
      walletR,
      ticketsTotalR,
      ticketsLast30R,
      ticketsPrev30R,
      settledQuarterR,
      refundsQuarterR,
      settledPrevQR,
      refundsPrevQR,
    ] = await Promise.all([
      pool.query(
        `SELECT u.id, u.user_no, u.name, u.email, u.avatar_url, u.account_status, u.role, u.city,
                gnm.territory_name AS guru_territory_name
           FROM users u
           LEFT JOIN LATERAL (
             SELECT territory_name FROM guru_network_manager WHERE guru_user_id = $2 LIMIT 1
           ) gnm ON TRUE
          WHERE u.id = $1`,
        [promoterId, guruId]
      ),
      pool.query(
        `SELECT projected_balance, available_balance, held_balance
           FROM credit_wallets
          WHERE user_id = $1 AND role = 'promoter'
          LIMIT 1`,
        [promoterId]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT t.id)::int AS c
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2 AND t.status = 'sold'`,
        [promoterId, guruId]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT t.id)::int AS c
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2 AND t.status = 'sold'
            AND t.created_at >= $3 AND t.created_at <= $4`,
        [promoterId, guruId, d30.toISOString(), now.toISOString()]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT t.id)::int AS c
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2 AND t.status = 'sold'
            AND t.created_at >= $3 AND t.created_at < $4`,
        [promoterId, guruId, d60.toISOString(), d30.toISOString()]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2
            AND ${SETTLED}
            AND t.created_at >= $3 AND t.created_at <= $4`,
        [promoterId, guruId, quarterStart.toISOString(), now.toISOString()]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2
            AND (t.status IN ('REFUNDED', 'CANCELLED', 'VOID') OR t.refunded_at IS NOT NULL)
            AND COALESCE(t.refunded_at, t.updated_at, t.created_at) >= $3
            AND COALESCE(t.refunded_at, t.updated_at, t.created_at) <= $4`,
        [promoterId, guruId, quarterStart.toISOString(), now.toISOString()]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2
            AND ${SETTLED}
            AND t.created_at >= $3 AND t.created_at <= $4`,
        [promoterId, guruId, prevQuarterStart.toISOString(), prevQuarterEnd.toISOString()]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2
            AND (t.status IN ('REFUNDED', 'CANCELLED', 'VOID') OR t.refunded_at IS NOT NULL)
            AND COALESCE(t.refunded_at, t.updated_at, t.created_at) >= $3
            AND COALESCE(t.refunded_at, t.updated_at, t.created_at) <= $4`,
        [promoterId, guruId, prevQuarterStart.toISOString(), prevQuarterEnd.toISOString()]
      ),
    ]);

    const ticketsTotal = ticketsTotalR.rows[0]?.c || 0;
    const t30 = ticketsLast30R.rows[0]?.c || 0;
    const tPrev = ticketsPrev30R.rows[0]?.c || 0;
    let ticketsTrendPercent = null;
    if (tPrev > 0) {
      ticketsTrendPercent = Number((((t30 - tPrev) / tPrev) * 100).toFixed(1));
    } else if (t30 > 0) {
      ticketsTrendPercent = 100;
    }

    const settledQ = settledQuarterR.rows[0]?.c || 0;
    const refQ = refundsQuarterR.rows[0]?.c || 0;
    const denomQ = settledQ + refQ;
    const refundRateQuarter = denomQ > 0 ? Number(((100 * refQ) / denomQ).toFixed(2)) : 0;

    const settledPQ = settledPrevQR.rows[0]?.c || 0;
    const refPQ = refundsPrevQR.rows[0]?.c || 0;
    const denomPQ = settledPQ + refPQ;
    const refundRatePrevQuarter = denomPQ > 0 ? Number(((100 * refPQ) / denomPQ).toFixed(2)) : 0;
    let refundTrendLabel = "stable";
    if (refundRateQuarter > refundRatePrevQuarter + 0.5) refundTrendLabel = "up";
    else if (refundRateQuarter < refundRatePrevQuarter - 0.5) refundTrendLabel = "down";

    const w = walletR.rows[0];
    const projected = Number(w?.projected_balance) || 0;
    const available = Number(w?.available_balance) || 0;
    const held = Number(w?.held_balance) || 0;
    const totalCreditPence = projected + available + held;
    const creditUtilizationPercent =
      totalCreditPence > 0 ? Number(((100 * (available + held)) / totalCreditPence).toFixed(1)) : 0;

    const sprintGoal = GuruService.defaultPromoterSprintGoalTickets;

    return {
      link: { source: link.source, attachedAt: link.created_at },
      profile: profileR.rows[0],
      summary: {
        ticketsSold: {
          total: ticketsTotal,
          trendPercentVsPrior30Days: ticketsTrendPercent,
        },
        creditBalance: {
          currency: "GBP",
          projectedGbp: Number((projected / 100).toFixed(2)),
          availableGbp: Number((available / 100).toFixed(2)),
          heldGbp: Number((held / 100).toFixed(2)),
          utilizationPercent: creditUtilizationPercent,
          limitAlertRecommended: creditUtilizationPercent >= 80,
        },
        refundRate: {
          percentThisUtcQuarter: refundRateQuarter,
          trendVsPriorUtcQuarter: refundTrendLabel,
          settledTicketsThisUtcQuarter: settledQ,
          refundsThisUtcQuarter: refQ,
        },
        currentSprint: {
          settledTicketsThisUtcQuarter: settledQ,
          goalTickets: sprintGoal,
          targetReachedPercent:
            sprintGoal > 0 ? Math.min(100, Number(((100 * settledQ) / sprintGoal).toFixed(1))) : null,
        },
      },
      meta: {
        quarterWindowUtc: { startsAt: quarterStart.toISOString(), endsAt: now.toISOString() },
      },
    };
  }

  /**
   * Time-series for Charts tab (tickets sold + promoter credit generated), scoped to guru–promoter events.
   */
  static async getPromoterChartsForGuru(guruId, promoterId, granularity, dateParams = {}) {
    const g = String(granularity || "daily").toLowerCase();
    if (!["daily", "weekly", "monthly"].includes(g)) {
      const err = new Error("INVALID_GRANULARITY");
      err.code = "INVALID_GRANULARITY";
      throw err;
    }

    const now = new Date();
    const manual = manualWindowForGranularity(g, dateParams);
    const start = manual ? manual.start : new Date(now);
    const end = manual ? manual.end : now;
    if (!manual) {
      if (g === "daily") start.setUTCDate(start.getUTCDate() - 29);
      if (g === "weekly") start.setUTCDate(start.getUTCDate() - 7 * 11);
      if (g === "monthly") {
        start.setUTCMonth(start.getUTCMonth() - 11);
        start.setUTCDate(1);
        start.setUTCHours(0, 0, 0, 0);
      }
    }

    const trunc = g === "daily" ? "day" : g === "weekly" ? "week" : "month";

    const linkR = await pool.query(
      `SELECT 1 FROM promoter_guru_links WHERE promoter_user_id = $1 AND guru_user_id = $2`,
      [promoterId, guruId]
    );
    if (linkR.rowCount === 0) {
      throw new Error("Promoter is not attached to this Guru");
    }

    const [ticketsR, creditR, sprintTotalR] = await Promise.all([
      pool.query(
        `SELECT date_trunc('${trunc}', t.created_at) AS bucket,
                COUNT(DISTINCT t.id)::int AS tickets
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2
            AND t.status = 'sold'
            AND t.created_at >= $3 AND t.created_at <= $4
          GROUP BY 1
          ORDER BY 1`,
        [promoterId, guruId, start.toISOString(), end.toISOString()]
      ),
      pool.query(
        `SELECT date_trunc('${trunc}', cl.created_at) AS bucket,
                COALESCE(SUM(cl.amount), 0)::bigint AS credit_pence
           FROM credit_ledger cl
           JOIN events e ON e.id = cl.event_id
          WHERE cl.user_id = $1
            AND cl.role = 'promoter'
            AND e.promoter_id = $1
            AND e.guru_id = $2
            AND cl.entry_type = 'CREDIT_ALLOCATION'
            AND cl.created_at >= $3 AND cl.created_at <= $4
          GROUP BY 1
          ORDER BY 1`,
        [promoterId, guruId, start.toISOString(), end.toISOString()]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT t.id)::int AS c
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2
            AND t.status = 'sold'
            AND t.created_at >= $3 AND t.created_at <= $4`,
        [promoterId, guruId, start.toISOString(), end.toISOString()]
      ),
    ]);

    const ticketsInRange = sprintTotalR.rows[0]?.c || 0;
    const goal = GuruService.defaultPromoterSprintGoalTickets;
    const targetReachedPercent =
      goal > 0 ? Math.min(100, Number(((100 * ticketsInRange) / goal).toFixed(1))) : null;

    const ticketsSoldPerformance = ticketsR.rows.map((row) => ({
      bucketStart: row.bucket ? new Date(row.bucket).toISOString() : null,
      tickets: row.tickets,
    }));

    let maxCreditGbp = 0;
    let sumCreditGbp = 0;
    const creditUtilization = creditR.rows.map((row) => {
      const gbp = Number((Number(row.credit_pence || 0) / 100).toFixed(2));
      if (gbp > maxCreditGbp) maxCreditGbp = gbp;
      sumCreditGbp += gbp;
      return {
        bucketStart: row.bucket ? new Date(row.bucket).toISOString() : null,
        creditGeneratedGbp: gbp,
      };
    });

    const limitAlertPercent = 80;
    const concentrationPercent =
      sumCreditGbp > 0 ? Math.min(100, Number(((100 * maxCreditGbp) / sumCreditGbp).toFixed(1))) : 0;

    return {
      granularity: g,
      rangeUtc: { startsAt: start.toISOString(), endsAt: end.toISOString() },
      ticketsSoldPerformance: {
        series: ticketsSoldPerformance,
        ticketsSoldInRange: ticketsInRange,
        sprintGoalTickets: goal,
        targetReachedPercent,
      },
      creditUtilization: {
        series: creditUtilization,
        creditGeneratedByPromoterNote:
          "Sum of promoter-role CREDIT_ALLOCATION ledger rows for events under this guru–promoter pair.",
        maxCreditGeneratedGbpInBucket: maxCreditGbp,
        totalCreditGeneratedGbpInRange: Number(sumCreditGbp.toFixed(2)),
        peakBucketShareOfTotalPercent: concentrationPercent,
        limitAlertPercent,
        limitAlertRecommended: concentrationPercent >= limitAlertPercent && maxCreditGbp > 0,
      },
    };
  }

  /**
   * Stats tab — only metrics backed by orders/events; referral cohort & bonus left as placeholders.
   */
  static async getPromoterStatsForGuru(guruId, promoterId, period, dateParams = {}) {
    const p = String(period || "daily").toLowerCase();
    if (!["daily", "weekly", "monthly"].includes(p)) {
      const err = new Error("INVALID_PERIOD");
      err.code = "INVALID_PERIOD";
      throw err;
    }

    const now = new Date();
    const manual = manualWindowForGranularity(p, dateParams);
    const windowStart = manual ? new Date(manual.start) : new Date(now);
    const windowEnd = manual ? new Date(manual.end) : new Date(now);
    let windowLabel = manual ? manual.label : "";
    if (!manual) {
      if (p === "daily") {
        windowStart.setUTCDate(windowStart.getUTCDate() - 30);
        windowLabel = "last_30_days";
      } else if (p === "weekly") {
        windowStart.setUTCDate(windowStart.getUTCDate() - 7 * 12);
        windowLabel = "last_12_weeks";
      } else {
        windowStart.setUTCMonth(windowStart.getUTCMonth() - 12);
        windowLabel = "last_12_months";
      }
    }

    const linkR = await pool.query(
      `SELECT 1 FROM promoter_guru_links WHERE promoter_user_id = $1 AND guru_user_id = $2`,
      [promoterId, guruId]
    );
    if (linkR.rowCount === 0) {
      throw new Error("Promoter is not attached to this Guru");
    }

    const avgR = await pool.query(
      `SELECT
         CASE WHEN COUNT(DISTINCT t.id) > 0
           THEN SUM(o.total_amount)::float / COUNT(DISTINCT t.id)
           ELSE 0 END AS avg_amount_pence,
         COUNT(DISTINCT t.id)::int AS ticket_count
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       JOIN orders o ON o.event_id = e.id AND o.status = 'confirmed'
       JOIN order_items oi ON oi.order_id = o.id
       WHERE e.promoter_id = $1 AND e.guru_id = $2
         AND t.order_item_id = oi.id
         AND t.status = 'sold'
         AND t.created_at >= $3 AND t.created_at <= $4`,
      [promoterId, guruId, windowStart.toISOString(), windowEnd.toISOString()]
    );

    const bestR = await pool.query(
      `SELECT e.id, e.title,
              COALESCE(SUM(o.total_amount), 0)::bigint AS gross_pence
         FROM events e
         LEFT JOIN orders o ON o.event_id = e.id AND o.status = 'confirmed'
        WHERE e.promoter_id = $1 AND e.guru_id = $2
          AND e.created_at >= $3 AND e.created_at <= $4
        GROUP BY e.id, e.title
        ORDER BY gross_pence DESC NULLS LAST
        LIMIT 1`,
      [promoterId, guruId, windowStart.toISOString(), windowEnd.toISOString()]
    );

    const avgPence = Number(avgR.rows[0]?.avg_amount_pence) || 0;
    const best = bestR.rows[0];

    return {
      period: p,
      window: { label: windowLabel, startsAt: windowStart.toISOString(), endsAt: windowEnd.toISOString() },
      avgTicketPrice: {
        currency: "GBP",
        valueGbp: Number((avgPence / 100).toFixed(2)),
        ticketsSampled: avgR.rows[0]?.ticket_count || 0,
        subtext: "Average order total attributed per ticket sold (confirmed orders) in the selected window.",
        statusTag: null,
      },
      bestEvent: best
        ? {
            id: best.id,
            title: best.title,
            grossSalesGbp: Number((Number(best.gross_pence) / 100).toFixed(2)),
            subtext: "Highest gross confirmed sales in the selected window.",
            statusTag: "TOP_IN_WINDOW",
          }
        : null,
      retentionRate: {
        available: false,
        valuePercent: null,
        subtext: "Requires referral-cohort analytics (not stored yet).",
        statusTag: null,
      },
      referralBonus: {
        available: false,
        valueGbp: null,
        currency: "GBP",
        subtext: "Pending network-growth payouts (not tracked in DB yet).",
        statusTag: null,
      },
    };
  }

  /**
   * History tab — recent buckets with tickets, promoter credit, refunds.
   */
  static async getPromoterHistoryForGuru(guruId, promoterId, granularity, limit, dateParams = {}) {
    const g = String(granularity || "daily").toLowerCase();
    if (!["daily", "weekly", "monthly"].includes(g)) {
      const err = new Error("INVALID_GRANULARITY");
      err.code = "INVALID_GRANULARITY";
      throw err;
    }
    const lim = Math.min(90, Math.max(1, parseInt(String(limit || 14), 10) || 14));

    const linkR = await pool.query(
      `SELECT 1 FROM promoter_guru_links WHERE promoter_user_id = $1 AND guru_user_id = $2`,
      [promoterId, guruId]
    );
    if (linkR.rowCount === 0) {
      throw new Error("Promoter is not attached to this Guru");
    }

    const trunc = g === "daily" ? "day" : g === "weekly" ? "week" : "month";
    const now = new Date();
    const manual = manualWindowForGranularity(g, dateParams);
    const start = manual ? manual.start : new Date(now);
    const end = manual ? manual.end : now;
    if (!manual) {
      if (g === "daily") start.setUTCDate(start.getUTCDate() - (lim - 1));
      if (g === "weekly") start.setUTCDate(start.getUTCDate() - 7 * (lim - 1));
      if (g === "monthly") {
        start.setUTCMonth(start.getUTCMonth() - (lim - 1));
        start.setUTCDate(1);
        start.setUTCHours(0, 0, 0, 0);
      }
    }

    const histR = await pool.query(
      `WITH ticket_b AS (
         SELECT date_trunc('${trunc}', t.created_at) AS bucket,
                COUNT(DISTINCT t.id)::int AS tickets_sold
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2
            AND t.status = 'sold'
            AND t.created_at >= $3 AND t.created_at <= $4
          GROUP BY 1
       ),
       credit_b AS (
         SELECT date_trunc('${trunc}', cl.created_at) AS bucket,
                COALESCE(SUM(cl.amount), 0)::bigint AS credit_pence
           FROM credit_ledger cl
           JOIN events e ON e.id = cl.event_id
          WHERE cl.user_id = $1 AND cl.role = 'promoter'
            AND e.promoter_id = $1 AND e.guru_id = $2
            AND cl.entry_type = 'CREDIT_ALLOCATION'
            AND cl.created_at >= $3 AND cl.created_at <= $4
          GROUP BY 1
       ),
       refund_b AS (
         SELECT date_trunc('${trunc}', COALESCE(t.refunded_at, t.updated_at, t.created_at)) AS bucket,
                COUNT(*)::int AS refunds
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE e.promoter_id = $1 AND e.guru_id = $2
            AND (t.status IN ('REFUNDED', 'CANCELLED', 'VOID') OR t.refunded_at IS NOT NULL)
            AND COALESCE(t.refunded_at, t.updated_at, t.created_at) >= $3
            AND COALESCE(t.refunded_at, t.updated_at, t.created_at) <= $4
          GROUP BY 1
       ),
       all_buckets AS (
         SELECT bucket FROM ticket_b
         UNION
         SELECT bucket FROM credit_b
         UNION
         SELECT bucket FROM refund_b
       )
       SELECT ab.bucket,
              COALESCE(tb.tickets_sold, 0) AS tickets_sold,
              COALESCE(cb.credit_pence, 0) AS credit_pence,
              COALESCE(rb.refunds, 0) AS refunds_processed
         FROM all_buckets ab
         LEFT JOIN ticket_b tb ON tb.bucket = ab.bucket
         LEFT JOIN credit_b cb ON cb.bucket = ab.bucket
         LEFT JOIN refund_b rb ON rb.bucket = ab.bucket
        WHERE ab.bucket IS NOT NULL
        ORDER BY ab.bucket DESC
        LIMIT $5`,
      [promoterId, guruId, start.toISOString(), end.toISOString(), lim]
    );

    const entries = histR.rows.map((row, idx) => ({
      id: `${promoterId}-${row.bucket ? new Date(row.bucket).getTime() : idx}`,
      periodStart: row.bucket ? new Date(row.bucket).toISOString() : null,
      ticketsSold: row.tickets_sold,
      creditGeneratedGbp: Number((Number(row.credit_pence || 0) / 100).toFixed(2)),
      refundsProcessed: row.refunds_processed,
    }));

    return {
      granularity: g,
      limit: lim,
      rangeUtc: { startsAt: start.toISOString(), endsAt: end.toISOString() },
      entries,
    };
  }
}

module.exports = GuruService;
