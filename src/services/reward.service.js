const pool = require('../db');

/**
 * Calculate rewards for an event completion
 * @param {number} eventId - Event ID
 * @returns {Promise<Object>} { ticketsSold, promoterId, guruId, promoterReward, guruReward }
 */
async function calculateRewardsForEvent(eventId) {
  const client = await pool.connect();
  try {
    // Get event details including tickets sold and guru attribution
    const eventResult = await client.query(
      'SELECT tickets_sold, guru_id, promoter_id FROM events WHERE id = $1',
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      throw new Error('Event not found');
    }

    const { tickets_sold, guru_id, promoter_id } = eventResult.rows[0];

    // Validate we have tickets sold
    if (!tickets_sold || tickets_sold === 0) {
      return {
        ticketsSold: 0,
        promoterId: promoter_id,
        guruId: guru_id,
        promoterReward: 0,
        guruReward: 0
      };
    }

    // Get promoter reward rate from config
    const promoterRateResult = await client.query(
      "SELECT config_value FROM system_config WHERE config_key = 'promoter_reward_per_ticket_pence'"
    );

    let promoterRatePerTicket = 100; // Default £1.00 = 100 pence
    if (promoterRateResult.rowCount > 0) {
      promoterRatePerTicket = parseInt(promoterRateResult.rows[0].config_value);
    }

    const promoterReward = tickets_sold * promoterRatePerTicket;

    let guruReward = 0;

    // Calculate guru reward if guru is linked
    if (guru_id) {
      // Get guru's current level
      const guruLevelResult = await client.query(
        `SELECT gl.rate_per_ticket
         FROM guru_levels gl
         WHERE gl.guru_id = $1
         AND gl.effective_until IS NULL
         ORDER BY gl.effective_from DESC
         LIMIT 1`,
        [guru_id]
      );

      if (guruLevelResult.rowCount > 0) {
        const guruRatePerTicket = guruLevelResult.rows[0].rate_per_ticket;
        guruReward = tickets_sold * guruRatePerTicket;
      }
    }

    return {
      ticketsSold: tickets_sold,
      promoterId: promoter_id,
      guruId: guru_id,
      promoterReward,
      guruReward
    };
  } finally {
    client.release();
  }
}

/**
 * Issue vouchers for event completion
 * This function is idempotent - safe to call multiple times
 * @param {number} eventId - Event ID
 * @param {number|null} adminId - Admin who completed the event (null for system)
 * @returns {Promise<Object>} rewards object
 */
async function issueRewardsForEvent(eventId, adminId) {
  const client = await pool.connect();
  try {
    // Check if event is completed
    const eventResult = await client.query(
      'SELECT completion_status FROM events WHERE id = $1',
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      throw new Error('Event not found');
    }

    const { completion_status } = eventResult.rows[0];

    if (completion_status !== 'completed') {
      return {
        ticketsSold: 0,
        promoterId: null,
        guruId: null,
        promoterReward: 0,
        guruReward: 0,
        eventNotCompleted: true
      };
    }

    // Calculate rewards first
    const rewards = await calculateRewardsForEvent(eventId);

    // If no tickets sold, nothing to issue
    if (rewards.ticketsSold === 0) {
      return rewards;
    }

    await client.query('BEGIN');

    // Get voucher expiry from config
    const expiryResult = await client.query(
      "SELECT config_value FROM system_config WHERE config_key = 'voucher_expiry_months'"
    );

    let expiryMonths = 12; // Default 12 months
    if (expiryResult.rowCount > 0) {
      expiryMonths = parseInt(expiryResult.rows[0].config_value);
    }

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + expiryMonths);

    // Issue promoter voucher (if reward > 0)
    if (rewards.promoterReward > 0) {
      await client.query(
        `INSERT INTO reward_vouchers
         (owner_type, owner_id, event_id, amount, expires_at, source)
         VALUES ('promoter', $1, $2, $3, $4, 'event_completion')
         ON CONFLICT (event_id, owner_type, owner_id) DO NOTHING`,
        [rewards.promoterId, eventId, rewards.promoterReward, expiresAt]
      );
    }

    // Issue guru voucher (if reward > 0 and guru exists)
    if (rewards.guruReward > 0 && rewards.guruId) {
      await client.query(
        `INSERT INTO reward_vouchers
         (owner_type, owner_id, event_id, amount, expires_at, source)
         VALUES ('guru', $1, $2, $3, $4, 'event_completion')
         ON CONFLICT (event_id, owner_type, owner_id) DO NOTHING`,
        [rewards.guruId, eventId, rewards.guruReward, expiresAt]
      );
    }

    // Log to audit
    await client.query(
      `INSERT INTO event_audit_logs
       (event_id, promoter_id, action, field_name, new_value)
       VALUES ($1, $2, 'rewards_issued', 'reward_vouchers', $3)`,
      [eventId, rewards.promoterId, JSON.stringify({
        ticketsSold: rewards.ticketsSold,
        promoterReward: rewards.promoterReward,
        guruReward: rewards.guruReward,
        issuedBy: adminId,
        expiryMonths: expiryMonths
      })]
    );

    await client.query('COMMIT');

    return {
      ...rewards,
      expiresAt: expiresAt
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to issue rewards for event:', eventId, err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  calculateRewardsForEvent,
  issueRewardsForEvent
};
