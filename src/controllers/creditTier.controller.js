const pool = require("../db");
const { resolveTier, TIERS } = require("../services/tierResolver.service");

// Day 8 baseline split constants mapped by tier label.
// Network manager role has been removed in this project customisation.
const SPLITS_BY_TIER = {
  1: { promoter: "0.50", guru: "0.30", network_manager: "0.00", eventopia: "0.29", reinvestment: "0.00", vat_amount: "0.31", noda_fee: "0.35", distributable_pool: "1.19" },
  2: { promoter: "0.50", guru: "0.35", network_manager: "0.00", eventopia: "0.40", reinvestment: "0.00", vat_amount: "0.40", noda_fee: "0.35", distributable_pool: "1.60" },
  3: { promoter: "0.50", guru: "0.50", network_manager: "0.00", eventopia: "0.35", reinvestment: "0.17", vat_amount: "0.48", noda_fee: "0.35", distributable_pool: "2.02" },
  4: { promoter: "0.50", guru: "0.50", network_manager: "0.00", eventopia: "0.50", reinvestment: "0.56", vat_amount: "0.59", noda_fee: "0.35", distributable_pool: "2.56" },
  5: { promoter: "0.50", guru: "0.50", network_manager: "0.00", eventopia: "0.75", reinvestment: "1.15", vat_amount: "0.75", noda_fee: "0.35", distributable_pool: "3.40" },
  6: { promoter: "0.50", guru: "0.50", network_manager: "0.00", eventopia: "1.00", reinvestment: "2.02", vat_amount: "0.98", noda_fee: "0.35", distributable_pool: "4.52" },
};

const FIVE_MIN_MS = 5 * 60 * 1000;
const tableCache = new Map();

function toMoneyString(n) {
  return Number(n).toFixed(2);
}

function floorTo2(n) {
  return Math.floor((n + Number.EPSILON) * 100) / 100;
}

function buildPaginatedTierResponse(basePayload, rawPage, rawLimit) {
  const totalEntries = basePayload.tiers.length;
  const page = rawPage === undefined ? 1 : parseInt(String(rawPage), 10);
  const limit = rawLimit === undefined ? 20 : parseInt(String(rawLimit), 10);
  if (!Number.isFinite(page) || page <= 0) {
    const err = new Error("INVALID_PAGE");
    err.code = "INVALID_PAGE";
    throw err;
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    const err = new Error("INVALID_LIMIT");
    err.code = "INVALID_LIMIT";
    throw err;
  }
  const safeLimit = Math.min(100, limit);
  const totalPages = totalEntries === 0 ? 0 : Math.ceil(totalEntries / safeLimit);
  const offset = (page - 1) * safeLimit;
  const pagedTiers = basePayload.tiers.slice(offset, offset + safeLimit);

  return {
    territory_id: basePayload.territory_id,
    territory_name: basePayload.territory_name,
    pagination: {
      page,
      limit: safeLimit,
      total_entries: totalEntries,
      total_pages: totalPages,
    },
    tiers: pagedTiers,
    referral_mode_active: basePayload.referral_mode_active,
    retrieved_at: basePayload.retrieved_at,
  };
}

function formatTierRow(t) {
  const split = SPLITS_BY_TIER[t.tier_number] || SPLITS_BY_TIER[1];
  return {
    tier_number: t.tier_number,
    price_range: { min: toMoneyString(t.min), max: t.max == null ? null : toMoneyString(t.max) },
    booking_fee: t.booking_fee,
    vat_amount: split.vat_amount,
    noda_fee: split.noda_fee,
    distributable_pool: split.distributable_pool,
    splits: {
      promoter: split.promoter,
      guru: split.guru,
      network_manager: split.network_manager,
      eventopia: split.eventopia,
      reinvestment: split.reinvestment,
    },
  };
}

async function fetchTicketTypeBands(territoryId) {
  // Use the same ticket_types source used by event creation/order flows.
  const result = await pool.query(
    `SELECT
       MIN(tt.price_amount)::int AS min_price_amount,
       MAX(tt.price_amount)::int AS max_price_amount,
       MIN(tt.booking_fee_amount)::int AS booking_fee_amount
     FROM ticket_types tt
     JOIN events e ON e.id = tt.event_id
     WHERE e.territory_id = $1
       AND tt.status = 'active'
       AND e.status IN ('published', 'active')
     GROUP BY tt.booking_fee_amount
     ORDER BY min_price_amount ASC`,
    [territoryId]
  );

  return result.rows.map((row, idx) => ({
    tier_number: idx + 1,
    min: (Number(row.min_price_amount) || 0) / 100,
    max: (Number(row.max_price_amount) || 0) / 100,
    booking_fee: toMoneyString((Number(row.booking_fee_amount) || 0) / 100),
  }));
}

