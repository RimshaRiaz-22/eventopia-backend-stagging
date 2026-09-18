/**
 * Day 7 v1 Ticket APIs: purchase (no payment), my tickets.
 * Base path: /api/v1/tickets
 */

const pool = require("../db");
const crypto = require("crypto");
const { ok, fail } = require("../utils/standardResponse");
const { BUYER_VISIBLE_EVENT_STATUS, isBuyerVisibleEventStatus } = require("../utils/eventStatus");
const { resolveTier } = require("../services/tierResolver.service");
const { receiveTicketPayment } = require("../services/escrowReceive.service");
const { allocateCredit } = require("../services/allocateCredit.service");

function generateTicketCode() {
  return "TKT-" + crypto.randomBytes(6).toString("hex").toUpperCase();
}

function generateOrderNumber() {
  return "EVT-" + Date.now() + "-" + Math.floor(Math.random() * 10000);
}

/**
 * POST /api/v1/tickets/purchase — Purchase tickets (no payment). Immediate confirm.
 * Body: event_id, ticket_tier (tier_id = ticket_type id), quantity, attendee_names[]
 */
async function purchaseTicketsV1(req, res) {
  try {
    const buyerId = req.user.id;
    const { event_id, ticket_tier, quantity, attendee_names } = req.body;

    if (!event_id || !ticket_tier || quantity == null) {
      return fail(res, req, 400, "MISSING_REQUIRED_FIELDS", "event_id, ticket_tier, and quantity are required");
    }
    if (!Array.isArray(attendee_names) || attendee_names.length !== quantity) {
      return fail(res, req, 400, "ATTENDEE_NAMES_MISMATCH", "attendee_names length must equal quantity");
    }

    const eventId = parseInt(event_id, 10);
    const tierId = parseInt(ticket_tier, 10);
    const qty = parseInt(quantity, 10);
    if (isNaN(eventId) || isNaN(tierId) || isNaN(qty) || qty <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid event_id, ticket_tier, or quantity");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const eventResult = await client.query(
        `SELECT id, promoter_id, guru_id, network_manager_id, territory_id, status FROM events WHERE id = $1`,
        [eventId]
      );
      if (eventResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return fail(res, req, 404, "EVENT_NOT_FOUND", "Event not found");
      }
      const event = eventResult.rows[0];
      if (!isBuyerVisibleEventStatus(event.status)) {
        await client.query("ROLLBACK");
        return fail(res, req, 400, "EVENT_NOT_LIVE", `Event is not live (must be ${BUYER_VISIBLE_EVENT_STATUS})`);
      }

      const tierResult = await client.query(
        `SELECT id, event_id, name, price_amount, booking_fee_amount, capacity_total, qty_sold
         FROM ticket_types WHERE id = $1 AND event_id = $2 FOR UPDATE`,
        [tierId, eventId]
      );
      if (tierResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return fail(res, req, 404, "TICKET_TYPE_NOT_FOUND", "Ticket tier not found for this event");
      }
      const tier = tierResult.rows[0];
      const available = (tier.capacity_total ?? 999999) - tier.qty_sold;
      if (available < qty) {
        await client.query("ROLLBACK");
        return fail(res, req, 400, "INSUFFICIENT_QUANTITY", "Not enough tickets available");
      }

      const ticketPricePence = tier.price_amount;
      const bookingFeePence = tier.booking_fee_amount;
      const totalTicketPence = ticketPricePence * qty;
      const totalBookingFeePence = bookingFeePence * qty;
      const totalAmount = totalTicketPence + totalBookingFeePence;

      const orderNumber = generateOrderNumber();
      const orderResult = await client.query(
        `INSERT INTO orders (
          order_number, buyer_user_id, event_id, subtotal_amount, booking_fee_amount, total_amount,
          currency, status, payment_status, confirmed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'GBP', 'confirmed', 'paid', NOW())
        RETURNING id, order_number`,
        [orderNumber, buyerId, eventId, totalTicketPence, totalBookingFeePence, totalAmount]
      );
      const order = orderResult.rows[0];

      const lineTotal = totalAmount;
      const orderItemResult = await client.query(
        `INSERT INTO order_items (
          order_id, ticket_type_id, ticket_name, ticket_price_amount, ticket_booking_fee_amount,
          quantity, subtotal_amount, buyer_name, buyer_email
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id`,
        [
          order.id,
          tier.id,
          tier.name,
          tier.price_amount,
          tier.booking_fee_amount,
          qty,
          lineTotal,
          attendee_names[0] || "Buyer",
          req.user.email || null,
        ]
      );
      const orderItem = orderItemResult.rows[0];

      const ticketIds = [];
      for (let i = 0; i < qty; i++) {
        const ticketResult = await client.query(
          `INSERT INTO tickets (
            order_item_id, event_id, ticket_type_id, ticket_code, buyer_name, buyer_email, status, user_id, order_id
          ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)
          RETURNING id`,
          [
            orderItem.id,
            eventId,
            tier.id,
            generateTicketCode(),
            attendee_names[i] || "Attendee " + (i + 1),
            req.user?.email ? String(req.user.email) : "",
            buyerId,
            order.id,
          ]
        );
        ticketIds.push(ticketResult.rows[0].id);
      }

      await client.query(
        `UPDATE ticket_types SET qty_sold = qty_sold + $1 WHERE id = $2`,
        [qty, tier.id]
      );

      await client.query("COMMIT");
      client.release();

      const territoryId = event.territory_id || 1;
      await receiveTicketPayment({
        territory_id: territoryId,
        escrow_amount_pence: totalTicketPence,
        booking_fee_pence: totalBookingFeePence,
        buyer_id: buyerId,
        order_id: order.id,
        event_id: eventId,
      });

      const ticketPricePounds = tier.price_amount / 100;
      const { tier_label } = resolveTier(ticketPricePounds);
      await allocateCredit(
        {
          event_id: eventId,
          tier_label,
          quantity: qty,
          promoter_id: event.promoter_id,
          guru_id: event.guru_id,
          network_manager_id: event.network_manager_id,
          territory_id: territoryId,
          order_id: order.id,
        },
        {}
      );

      const tickets = attendee_names.map((name, i) => ({
        ticket_id: String(ticketIds[i]),
        attendee_name: name,
        tier_name: tier.name,
        ticket_price: tier.price_amount / 100,
        booking_fee: tier.booking_fee_amount / 100,
      }));

      return ok(
        res,
        req,
        {
          confirmation_reference: order.order_number,
          ticket_ids: ticketIds.map(String),
          total_paid: totalAmount / 100,
          booking_fee_total: totalBookingFeePence / 100,
          tickets,
        },
        201
      );
    } catch (err) {
      await client.query("ROLLBACK");
      client.release();
      if (err.code === "INVALID_TICKET_PRICE") {
        return fail(res, req, 400, "INVALID_TICKET_PRICE", err.message);
      }
      console.error("purchaseTicketsV1 error:", err);
      return fail(res, req, 500, "INTERNAL_ERROR", err.message);
    }
  } catch (err) {
    console.error("purchaseTicketsV1 error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * GET /api/v1/tickets/my — Buyer's tickets. Query: status (active|cancelled|refunded), page, limit.
 */
async function getMyTicketsV1(req, res) {
  try {
    const buyerId = req.user.id;
    const { status, page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let statusFilter = "";
    const params = [buyerId];
    if (status && ["active", "used", "cancelled", "refunded"].includes(status.toLowerCase())) {
      params.push(status.toUpperCase());
      statusFilter = `AND t.status = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT t.id, t.event_id, t.ticket_type_id, t.buyer_name, t.status, t.issued_at, t.order_id,
              tt.name AS tier_name, tt.price_amount, tt.booking_fee_amount,
              e.title AS event_title, e.start_at AS event_date, e.venue_name, e.city_display,
              o.order_number
       FROM tickets t
       JOIN order_items oi ON oi.id = t.order_item_id
       JOIN orders o ON o.id = oi.order_id
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       WHERE t.user_id = $1 ${statusFilter}
       ORDER BY t.issued_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limitNum, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM tickets t WHERE t.user_id = $1 ${statusFilter}`,
      params
    );
    const total = countResult.rows[0]?.total ?? 0;

    const tickets = result.rows.map((row) => ({
      ticket_id: String(row.id),
      event_id: row.event_id,
      event_title: row.event_title,
      event_date: row.event_date,
      venue: row.venue_name || row.city_display,
      tier_name: row.tier_name,
      ticket_price: row.price_amount / 100,
      booking_fee: row.booking_fee_amount / 100,
      attendee_name: row.buyer_name,
      status: row.status,
      confirmation_reference: row.order_number,
      purchased_at: row.issued_at,
    }));

    return ok(res, req, { tickets, total });
  } catch (err) {
    console.error("getMyTicketsV1 error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

module.exports = {
  purchaseTicketsV1,
  getMyTicketsV1,
};
