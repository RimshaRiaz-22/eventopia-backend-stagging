const pool = require('../db');
const { ok, fail } = require('../utils/standardResponse');

/**
 * Get promoter dashboard overview (KPIs, wallet, rewards, recent events)
 * GET /api/promoters/dashboard/overview
 */
async function getDashboardOverview(req, res) {
  try {
    const promoterId = req.user.id;

    const [
      summaryResult,
      walletResult,
      rewardsResult,
      // recentEventsResult,
    ] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS events_total,
           COUNT(*) FILTER (WHERE e.status = 'draft')::int AS events_draft,
           COUNT(*) FILTER (WHERE e.status = 'published')::int AS events_published,
           COUNT(*) FILTER (WHERE e.completion_status = 'completed')::int AS events_completed,
           COALESCE(SUM(e.tickets_sold), 0)::bigint AS tickets_sold_total,
           (SELECT COALESCE(SUM(o.total_amount), 0)::bigint FROM orders o
            JOIN events ev ON ev.id = o.event_id AND ev.promoter_id = $1
            WHERE o.status IN ('PAID', 'confirmed')) AS total_revenue,
           (SELECT COALESCE(SUM(o.booking_fee_amount), 0)::bigint FROM orders o
            JOIN events ev ON ev.id = o.event_id AND ev.promoter_id = $1
            WHERE o.status IN ('PAID', 'confirmed')) AS booking_fees_total
         FROM events e
         WHERE e.promoter_id = $1`,
        [promoterId]
      ),
      pool.query(
        `SELECT COALESCE(balance_amount, 0)::bigint AS balance_amount, currency
         FROM wallets WHERE user_id = $1`,
        [promoterId]
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'active' THEN amount ELSE 0 END), 0)::bigint AS rewards_available,
           COALESCE(SUM(CASE WHEN status IN ('active', 'used') THEN amount ELSE 0 END), 0)::bigint AS rewards_total
         FROM reward_vouchers
         WHERE owner_type = 'promoter' AND owner_id = $1`,
        [promoterId]
      ),
      pool.query(
        `SELECT e.id, e.title, e.status, e.start_at AS "startAt", e.end_at AS "endAt",
                e.city_display AS "city", e.venue_name AS "venueName", e.tickets_sold,
                e.cover_image_url AS "coverImageUrl"
         FROM events e
         WHERE e.promoter_id = $1
         ORDER BY e.updated_at DESC
         LIMIT 5`,
        [promoterId]
      ),
    ]);

    const summary = summaryResult.rows[0];
    const wallet = walletResult.rows[0];
    const rewards = rewardsResult.rows[0];
    // const recentEvents = recentEventsResult.rows;

    const walletBalance = wallet ? Number(wallet.balance_amount) : 0;
    const currency = wallet?.currency || 'GBP';

    return ok(res, req, {
      summary: {
        eventsTotal: Number(summary?.events_total ?? 0),
        eventsDraft: Number(summary?.events_draft ?? 0),
        eventsPublished: Number(summary?.events_published ?? 0),
        eventsCompleted: Number(summary?.events_completed ?? 0),
        ticketsSoldTotal: Number(summary?.tickets_sold_total ?? 0),
        totalRevenue: Number(summary?.total_revenue ?? 0),
        bookingFeesTotal: Number(summary?.booking_fees_total ?? 0),
      },
      wallet: {
        balanceAmount: walletBalance,
        currency,
      },
      rewards: {
        available: Number(rewards?.rewards_available ?? 0),
        total: Number(rewards?.rewards_total ?? 0),
      },
      // recentEvents: recentEvents.map((e) => ({
      //   id: e.id,
      //   title: e.title,
      //   status: e.status,
      //   startAt: e.startAt?.toISOString?.() ?? e.startAt,
      //   endAt: e.endAt?.toISOString?.() ?? e.endAt,
      //   city: e.city,
      //   venueName: e.venueName,
      //   ticketsSold: e.tickets_sold ?? 0,
      //   coverImageUrl: e.coverImageUrl,
      // })),
    });
  } catch (err) {
    console.error('Get promoter dashboard overview error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to load dashboard overview");
  }
}

/**
 * Get all reward vouchers for authenticated promoter
 * GET /api/promoter/rewards
 */
async function getMyRewards(req, res) {
  try {
    const result = await pool.query(
      `SELECT rv.*, e.title as event_title, e.completed_at
       FROM reward_vouchers rv
       JOIN events e ON e.id = rv.event_id
       WHERE rv.owner_type = 'promoter'
       AND rv.owner_id = $1
       ORDER BY rv.issued_at DESC`,
      [req.user.id]
    );

    return ok(res, req, {
      message: "Promoter rewards retrieved",
      vouchers: result.rows,
    });
  } catch (err) {
    console.error('Get promoter rewards error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", "Failed to retrieve rewards");
  }
}

module.exports = {
  getDashboardOverview,
  getMyRewards,
};
