const pool = require("../db");
const crypto = require("crypto");

/**
 * Referral Service
 * Handles referral code generation, tracking, and attribution
 */
class ReferralService {
  /**
   * Generate a unique referral code
   * @returns {string} Unique referral code
   */
  static generateReferralCode() {
    // Generate 8-character base62 code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Create a referral code for a Guru
   * @param {number} guruId - Guru user ID
   * @returns {Promise<Object>} Referral record
   */
  static async createReferralCode(guruId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if referral already exists
      const existing = await client.query(
        'SELECT * FROM guru_referrals WHERE guru_id = $1 AND revoked_at IS NULL',
        [guruId]
      );

      if (existing.rowCount > 0) {
        await client.query('COMMIT');
        return existing.rows[0];
      }

      // Generate unique code
      let referralCode;
      let isUnique = false;
      let attempts = 0;

      while (!isUnique && attempts < 10) {
        referralCode = this.generateReferralCode();
        const check = await client.query(
          'SELECT id FROM guru_referrals WHERE referral_code = $1',
          [referralCode]
        );
        if (check.rowCount === 0) {
          isUnique = true;
        }
        attempts++;
      }

      if (!isUnique) {
        throw new Error('Failed to generate unique referral code');
      }

      // Create referral record
      const result = await client.query(
        `INSERT INTO guru_referrals (guru_id, referral_code)
         VALUES ($1, $2)
         RETURNING *`,
        [guruId, referralCode]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Create referral code error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get referral info for a Guru
   * @param {number} guruId - Guru user ID
   * @returns {Promise<Object>} Referral info
   */
  static async getReferralInfo(guruId) {
    const result = await pool.query(
      'SELECT * FROM guru_referrals WHERE guru_id = $1 AND revoked_at IS NULL',
      [guruId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return result.rows[0];
  }

  /**
   * Validate a referral code
   * @param {string} code - Referral code to validate
   * @returns {Promise<Object|null>} Guru info if valid, null otherwise
   */
  static async validateReferralCode(code) {
    const result = await pool.query(
      `SELECT gr.*, u.name as guru_name
       FROM guru_referrals gr
       JOIN users u ON u.id = gr.guru_id
       WHERE gr.referral_code = $1 AND gr.revoked_at IS NULL`,
      [code]
    );

    return result.rowCount > 0 ? result.rows[0] : null;
  }

  /**
   * Record a referral click event
   * @param {string} code - Referral code
   * @param {string} visitorId - Visitor identifier (cookie/session)
   * @param {string} ip - Visitor IP address
   * @param {string} userAgent - Visitor user agent
   * @returns {Promise<Object>} Referral event record
   */
  static async recordClick(code, visitorId, ip, userAgent) {
    const guru = await this.validateReferralCode(code);
    if (!guru) {
      throw new Error('Invalid referral code');
    }

    const result = await pool.query(
      `INSERT INTO referral_events
        (referral_code, guru_id, event_type, visitor_id, ip_address, user_agent)
       VALUES ($1, $2, 'click', $3, $4, $5)
       RETURNING *`,
      [code, guru.guru_id, visitorId, ip, userAgent]
    );

    return result.rows[0];
  }

  /**
   * Record a signup via referral
   * @param {string} code - Referral code
   * @param {number} userId - New user ID
   * @returns {Promise<Object>} Attribution record
   */
  static async recordSignup(code, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const guru = await this.validateReferralCode(code);
      if (!guru) {
        throw new Error('Invalid referral code');
      }

      // Record signup event
      await client.query(
        `INSERT INTO referral_events
          (referral_code, guru_id, event_type, user_id)
         VALUES ($1, $2, 'signup', $3)`,
        [code, guru.guru_id, userId]
      );

      // Record attribution (no UNIQUE on user_id in all DBs — use update-then-insert, same as promoter referrals)
      const updatedAttr = await client.query(
        `UPDATE user_attributions
         SET guru_id = $2, referral_code = $3, signed_up_via_referral = TRUE
         WHERE user_id = $1
         RETURNING *`,
        [userId, guru.guru_id, code]
      );
      let attributionRow = updatedAttr.rows[0];
      if (!attributionRow) {
        const inserted = await client.query(
          `INSERT INTO user_attributions (user_id, guru_id, referral_code, signed_up_via_referral)
           VALUES ($1, $2, $3, TRUE)
           RETURNING *`,
          [userId, guru.guru_id, code]
        );
        attributionRow = inserted.rows[0];
      }

      await client.query('COMMIT');
      return attributionRow;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Record signup error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get user attribution info
   * @param {number} userId - User ID
   * @returns {Promise<Object|null>} Attribution info
   */
  static async getAttribution(userId) {
    const result = await pool.query(
      `SELECT ua.*, gr.referral_code, u.name as guru_name
       FROM user_attributions ua
       LEFT JOIN guru_referrals gr ON gr.guru_id = ua.guru_id
       LEFT JOIN users u ON u.id = ua.guru_id
       WHERE ua.user_id = $1`,
      [userId]
    );

    return result.rowCount > 0 ? result.rows[0] : null;
  }

  /**
   * Get referral statistics for a Guru
   * @param {number} guruId - Guru user ID
   * @param {Date} dateFrom - Start date
   * @param {Date} dateTo - End date
   * @returns {Promise<Object>} Statistics
   */
  static async getReferralStats(guruId, dateFrom, dateTo) {
    const params = [guruId];
    let whereClause = 'WHERE guru_id = $1';

    if (dateFrom) {
      params.push(dateFrom);
      whereClause += ` AND created_at >= $${params.length}`;
    }

    if (dateTo) {
      params.push(dateTo);
      whereClause += ` AND created_at <= $${params.length}`;
    }

    // Get click stats
    const clicksResult = await pool.query(
      `SELECT COUNT(*) as click_count
       FROM referral_events
       ${whereClause} AND event_type = 'click'`,
      params
    );

    // Get signup stats
    const signupsResult = await pool.query(
      `SELECT COUNT(*) as signup_count
       FROM referral_events
       ${whereClause} AND event_type = 'signup'`,
      params
    );

    // Get promoter activations
    const activationsResult = await pool.query(
      `SELECT COUNT(*) as activation_count
       FROM referral_events
       ${whereClause} AND event_type = 'promoter_activation'`,
      params
    );

    return {
      clicks: parseInt(clicksResult.rows[0].click_count),
      signups: parseInt(signupsResult.rows[0].signup_count),
      activations: parseInt(activationsResult.rows[0].activation_count)
    };
  }
}

module.exports = ReferralService;
