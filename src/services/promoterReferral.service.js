const crypto = require("crypto");
const pool = require("../db");
const { countSettledTicketsForPromoter } = require("./settledTicket.service");

const REFERRAL_PAYOUT_PENCE = 17250;
const REFERRAL_WINDOW_DAYS = 90;
const ACTIVE_CAP_BEFORE_OWN_575 = 3;
const LIFETIME_CAP_TOTAL = 10;
const OWN_THRESHOLD = 575;
const REFERRAL_PER_TICKET_PENCE = 30;

function buildPromoterReferralUrl(token) {
  const base = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
  return `${base}/register?referral_token=${encodeURIComponent(token)}`;
}

function generateReferralToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function ensureUkReferralPool(client) {
  const existing = await client.query(
    `SELECT * FROM territory_referral_pool WHERE territory_code = 'UK' LIMIT 1`
  );
  if (existing.rowCount > 0) return existing.rows[0];

  const created = await client.query(
    `INSERT INTO territory_referral_pool
      (territory_code, pool_total, pool_remaining, total_paid_out, created_at, updated_at)
     VALUES ('UK', 100000000, 100000000, 0, NOW(), NOW())
     RETURNING *`
  );
  return created.rows[0];
}

async function getReferrerGuruId(client, referrerId) {
  const guruLink = await client.query(
    `SELECT guru_user_id FROM promoter_guru_links WHERE promoter_user_id = $1 LIMIT 1`,
    [referrerId]
  );
  return guruLink.rows[0]?.guru_user_id || null;
}

