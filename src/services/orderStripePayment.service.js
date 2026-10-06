const pool = require("../db");
const { getStripe, isStripeConfigured } = require("./stripeClient");

/**
 * Create a Stripe PaymentIntent for a ticket order (amount in smallest currency unit, e.g. pence).
 * Metadata.orderId is used by the webhook to fulfill the order.
 */
async function createPaymentIntentForOrder({
  orderId,
  totalAmountPence,
  currency = "GBP",
  idempotencyKey,
}) {
  const stripe = getStripe();
  const idemp = idempotencyKey ? `order_pi_${orderId}_${idempotencyKey}` : `order_pi_${orderId}`;

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: totalAmountPence,
      currency: currency.toLowerCase(),
      metadata: {
        orderId: String(orderId),
      },
      automatic_payment_methods: { enabled: true },
    },
    { idempotencyKey: idemp }
  );

  return {
    id: paymentIntent.id,
    client_secret: paymentIntent.client_secret,
  };
}

/**
 * Create a Stripe hosted Checkout Session for a ticket order.
 * Metadata.orderId is copied to PaymentIntent via payment_intent_data.metadata.
 */
async function createCheckoutSessionForOrder({
  orderId,
  totalAmountPence,
  currency = "GBP",
  successUrl,
  cancelUrl,
  idempotencyKey,
}) {
  const stripe = getStripe();
  const idemp = idempotencyKey ? `order_cs_${orderId}_${idempotencyKey}` : `order_cs_${orderId}`;
  const lowerCurrency = currency.toLowerCase();

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          price_data: {
            currency: lowerCurrency,
            unit_amount: totalAmountPence,
            product_data: {
              name: `Eventopia Order #${orderId}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        orderId: String(orderId),
      },
      payment_intent_data: {
        metadata: {
          orderId: String(orderId),
        },
      },
    },
    { idempotencyKey: idemp }
  );

  return {
    id: session.id,
    url: session.url || null,
    payment_intent: session.payment_intent || null,
  };
}

/**
 * True if the PaymentIntent from Stripe matches the DB order (amount, currency, id).
 */
function paymentIntentMatchesOrder(paymentIntent, order) {
  if (!paymentIntent || !order) return false;
  const expectedTotal = Number(order.total_amount);
  if (Number(paymentIntent.amount) !== expectedTotal) return false;
  const cur = (paymentIntent.currency || "").toLowerCase();
  const orderCur = (order.currency || "GBP").toLowerCase();
  if (cur !== orderCur) return false;
  if (order.payment_intent_id && paymentIntent.id !== order.payment_intent_id) return false;
  return true;
}

/**
 * After order row exists, attach Stripe PI id and provider.
 */
async function persistStripePaymentIntent(orderId, paymentIntentId) {
  await pool.query(
    `UPDATE orders SET payment_intent_id = $1, payment_provider = 'stripe', updated_at = NOW() WHERE id = $2`,
    [paymentIntentId, orderId]
  );
}

/**
 * Fetch client_secret for an existing PaymentIntent (e.g. idempotent create replay).
 */
async function retrievePaymentIntentClientSecret(paymentIntentId) {
  if (!paymentIntentId || !String(paymentIntentId).startsWith("pi_")) {
    return null;
  }
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (!pi.client_secret) return null;
  const terminal = ["succeeded", "canceled"].includes(pi.status);
  if (terminal) {
    return { client_secret: pi.client_secret, status: pi.status };
  }
  return { client_secret: pi.client_secret, status: pi.status };
}

/**
 * Load PI from Stripe and ensure it succeeded and matches the order (for confirm-after-redirect).
 */
async function assertPaymentIntentSucceededForOrder(order) {
  const stripe = getStripe();
  if (!order.payment_intent_id || !String(order.payment_intent_id).startsWith("pi_")) {
    throw new Error("ORDER_MISSING_STRIPE_INTENT");
  }
  const pi = await stripe.paymentIntents.retrieve(order.payment_intent_id);
  if (pi.status !== "succeeded") {
    const err = new Error("PAYMENT_NOT_SUCCEEDED");
    err.code = "PAYMENT_NOT_SUCCEEDED";
    err.stripeStatus = pi.status;
    throw err;
  }
  if (!paymentIntentMatchesOrder(pi, order)) {
    throw new Error("PAYMENT_AMOUNT_MISMATCH");
  }
  const metaOrderId = pi.metadata?.orderId != null ? parseInt(pi.metadata.orderId, 10) : null;
  if (metaOrderId != null && metaOrderId !== Number(order.id)) {
    throw new Error("PAYMENT_METADATA_MISMATCH");
  }
  return pi;
}

/**
 * Add stripe_client_secret (and optional publishable key) to API order payload when applicable.
 */
async function enrichOrderPaymentFields(orderPayload, row) {
  const out = { ...orderPayload };
  out.payment_provider = row.payment_provider || "stub";
  // Do not put STRIPE_PUBLISHABLE_KEY (pk_...) in this response — configure pk_ on the frontend (.env).
  if (!isStripeConfigured() || row.payment_provider !== "stripe") {
    return out;
  }
  if (!row.payment_intent_id || !String(row.payment_intent_id).startsWith("pi_")) {
    return out;
  }
  try {
    const secretPayload = await retrievePaymentIntentClientSecret(row.payment_intent_id);
    if (secretPayload?.client_secret) {
      out.stripe_client_secret = secretPayload.client_secret;
      out.stripe_payment_status = secretPayload.status;
    }
  } catch (e) {
    console.warn("[orderStripePayment] enrichOrderPaymentFields:", e.message);
  }
  return out;
}

module.exports = {
  createPaymentIntentForOrder,
  createCheckoutSessionForOrder,
  paymentIntentMatchesOrder,
  persistStripePaymentIntent,
  retrievePaymentIntentClientSecret,
  assertPaymentIntentSucceededForOrder,
  enrichOrderPaymentFields,
  isStripeConfigured,
};
