const crypto = require("crypto");
const { buildQR } = require("../utils/ticketQr.util");
const { resolveTier } = require("./tierResolver.service");
const { receiveTicketPayment } = require("./escrowReceive.service");
const { allocateCredit } = require("./allocateCredit.service");
const CommissionService = require("./commission.service");

function generateTicketCode() {
  return "TKT-" + crypto.randomBytes(6).toString("hex").toUpperCase();
}

/**
 * Mint tickets, consume reservations, update sold counts.
 * Caller must hold a row lock on the order (e.g. FOR UPDATE) and an open transaction on `client`.
 *
 * @param {import("pg").PoolClient} client
 * @param {object} order — row from SELECT o.* ... JOIN events e (territory_id, promoter_id, guru_id, network_manager_id, event_id)
 * @param {number} orderId
 * @returns {Promise<{ alreadyConfirmed: boolean, order?: object, responseItems?: array, qtyByTierLabel?: object }>}
 */
async function fulfillLockedOrderPaymentSuccess(client, order, orderId) {
  const alreadyConfirmed =
    order.payment_status === "paid" ||
    order.payment_status === "PAID" ||
    order.status === "confirmed" ||
    order.confirmed_at;

  if (alreadyConfirmed) {
    return { alreadyConfirmed: true, order };
  }

  await client.query(
    `UPDATE orders SET status = 'confirmed', payment_status = 'paid', confirmed_at = NOW() WHERE id = $1`,
    [orderId]
  );

  const itemsResult = await client.query(
    `SELECT
       oi.id AS order_item_id,
       oi.ticket_type_id,
       oi.ticket_name AS tier_name,
       oi.ticket_price_amount,
       oi.ticket_booking_fee_amount,
       oi.quantity,
       oi.buyer_name AS attendee_name,
       oi.buyer_email
     FROM order_items oi
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [orderId]
  );

  const responseItems = [];
  const qtyByTicketType = {};

  for (const item of itemsResult.rows) {
    const qty = item.quantity || 1;
    qtyByTicketType[item.ticket_type_id] = (qtyByTicketType[item.ticket_type_id] || 0) + qty;

    for (let i = 0; i < qty; i++) {
      const ticketInsert = await client.query(
        `INSERT INTO tickets (
           order_item_id,
           order_id,
           event_id,
           ticket_type_id,
           ticket_code,
           buyer_name,
           buyer_email,
           status,
           user_id,
           issued_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,NOW())
         RETURNING id`,
        [
          item.order_item_id,
          orderId,
          order.event_id,
          item.ticket_type_id,
          generateTicketCode(),
          item.attendee_name,
          item.buyer_email || "",
          order.buyer_user_id,
        ]
      );

      const ticketId = ticketInsert.rows[0].id;
      const { qrCodeHash } = buildQR({
        ticketItemId: ticketId,
        orderId,
        eventId: order.event_id,
        buyerId: order.buyer_user_id,
        attendeeName: item.attendee_name,
        tierName: item.tier_name,
      });

      await client.query(`UPDATE tickets SET qr_code_data = $1 WHERE id = $2`, [qrCodeHash, ticketId]);

      const qrCodeUrl = `/api/buyer/tickets/${ticketId}/qr`;
      responseItems.push({
        id: ticketId,
        attendee_name: item.attendee_name,
        tier_name: item.tier_name,
        ticket_price: Number(item.ticket_price_amount) / 100,
        booking_fee: Number(item.ticket_booking_fee_amount) / 100,
        qr_code_hash: qrCodeHash,
        qr_code_url: qrCodeUrl,
      });
    }
  }

  await client.query(
    `UPDATE inventory_reservations
     SET status = 'consumed'
     WHERE order_id = $1 AND status = 'active'`,
    [orderId]
  );

  for (const [ticketTypeId, qty] of Object.entries(qtyByTicketType)) {
    await client.query(`UPDATE ticket_types SET qty_sold = qty_sold + $1 WHERE id = $2`, [qty, ticketTypeId]);
  }

  await client.query(
    `UPDATE events
     SET tickets_sold = (
       SELECT COUNT(*) FROM tickets
       WHERE event_id = $1 AND status = 'ACTIVE'
     )
     WHERE id = $1`,
    [order.event_id]
  );

  const qtyByTierLabel = {};
  for (const item of itemsResult.rows) {
    const tierPricePounds = Number(item.ticket_price_amount) / 100;
    const { tier_label } = resolveTier(tierPricePounds);
    qtyByTierLabel[tier_label] = (qtyByTierLabel[tier_label] || 0) + (item.quantity || 1);
  }

  return {
    alreadyConfirmed: false,
    order,
    responseItems,
    qtyByTierLabel,
  };
}

/**
 * Escrow, booking-fee ledger, tier credit allocation, guru commission (best-effort).
 */
async function runPostFulfillmentSideEffects(order, orderId, qtyByTierLabel) {
  if (!qtyByTierLabel || !order) return;

  try {
    await receiveTicketPayment({
      territory_id: order.territory_id || 1,
      escrow_amount_pence: Number(order.subtotal_amount),
      booking_fee_pence: Number(order.booking_fee_amount),
      buyer_id: order.buyer_user_id,
      order_id: orderId,
      event_id: order.event_id,
    });
  } catch (err) {
    console.error("[orderFulfillment] receiveTicketPayment:", err.message);
    throw err;
  }

  try {
    for (const [tierLabel, qty] of Object.entries(qtyByTierLabel)) {
      await allocateCredit({
        event_id: order.event_id,
        tier_label: Number(tierLabel),
        quantity: qty,
        promoter_id: order.promoter_id,
        guru_id: order.guru_id,
        network_manager_id: order.network_manager_id,
        territory_id: order.territory_id || 1,
        order_id: orderId,
      });
    }
  } catch (err) {
    console.error("[orderFulfillment] allocateCredit:", err.message);
    throw err;
  }

  try {
    await CommissionService.processOrderCommission(orderId);
  } catch (err) {
    console.error("[orderFulfillment] processOrderCommission:", err.message);
  }
}

module.exports = {
  fulfillLockedOrderPaymentSuccess,
  runPostFulfillmentSideEffects,
};