async function getCreditTier(req, res) {
  try {
    const mode = String(req.query.mode || "normal").toLowerCase();
    const rawTicketPrice = req.query.ticket_price;
    const rawPage = req.query.page;
    const rawLimit = req.query.limit;
    const territoryId = Number(req.user?.territory_id || req.query.territory_id || 1);

    const territoryResult = await pool.query(
      `SELECT id, name FROM territories WHERE id = $1 LIMIT 1`,
      [territoryId]
    );
    if (territoryResult.rowCount === 0) {
      return res.status(404).json({
        error: "TERRITORY_NOT_FOUND",
        message: "Territory not found",
      });
    }
    const territory = territoryResult.rows[0];

    // Day 8: referral mode is accepted but inactive.
    const referralModeActive = false;
    void mode;

    if (rawTicketPrice !== undefined) {
      const parsed = Number(rawTicketPrice);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return res.status(400).json({
          error: "INVALID_TICKET_PRICE",
          message: "ticket_price must be a positive number",
        });
      }

      const normalized = floorTo2(parsed);
      let resolved;
      try {
        resolved = resolveTier(normalized);
      } catch (_) {
        return res.status(400).json({
          error: "INVALID_TICKET_PRICE",
          message: "ticket_price must be a positive number",
        });
      }

      // Prefer booking fee configured in ticket_types for this territory/price, fallback to resolver.
      const exactFee = await pool.query(
        `SELECT tt.booking_fee_amount
         FROM ticket_types tt
         JOIN events e ON e.id = tt.event_id
         WHERE e.territory_id = $1
           AND tt.status = 'active'
           AND tt.price_amount = $2
         ORDER BY tt.updated_at DESC
         LIMIT 1`,
        [territoryId, Math.round(normalized * 100)]
      );
      const bookingFee = exactFee.rowCount > 0
        ? toMoneyString(Number(exactFee.rows[0].booking_fee_amount) / 100)
        : toMoneyString(resolved.booking_fee);

      return res.status(200).json({
        territory_id: String(territory.id),
        territory_name: territory.name,
        matched_tier: formatTierRow({
          tier_number: resolved.tier_label,
          min: normalized,
          max: normalized,
          booking_fee: bookingFee,
        }),
        referral_mode_active: referralModeActive,
        retrieved_at: new Date().toISOString(),
      });
    }

    const cacheKey = `tier-table:${territory.id}`;
    const cached = tableCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      try {
        const paged = buildPaginatedTierResponse(cached.payload, rawPage, rawLimit);
        return res.status(200).json(paged);
      } catch (err) {
        if (err.code === "INVALID_PAGE") {
          return res.status(400).json({
            error: "INVALID_PAGE",
            message: "Page must be a positive integer",
          });
        }
        if (err.code === "INVALID_LIMIT") {
          return res.status(400).json({
            error: "INVALID_LIMIT",
            message: "Limit must be a positive integer",
          });
        }
        throw err;
      }
    }

    const ticketTypeBands = await fetchTicketTypeBands(territory.id);
    const tiers = ticketTypeBands.length > 0
      ? ticketTypeBands.map(formatTierRow)
      : TIERS.map((t) =>
          formatTierRow({
            tier_number: t.tier_label,
            min: t.min,
            max: Number.isFinite(t.max) ? t.max : null,
            booking_fee: toMoneyString(t.booking_fee),
          })
        );

    const payload = {
      territory_id: String(territory.id),
      territory_name: territory.name,
      tiers,
      referral_mode_active: referralModeActive,
      retrieved_at: new Date().toISOString(),
    };
    tableCache.set(cacheKey, { payload, expiresAt: now + FIVE_MIN_MS });
    try {
      const paged = buildPaginatedTierResponse(payload, rawPage, rawLimit);
      return res.status(200).json(paged);
    } catch (err) {
      if (err.code === "INVALID_PAGE") {
        return res.status(400).json({
          error: "INVALID_PAGE",
          message: "Page must be a positive integer",
        });
      }
      if (err.code === "INVALID_LIMIT") {
        return res.status(400).json({
          error: "INVALID_LIMIT",
          message: "Limit must be a positive integer",
        });
      }
      throw err;
    }
  } catch (err) {
    console.error("getCreditTier error:", err);
    return res.status(500).json({
      error: "SERVER_ERROR",
      message: "Unable to load credit tier data",
    });
  }
}

module.exports = {
  getCreditTier,
};
