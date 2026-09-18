const pool = require('../db');
const { ok, fail } = require('../utils/standardResponse');

/**
 * Get all reward vouchers for authenticated guru
 * GET /api/guru/rewards
 */
async function getMyRewards(req, res) {
  try {
    const result = await pool.query(
      `SELECT rv.*, e.title as event_title, e.completed_at
       FROM reward_vouchers rv
       JOIN events e ON e.id = rv.event_id
       WHERE rv.owner_type = 'guru'
       AND rv.owner_id = $1
       ORDER BY rv.issued_at DESC`,
      [req.user.id]
    );

    return ok(res, req, "Guru rewards retrieved", {
      vouchers: result.rows
    });

  } catch (err) {
    console.error('Get guru rewards error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve rewards");
  }
}

module.exports = {
  getMyRewards
};
