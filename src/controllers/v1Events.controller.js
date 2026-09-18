/**
 * Day 7 v1 Event APIs: create event (with Tier Resolver), event detail, promoter my events.
 * Base path: /api/v1/events
 */

const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");
const { resolveTier, getBookingFeePence } = require("../services/tierResolver.service");

async function deriveHierarchyFromPromoter(promoterId) {
  const result = await pool.query(
    `SELECT
      pgl.guru_user_id as guru_id,
      gnm.network_manager_user_id as network_manager_id,
      gnm.territory_id,
      t.name as territory_name
    FROM users u
    LEFT JOIN promoter_guru_links pgl ON pgl.promoter_user_id = u.id
    LEFT JOIN guru_network_manager gnm ON gnm.guru_user_id = pgl.guru_user_id
    LEFT JOIN territories t ON t.id = gnm.territory_id
    WHERE u.id = $1`,
    [promoterId]
  );
  if (result.rowCount === 0) return { guru_id: null, network_manager_id: null, territory_id: null };
  return result.rows[0];
}

/**
 * POST /api/v1/events — Create event (promoter). Ticket tiers: tier_name, ticket_price (GBP), quantity_available. Booking fee from Tier Resolver.
 */
async function createEventV1(req, res) {
  try {
    const promoterId = req.user.id;
    const { title, description, event_date, venue, ticket_tiers, age_restriction, event_type } = req.body;

    if (!title || !event_date || !Array.isArray(ticket_tiers) || ticket_tiers.length === 0) {
      return fail(res, req, 400, "MISSING_REQUIRED_FIELDS", "title, event_date, and ticket_tiers (non-empty) are required");
    }

    for (const tier of ticket_tiers) {
      if (tier.ticket_price == null || tier.quantity_available == null) {
        return fail(res, req, 400, "MISSING_REQUIRED_FIELDS", "Each tier must have tier_name, ticket_price, quantity_available");
      }
      try {
        resolveTier(Number(tier.ticket_price));
      } catch (e) {
        if (e.code === "INVALID_TICKET_PRICE") {
          return fail(res, req, 400, "INVALID_TICKET_PRICE", "ticket_price must be positive and within tier bands");
        }
        throw e;
      }
    }

    const hierarchy = await deriveHierarchyFromPromoter(promoterId);
    const territoryId = hierarchy.territory_id || 1;
    const eventDate = new Date(event_date);
    if (Number.isNaN(eventDate.getTime())) {
      return fail(res, req, 400, "INVALID_DATE", "event_date must be valid ISO8601");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const cityValue = venue || "UK";
      const eventResult = await client.query(
        `INSERT INTO events (
          promoter_id, guru_id, network_manager_id, territory_id,
          title, description, start_at, end_at, timezone,
          format, access_mode, visibility, city, city_display, venue_name, venue_address,
          status, ticketing_required
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Europe/London', 'in_person', 'ticketed', 'public', $9, $9, $10, $11, 'draft', true)
        RETURNING id, status, created_at`,
        [
          promoterId,
          hierarchy.guru_id,
          hierarchy.network_manager_id,
          territoryId,
          title,
          description || null,
          eventDate,
          eventDate,
          cityValue,
          venue || null,
          null,
        ]
      );
      const event = eventResult.rows[0];
      const eventId = event.id;

      let sortOrder = 0;
      for (const tier of ticket_tiers) {
        const pricePence = Math.round(Number(tier.ticket_price) * 100);
        const bookingFeePence = getBookingFeePence(Number(tier.ticket_price));
        await client.query(
          `INSERT INTO ticket_types (event_id, name, currency, price_amount, booking_fee_amount, capacity_total, qty_sold, sort_order, visibility, status)
           VALUES ($1, $2, 'GBP', $3, $4, $5, 0, $6, 'public', 'active')`,
          [
            eventId,
            tier.tier_name || "Tier " + (sortOrder + 1),
            pricePence,
            bookingFeePence,
            Math.max(0, parseInt(tier.quantity_available, 10) || 0),
            sortOrder++,
          ]
        );
      }

      await client.query("COMMIT");
      return ok(res, req, {
        event_id: String(eventId),
        status: "draft",
        title,
        created_at: event.created_at,
      }, 201);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("createEventV1 error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * GET /api/v1/events/:id — Event detail. Append booking_fee and total_cost per tier (from Tier Resolver or DB).
 */
async function getEventDetailV1(req, res) {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (isNaN(eventId) || eventId <= 0) {
      return fail(res, req, 404, "EVENT_NOT_FOUND", "Event not found");
    }

    const eventResult = await pool.query(
      `SELECT id, promoter_id, title, description, start_at, end_at, venue_name, venue_address, city_display, status, territory_id
       FROM events WHERE id = $1`,
      [eventId]
    );
    if (eventResult.rowCount === 0) {
      return fail(res, req, 404, "EVENT_NOT_FOUND", "Event not found");
    }
    const event = eventResult.rows[0];

    if (event.status === "draft" && req.user?.id !== event.promoter_id) {
      return fail(res, req, 403, "DRAFT_NOT_YOUR_EVENT", "Draft events are only visible to the owner");
    }

    const tiersResult = await pool.query(
      `SELECT id, name, price_amount, booking_fee_amount, capacity_total, qty_sold
       FROM ticket_types WHERE event_id = $1 ORDER BY sort_order`,
      [eventId]
    );

    const ticket_tiers = tiersResult.rows.map((row) => {
      const ticket_price = row.price_amount / 100;
      const booking_fee = row.booking_fee_amount / 100;
      return {
        tier_id: String(row.id),
        tier_name: row.name,
        ticket_price,
        booking_fee,
        total_cost: ticket_price + booking_fee,
        quantity_available: Math.max(0, (row.capacity_total ?? 0) - row.qty_sold),
        quantity_sold: row.qty_sold,
      };
    });

    return ok(res, req, {
      event_id: String(event.id),
      title: event.title,
      description: event.description,
      event_date: event.start_at,
      venue: event.venue_name || event.city_display,
      status: event.status,
      promoter_id: event.promoter_id,
      escrow_protected: true,
      ticket_tiers,
    });
  } catch (err) {
    console.error("getEventDetailV1 error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * GET /api/v1/events/my — Promoter's events with tickets_sold, gross_revenue_in_escrow, payout_status.
 * Query: status, search (or q), sort (soonest | oldest | title_asc | title_desc | tickets_sold), page, limit.
 */
async function getMyEventsV1(req, res) {
  try {
    const promoterId = req.user.id;
    const { status, search, q, sort = "soonest", page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let where = "e.promoter_id = $1";
    const params = [promoterId];
    let idx = 2;

    if (status && ["draft", "published", "live", "completed", "cancelled"].includes(status)) {
      const statusVal = status === "live" ? "published" : status;
      params.push(statusVal);
      where += ` AND e.status = $${idx}`;
      idx++;
    }

    const searchTerm = typeof (search || q) === "string" ? (search || q).trim() : "";
    if (searchTerm.length > 0) {
      params.push(`%${searchTerm}%`);
      where += ` AND e.title ILIKE $${idx}`;
      idx++;
    }

    const orderBy =
      sort === "tickets_sold"
        ? "(SELECT COALESCE(SUM(tt.qty_sold), 0)::int FROM ticket_types tt WHERE tt.event_id = e.id) DESC"
        : {
            soonest: "e.start_at ASC",
            oldest: "e.start_at DESC",
            title_asc: "e.title ASC",
            title_desc: "e.title DESC",
          }[sort] || "e.start_at ASC";

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM events e WHERE ${where}`,
      params
    );
    const total = countResult.rows[0]?.total ?? 0;

    params.push(limitNum, offset);
    const result = await pool.query(
      `SELECT e.id, e.title, e.status, e.start_at, e.territory_id,
              (SELECT COALESCE(SUM(tt.qty_sold), 0)::int FROM ticket_types tt WHERE tt.event_id = e.id) AS tickets_sold
       FROM events e
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );

    const escrowByEvent = await Promise.all(
      result.rows.map(async (row) => {
        const escrowResult = await pool.query(
          `SELECT balance FROM escrow_accounts WHERE territory_id = $1`,
          [row.territory_id]
        );
        const balance = escrowResult.rows[0]?.balance ?? 0;
        return { event_id: row.id, balance };
      })
    );
    const escrowMap = Object.fromEntries(escrowByEvent.map((e) => [e.event_id, e.balance]));

    const events = result.rows.map((row) => ({
      event_id: String(row.id),
      title: row.title,
      status: row.status,
      event_date: row.start_at,
      tickets_sold: row.tickets_sold ?? 0,
      gross_revenue_in_escrow: escrowMap[row.id] ?? 0,
      payout_status: "pending",
    }));

    return ok(res, req, { events, total });
  } catch (err) {
    console.error("getMyEventsV1 error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

function escapeCsvCell(val) {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * GET /api/v1/events/my/export — Promoter's events as CSV download (same filters as GET /my: status, search, sort).
 */
async function exportMyEventsV1(req, res) {
  try {
    const promoterId = req.user.id;
    const { status, search, q, sort = "soonest" } = req.query;

    let where = "e.promoter_id = $1";
    const params = [promoterId];
    let idx = 2;

    if (status && ["draft", "published", "live", "completed", "cancelled"].includes(status)) {
      const statusVal = status === "live" ? "published" : status;
      params.push(statusVal);
      where += ` AND e.status = $${idx}`;
      idx++;
    }

    const searchTerm = typeof (search || q) === "string" ? (search || q).trim() : "";
    if (searchTerm.length > 0) {
      params.push(`%${searchTerm}%`);
      where += ` AND e.title ILIKE $${idx}`;
      idx++;
    }

    const orderBy =
      sort === "tickets_sold"
        ? "(SELECT COALESCE(SUM(tt.qty_sold), 0)::int FROM ticket_types tt WHERE tt.event_id = e.id) DESC"
        : {
            soonest: "e.start_at ASC",
            oldest: "e.start_at DESC",
            title_asc: "e.title ASC",
            title_desc: "e.title DESC",
          }[sort] || "e.start_at ASC";

    const result = await pool.query(
      `SELECT e.id, e.title, e.status, e.start_at, e.territory_id,
              (SELECT COALESCE(SUM(tt.qty_sold), 0)::int FROM ticket_types tt WHERE tt.event_id = e.id) AS tickets_sold
       FROM events e
       WHERE ${where}
       ORDER BY ${orderBy}`,
      params
    );

    const escrowByEvent = await Promise.all(
      result.rows.map(async (row) => {
        const escrowResult = await pool.query(
          `SELECT balance FROM escrow_accounts WHERE territory_id = $1`,
          [row.territory_id]
        );
        const balance = escrowResult.rows[0]?.balance ?? 0;
        return { event_id: row.id, balance };
      })
    );
    const escrowMap = Object.fromEntries(escrowByEvent.map((e) => [e.event_id, e.balance]));

    const rows = result.rows.map((row) =>
      [
        row.id,
        escapeCsvCell(row.title),
        escapeCsvCell(row.status),
        row.start_at,
        row.tickets_sold ?? 0,
        (escrowMap[row.id] ?? 0) / 100,
        "pending",
      ].join(",")
    );

    const header = "event_id,title,status,event_date,tickets_sold,revenue_gbp,payout_status\n";
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="my_events_export.csv"');
    res.setHeader("X-Export-Rows", String(result.rows.length));
    return res.send(header + rows.join("\n"));
  } catch (err) {
    console.error("exportMyEventsV1 error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

module.exports = {
  createEventV1,
  getEventDetailV1,
  getMyEventsV1,
  exportMyEventsV1,
};