async function createPromoterReferralLink(referrerId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userCheck = await client.query(
      `SELECT id, role, account_status FROM users WHERE id = $1 LIMIT 1`,
      [referrerId]
    );
    if (userCheck.rowCount === 0 || userCheck.rows[0].role !== "promoter") {
      const err = new Error("Only active promoters can generate referral links.");
      err.status = 403;
      throw err;
    }

    if ((userCheck.rows[0].account_status || "active") !== "active") {
      const err = new Error("Only active promoters can generate referral links.");
      err.status = 403;
      throw err;
    }

    const ownSettledTickets = await countSettledTicketsForPromoter(referrerId);
    const hasOwn575 = ownSettledTickets >= OWN_THRESHOLD;

    const [activeCountRes, lifetimeCountRes] = await Promise.all([
      client.query(
        `SELECT COUNT(*)::int AS c
         FROM promoter_referrals
         WHERE referrer_id = $1 AND status = 'active'`,
        [referrerId]
      ),
      client.query(
        `SELECT COUNT(*)::int AS c
         FROM promoter_referrals
         WHERE referrer_id = $1
           AND status IN ('active', 'success', 'expired', 'payout_pending', 'paid')`,
        [referrerId]
      ),
    ]);

    const activeCount = activeCountRes.rows[0]?.c || 0;
    const lifetimeCount = lifetimeCountRes.rows[0]?.c || 0;
    const activeCap = hasOwn575 ? LIFETIME_CAP_TOTAL : ACTIVE_CAP_BEFORE_OWN_575;
    const lifetimeCap = hasOwn575 ? LIFETIME_CAP_TOTAL : ACTIVE_CAP_BEFORE_OWN_575;

    if (activeCount >= activeCap) {
      const err = new Error(`Active referral cap reached (${activeCap}).`);
      err.status = 409;
      throw err;
    }
    if (lifetimeCount >= lifetimeCap) {
      const err = new Error(`Lifetime referral cap reached (${lifetimeCap}).`);
      err.status = 409;
      throw err;
    }

    const poolRow = await ensureUkReferralPool(client);
    if (Number(poolRow.pool_remaining || 0) < REFERRAL_PAYOUT_PENCE) {
      const err = new Error("Referral pool exhausted. New referral registrations are blocked.");
      err.status = 409;
      throw err;
    }

    const guruId = await getReferrerGuruId(client, referrerId);
    if (!guruId) {
      const err = new Error("Referrer must be linked to a Guru before generating referral links.");
      err.status = 400;
      throw err;
    }

    const token = generateReferralToken();
    const created = await client.query(
      `INSERT INTO promoter_referrals
        (referrer_id, guru_id, territory_code, referral_link_token, status, payout_amount, created_at, updated_at)
       VALUES ($1, $2, 'UK', $3, 'link_issued', $4, NOW(), NOW())
       RETURNING id, referral_link_token, status, payout_amount, created_at`,
      [referrerId, guruId, token, REFERRAL_PAYOUT_PENCE]
    );

    await client.query("COMMIT");
    return {
      referralId: created.rows[0].id,
      token: created.rows[0].referral_link_token,
      status: created.rows[0].status,
      payoutAmountPence: Number(created.rows[0].payout_amount),
      payoutAmountGbp: Number((Number(created.rows[0].payout_amount) / 100).toFixed(2)),
      windowDays: REFERRAL_WINDOW_DAYS,
      referralLink: buildPromoterReferralUrl(created.rows[0].referral_link_token),
      caps: {
        active: { used: activeCount + 1, max: activeCap },
        lifetime: { used: lifetimeCount + 1, max: lifetimeCap },
      },
      createdAt: created.rows[0].created_at,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function getPromoterReferrals(promoterId, options = {}) {
  const page = Number.isFinite(options.page) ? Math.max(1, options.page) : 1;
  const limit = Number.isFinite(options.limit)
    ? Math.min(100, Math.max(1, options.limit))
    : 10;
  const offset = (page - 1) * limit;
  const search = (options.search || "").trim();

  const referrerWhere = [
    `pr.referrer_id = $1`,
  ];
  const referrerParams = [promoterId];

  if (search) {
    referrerParams.push(`%${search}%`);
    const searchParamIdx = referrerParams.length;
    referrerWhere.push(
      `(u.name ILIKE $${searchParamIdx}
        OR u.email ILIKE $${searchParamIdx}
        OR pr.status ILIKE $${searchParamIdx}
        OR pr.referral_link_token ILIKE $${searchParamIdx}
        OR pr.id::text ILIKE $${searchParamIdx})`
    );
  }

  referrerParams.push(limit, offset);
  const limitParamIdx = referrerParams.length - 1;
  const offsetParamIdx = referrerParams.length;

  const referrerWhereSql = referrerWhere.join(" AND ");

  const [asReferrer, asReferrerCount, asReferred] = await Promise.all([
    pool.query(
      `SELECT
         pr.id,
         pr.referrer_id,
         pr.referred_id,
         pr.guru_id,
         pr.territory_code,
         pr.referral_link_token,
         pr.start_date,
         pr.expiry_date,
         pr.ticket_count,
         pr.status,
         pr.payout_amount,
         pr.payout_scheduled_date,
         CASE
           WHEN pr.expiry_date IS NULL THEN NULL
           ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (pr.expiry_date - NOW())) / 86400.0))::int
         END AS days_remaining,
         pr.created_at,
         u.name AS referred_name,
         u.email AS referred_email
       FROM promoter_referrals pr
       LEFT JOIN users u ON u.id = pr.referred_id
       WHERE ${referrerWhereSql}
       ORDER BY pr.created_at DESC
       LIMIT $${limitParamIdx}
       OFFSET $${offsetParamIdx}`,
      referrerParams
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM promoter_referrals pr
       LEFT JOIN users u ON u.id = pr.referred_id
       WHERE ${referrerWhereSql}`,
      referrerParams.slice(0, search ? 2 : 1)
    ),
    pool.query(
      `SELECT
         pr.id,
         pr.referrer_id,
         pr.referred_id,
         pr.guru_id,
         pr.territory_code,
         pr.start_date,
         pr.expiry_date,
         pr.ticket_count,
         pr.status,
         pr.payout_amount,
         pr.payout_scheduled_date,
         CASE
           WHEN pr.expiry_date IS NULL THEN NULL
           ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (pr.expiry_date - NOW())) / 86400.0))::int
         END AS days_remaining,
         pr.created_at,
         u.name AS referrer_name,
         u.email AS referrer_email
       FROM promoter_referrals pr
       LEFT JOIN users u ON u.id = pr.referrer_id
       WHERE pr.referred_id = $1
       ORDER BY pr.created_at DESC`,
      [promoterId]
    ),
  ]);

  const total = asReferrerCount.rows[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    asReferrer: asReferrer.rows,
    asReferred: asReferred.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      search,
    },
  };
}

async function getLatestShareableReferralLink(promoterId) {
  const result = await pool.query(
    `SELECT id, referral_link_token, status, created_at
     FROM promoter_referrals
     WHERE referrer_id = $1
       AND status = 'link_issued'
       AND referred_id IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [promoterId]
  );
  return result.rows[0] || null;
}

async function ensureShareableReferralLinkForPromoter(promoterId) {
  const existing = await getLatestShareableReferralLink(promoterId);
  if (existing) {
    return {
      referralId: existing.id,
      token: existing.referral_link_token,
      status: existing.status,
      referralLink: buildPromoterReferralUrl(existing.referral_link_token),
      createdAt: existing.created_at,
      source: "existing",
    };
  }

  const created = await createPromoterReferralLink(promoterId);
  return {
    ...created,
    source: "created",
  };
}

async function claimReferralOnRegister({ token, referredUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const referralRes = await client.query(
      `SELECT id, referrer_id, guru_id, territory_code, status, referred_id
       FROM promoter_referrals
       WHERE referral_link_token = $1
       LIMIT 1`,
      [token]
    );

    if (referralRes.rowCount === 0) {
      const err = new Error("Invalid referral token.");
      err.status = 400;
      throw err;
    }

    const referral = referralRes.rows[0];
    if (referral.referred_id) {
      const err = new Error("This referral link has already been used.");
      err.status = 409;
      throw err;
    }

    if (referral.status !== "link_issued") {
      const err = new Error("This referral link is not available.");
      err.status = 409;
      throw err;
    }

    if (String(referral.referrer_id) === String(referredUserId)) {
      const err = new Error("Self-referral is not allowed.");
      err.status = 400;
      throw err;
    }

    const poolRes = await client.query(
      `SELECT pool_remaining
       FROM territory_referral_pool
       WHERE territory_code = $1
       LIMIT 1`,
      [referral.territory_code || "UK"]
    );
    const poolRemaining = Number(poolRes.rows[0]?.pool_remaining || 0);
    if (poolRemaining < REFERRAL_PAYOUT_PENCE) {
      const err = new Error("Referral pool exhausted. New referral registrations are blocked.");
      err.status = 409;
      throw err;
    }

    const activated = await client.query(
      `UPDATE promoter_referrals
       SET referred_id = $2,
           start_date = NOW(),
           expiry_date = NOW() + INTERVAL '90 days',
           status = 'active',
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, referrer_id, referred_id, guru_id, start_date, expiry_date, status`,
      [referral.id, referredUserId]
    );

    const updatedAttr = await client.query(
      `UPDATE user_attributions
       SET guru_id = $2,
           referral_code = $3,
           signed_up_via_referral = TRUE
       WHERE user_id = $1`,
      [referredUserId, referral.guru_id, token]
    );
    if (updatedAttr.rowCount === 0) {
      await client.query(
        `INSERT INTO user_attributions (user_id, guru_id, referral_code, signed_up_via_referral)
         VALUES ($1, $2, $3, TRUE)`,
        [referredUserId, referral.guru_id, token]
      );
    }

    await client.query("COMMIT");
    return activated.rows[0];
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function getActiveReferralByReferredPromoter(referredPromoterId) {
  const result = await pool.query(
    `SELECT *
     FROM promoter_referrals
     WHERE referred_id = $1
       AND status = 'active'
       AND start_date IS NOT NULL
       AND expiry_date IS NOT NULL
       AND NOW() BETWEEN start_date AND expiry_date
     ORDER BY created_at DESC
     LIMIT 1`,
    [referredPromoterId]
  );
  return result.rows[0] || null;
}

async function applyReferralTicketProgress(referralId, quantity) {
  if (!quantity || quantity <= 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT *
       FROM promoter_referrals
       WHERE id = $1
       FOR UPDATE`,
      [referralId]
    );
    if (locked.rowCount === 0) {
      await client.query("COMMIT");
      return;
    }

    const referral = locked.rows[0];
    if (referral.status !== "active") {
      await client.query("COMMIT");
      return;
    }

    const inc = await client.query(
      `UPDATE promoter_referrals
       SET ticket_count = ticket_count + $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING ticket_count, expiry_date, status, payout_amount, referrer_id, territory_code`,
      [referralId, quantity]
    );

    const row = inc.rows[0];
    const withinWindow = row.expiry_date && new Date(row.expiry_date) >= new Date();
    if (withinWindow && Number(row.ticket_count) >= OWN_THRESHOLD) {
      const scheduledAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const statusUpdate = await client.query(
        `UPDATE promoter_referrals
         SET status = 'payout_pending',
             payout_scheduled_date = $2,
             updated_at = NOW()
         WHERE id = $1
           AND status = 'active'
         RETURNING id`,
        [referralId, scheduledAt]
      );

      if (statusUpdate.rowCount > 0) {
        await client.query(
          `INSERT INTO promoter_referral_payouts
            (referral_id, referrer_id, payout_amount, scheduled_at, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'payout_pending', NOW(), NOW())
           ON CONFLICT (referral_id) DO NOTHING`,
          [referralId, row.referrer_id, row.payout_amount || REFERRAL_PAYOUT_PENCE, scheduledAt]
        );

        await client.query(
          `UPDATE territory_referral_pool
           SET pool_remaining = pool_remaining - $2,
               total_paid_out = total_paid_out + $2,
               updated_at = NOW()
           WHERE territory_code = $1`,
          [row.territory_code || "UK", row.payout_amount || REFERRAL_PAYOUT_PENCE]
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function expireActivePromoterReferrals() {
  const result = await pool.query(
    `UPDATE promoter_referrals
     SET status = 'expired',
         updated_at = NOW()
     WHERE status = 'active'
       AND expiry_date IS NOT NULL
       AND expiry_date < NOW()
     RETURNING id`
  );
  return result.rowCount;
}

async function getReferralPoolAdminView() {
  const [poolResult, activeResult, payoutsResult] = await Promise.all([
    pool.query(
      `SELECT territory_code, pool_total, pool_remaining, total_paid_out, updated_at
       FROM territory_referral_pool
       WHERE territory_code = 'UK'
       LIMIT 1`
    ),
    pool.query(
      `SELECT pr.*, u1.name AS referrer_name, u2.name AS referred_name
       FROM promoter_referrals pr
       LEFT JOIN users u1 ON u1.id = pr.referrer_id
       LEFT JOIN users u2 ON u2.id = pr.referred_id
       WHERE pr.status IN ('active', 'payout_pending')
       ORDER BY pr.created_at DESC`
    ),
    pool.query(
      `SELECT p.*, u.name AS referrer_name
       FROM promoter_referral_payouts p
       LEFT JOIN users u ON u.id = p.referrer_id
       WHERE p.status IN ('payout_pending', 'approved')
       ORDER BY p.created_at DESC`
    ),
  ]);

  return {
    pool: poolResult.rows[0] || null,
    activeReferrals: activeResult.rows,
    payoutLiabilities: payoutsResult.rows,
  };
}

async function approveReferralPayout(referralId, adminUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payoutRes = await client.query(
      `SELECT *
       FROM promoter_referral_payouts
       WHERE referral_id = $1
       FOR UPDATE`,
      [referralId]
    );
    if (payoutRes.rowCount === 0) {
      const err = new Error("Payout liability not found for this referral.");
      err.status = 404;
      throw err;
    }
    const payout = payoutRes.rows[0];
    if (payout.status === "paid") {
      const err = new Error("Payout already approved/paid.");
      err.status = 409;
      throw err;
    }
    if (new Date(payout.scheduled_at) > new Date()) {
      const err = new Error("30-day compliance review window not completed yet.");
      err.status = 409;
      throw err;
    }

    await client.query(
      `UPDATE promoter_referral_payouts
       SET status = 'paid',
           approved_at = NOW(),
           approved_by = $2,
           paid_at = NOW(),
           updated_at = NOW()
       WHERE referral_id = $1`,
      [referralId, adminUserId]
    );

    await client.query(
      `UPDATE promoter_referrals
       SET status = 'paid',
           updated_at = NOW()
       WHERE id = $1`,
      [referralId]
    );

    await client.query("COMMIT");
    return { referralId, status: "paid" };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createPromoterReferralLink,
  getPromoterReferrals,
  ensureShareableReferralLinkForPromoter,
  claimReferralOnRegister,
  getActiveReferralByReferredPromoter,
  applyReferralTicketProgress,
  expireActivePromoterReferrals,
  getReferralPoolAdminView,
  approveReferralPayout,
  REFERRAL_PER_TICKET_PENCE,
  REFERRAL_PAYOUT_PENCE,
  REFERRAL_WINDOW_DAYS,
};
