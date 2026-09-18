const pool = require("../db");
const { ok, fail } = require("../utils/standardResponse");
const crypto = require("crypto");
const CommissionService = require("../services/commission.service");
const CharityPaymentService = require("../services/charityPayment.service");

function verifyWebhookSignature(req, provider) {
  return true;
}

function generateTicketCode() {
  return "TKT-" + crypto.randomBytes(6).toString('hex').toUpperCase();
}

const handlePaymentWebhook = async (req, res) => {
  try {
    const { provider, event, data } = req.body;
    const providerEventId = data?.id || data?.object?.id || req.body.provider_event_id;

    if (!provider || !event) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Provider and event required");
    }

    if (!verifyWebhookSignature(req, provider)) {
      return fail(res, req, 401, "INVALID_SIGNATURE", "Webhook signature verification failed");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Check for idempotency - has this event been processed already?
      if (providerEventId) {
        const existingEvent = await client.query(
          'SELECT id FROM webhook_events WHERE provider = $1 AND event_id = $2',
          [provider, providerEventId]
        );

        if (existingEvent.rowCount > 0) {
          // Event already processed, return success without reprocessing
          await client.query("COMMIT");
          return ok(res, req, {
            received: true,
            processed: false,
            duplicate: true,
            event: event
          });
        }

        // Mark this event as being processed
        await client.query(
          'INSERT INTO webhook_events (provider, event_id, event_type) VALUES ($1, $2, $3)',
          [provider, providerEventId, event]
        );
      }

      switch (event) {
        case 'payment_intent.succeeded':
          await handlePaymentSucceeded(data, client);
          break;
        case 'payment_intent.payment_failed':
          await handlePaymentFailed(data, client);
          break;
        default:
          console.log("Unhandled webhook event: " + event);
      }

      await client.query("COMMIT");

      return ok(res, req, {
        received: true,
        processed: true,
        event: event
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Webhook error:", err);
      return fail(res, req, 500, "INTERNAL_ERROR", "Failed to process webhook");
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: err.message || "Internal server error",
      data: null
    });
  }
};

async function handlePaymentSucceeded(data, client) {
  const paymentIntent = data.object || data;
  const orderId = paymentIntent.metadata ? paymentIntent.metadata.orderId : null;

  if (!orderId) {
    throw new Error("Order ID not found in payment metadata");
  }

  const orderResult = await client.query(
    "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
    [orderId]
  );

  if (orderResult.rowCount === 0) {
    throw new Error("Order not found: " + orderId);
  }

  const order = orderResult.rows[0];

  // Update order status (using PENDING -> PAID naming from documentation)
  await client.query(
    "UPDATE orders SET status = 'PAID', payment_status = 'paid', confirmed_at = NOW() WHERE id = $1",
    [orderId]
  );

  const itemsResult = await client.query(
    "SELECT * FROM order_items WHERE order_id = $1",
    [orderId]
  );

  for (const item of itemsResult.rows) {
    // Mint tickets with event_id from order
    for (let i = 0; i < item.quantity; i++) {
      await client.query(
        `INSERT INTO tickets (
          order_item_id, order_id, event_id, ticket_type_id, ticket_code,
          buyer_name, buyer_email, status, issued_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          item.id,
          order.id,
          order.event_id, // FIXED: Use order.event_id instead of null
          item.ticket_type_id,
          generateTicketCode(),
          item.buyer_name,
          item.buyer_email,
          'ACTIVE'
        ]
      );
    }

    // Consume reservations and increment qty_sold
    await client.query(
      "UPDATE inventory_reservations SET status = 'consumed' WHERE order_id = $1 AND ticket_type_id = $2",
      [orderId, item.ticket_type_id]
    );

    // Increment qty_sold after successful payment
    await client.query(
      "UPDATE ticket_types SET qty_sold = qty_sold + $1 WHERE id = $2",
      [item.quantity, item.ticket_type_id]
    );
  }

  // Update events.tickets_sold with total tickets for this event
  const totalTicketsResult = await client.query(
    "SELECT COUNT(*) as total FROM tickets WHERE event_id = $1 AND status = 'ACTIVE'",
    [order.event_id]
  );
  const totalTickets = parseInt(totalTicketsResult.rows[0].total);

  await client.query(
    "UPDATE events SET tickets_sold = $1 WHERE id = $2",
    [totalTickets, order.event_id]
  );

  console.log("Payment succeeded for order " + orderId);

  // Calculate and record Guru commissions
  try {
    await CommissionService.processOrderCommission(orderId);
    console.log("Commission calculated for order " + orderId);
  } catch (err) {
    console.error('Commission calculation failed:', err);
    // Don't fail the webhook if commission calculation fails
  }
}

async function handlePaymentFailed(data, client) {
  const paymentIntent = data.object || data;
  const orderId = paymentIntent.metadata ? paymentIntent.metadata.orderId : null;

  if (!orderId) {
    throw new Error("Order ID not found in payment metadata");
  }

  await client.query(
    "UPDATE orders SET status = 'FAILED', payment_status = 'failed' WHERE id = $1",
    [orderId]
  );

  // Release inventory reservations
  await client.query(
    "UPDATE inventory_reservations SET status = 'cancelled' WHERE order_id = $1",
    [orderId]
  );

  console.log("Payment failed for order " + orderId);
}

/**
 * Handle charity payment webhook
 * POST /webhooks/charity-payment
 */
const handleCharityPaymentWebhook = async (req, res) => {
  try {
    const { provider, event, data } = req.body;
    const providerEventId = data?.id || data?.object?.id || req.body.provider_event_id;

    if (!provider || !event) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Provider and event required");
    }

    if (!verifyWebhookSignature(req, provider)) {
      return fail(res, req, 401, "INVALID_SIGNATURE", "Webhook signature verification failed");
    }

    try {
      // Process the charity payment webhook event
      const result = await CharityPaymentService.processWebhookEvent(req.body);

      return ok(res, req, {
        received: true,
        processed: true,
        event: event,
        result: result
      });
    } catch (err) {
      console.error("Charity webhook error:", err);
      return fail(res, req, 500, "INTERNAL_ERROR", "Failed to process charity webhook: " + err.message);
    }
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: err.message || "Internal server error",
      data: null
    });
  }
};

module.exports = {
  handlePaymentWebhook,
  handleCharityPaymentWebhook,
};