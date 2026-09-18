const pool = require("../db");
const { getStripe, isStripeConfigured } = require("../services/stripeClient");
const {
  paymentIntentMatchesOrder,
} = require("../services/orderStripePayment.service");
const {
  fulfillLockedOrderPaymentSuccess,
  runPostFulfillmentSideEffects,
} = require("../services/orderFulfillment.service");

/**
 * POST /api/webhooks/stripe
 * Must be registered with express.raw({ type: "application/json" }) before express.json().
 */
async function handleStripeOrdersWebhook(req, res) {
  if (!isStripeConfigured()) {
    return res.status(503).send("Stripe is not configured");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send("STRIPE_WEBHOOK_SECRET is not set");
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("Missing stripe-signature");
  }

  let event;
  try {
    const stripe = getStripe();
    const buf = req.body;
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripeWebhook] signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutSessionCompleted(event);
    } else if (event.type === "payment_intent.succeeded") {
      await handlePaymentIntentSucceeded(event);
    } else if (event.type === "payment_intent.payment_failed") {
      await handlePaymentIntentFailed(event);
    }
  } catch (err) {
    console.error("[stripeWebhook] handler:", err);
    return res.status(500).json({ error: err.message });
  }

  return res.json({ received: true });
}

async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object;
  const orderIdRaw = session.metadata?.orderId;
  const orderId = orderIdRaw != null ? parseInt(orderIdRaw, 10) : NaN;
  if (!orderId || Number.isNaN(orderId)) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `INSERT INTO webhook_events (provider, event_id, event_type) VALUES ($1, $2, $3)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      ["stripe", event.id, event.type]
    );
    if (ins.rowCount === 0) {
      await client.query("COMMIT");
      return;
    }

    const orderResult = await client.query(
      `SELECT o.*, e.territory_id, e.promoter_id, e.guru_id, e.network_manager_id, e.id AS event_id
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE o.id = $1
       FOR UPDATE`,
      [orderId]
    );

    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const order = orderResult.rows[0];
    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : null;

    if (paymentIntentId && order.payment_intent_id !== paymentIntentId) {
      await client.query(
        `UPDATE orders
         SET payment_intent_id = $1, payment_provider = 'stripe', updated_at = NOW()
         WHERE id = $2`,
        [paymentIntentId, orderId]
      );
      order.payment_intent_id = paymentIntentId;
      order.payment_provider = "stripe";
    }

    const result = await fulfillLockedOrderPaymentSuccess(client, order, orderId);
    await client.query("COMMIT");

    if (!result.alreadyConfirmed && result.qtyByTierLabel) {
      await runPostFulfillmentSideEffects(result.order, orderId, result.qtyByTierLabel);
    }
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function handlePaymentIntentSucceeded(event) {
  const pi = event.data.object;
  const orderIdRaw = pi.metadata?.orderId;
  const orderId = orderIdRaw != null ? parseInt(orderIdRaw, 10) : NaN;
  if (!orderId || Number.isNaN(orderId)) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `INSERT INTO webhook_events (provider, event_id, event_type) VALUES ($1, $2, $3)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      ["stripe", event.id, event.type]
    );
    if (ins.rowCount === 0) {
      await client.query("COMMIT");
      return;
    }

    const orderResult = await client.query(
      `SELECT o.*, e.territory_id, e.promoter_id, e.guru_id, e.network_manager_id, e.id AS event_id
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE o.id = $1
       FOR UPDATE`,
      [orderId]
    );

    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error("Order not found: " + orderId);
    }

    const order = orderResult.rows[0];
    if (order.payment_provider !== "stripe") {
      await client.query("ROLLBACK");
      throw new Error("Order payment provider is not stripe");
    }
    if (order.payment_intent_id && order.payment_intent_id !== pi.id) {
      await client.query("ROLLBACK");
      throw new Error("PaymentIntent does not match order");
    }
    if (!order.payment_intent_id) {
      await client.query(
        `UPDATE orders
         SET payment_intent_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [pi.id, orderId]
      );
      order.payment_intent_id = pi.id;
    }
    if (!paymentIntentMatchesOrder(pi, order)) {
      await client.query("ROLLBACK");
      throw new Error("PaymentIntent amount/currency mismatch for order");
    }

    const result = await fulfillLockedOrderPaymentSuccess(client, order, orderId);
    await client.query("COMMIT");

    if (!result.alreadyConfirmed && result.qtyByTierLabel) {
      await runPostFulfillmentSideEffects(result.order, orderId, result.qtyByTierLabel);
    }
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function handlePaymentIntentFailed(event) {
  const pi = event.data.object;
  const orderIdRaw = pi.metadata?.orderId;
  const orderId = orderIdRaw != null ? parseInt(orderIdRaw, 10) : NaN;
  if (!orderId || Number.isNaN(orderId)) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `INSERT INTO webhook_events (provider, event_id, event_type) VALUES ($1, $2, $3)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      ["stripe", event.id, event.type]
    );
    if (ins.rowCount === 0) {
      await client.query("COMMIT");
      return;
    }

    const ordRes = await client.query(
      `SELECT id, payment_intent_id, payment_provider, payment_status, confirmed_at
       FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    if (ordRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return;
    }
    const row = ordRes.rows[0];
    if (row.payment_status === "paid" || row.confirmed_at) {
      await client.query("COMMIT");
      return;
    }
    if (row.payment_provider === "stripe" && row.payment_intent_id && row.payment_intent_id !== pi.id) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `UPDATE inventory_reservations SET status = 'cancelled' WHERE order_id = $1`,
      [orderId]
    );
    await client.query(
      `UPDATE orders SET payment_status = 'failed', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  handleStripeOrdersWebhook,
};
