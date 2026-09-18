// orders.controller.js
// Implements ONLY the 5 endpoints defined in Module 3 — Ticket Purchase Flow

const pool = require("../db");
const { getStripe } = require("../services/stripeClient");

const crypto = require("crypto");
const { ok, fail } = require("../utils/standardResponse");
const { signQRHash, verifyQRHash } = require("../utils/ticketQr.util");

const {
  createCheckoutSessionForOrder,
  persistStripePaymentIntent,
  assertPaymentIntentSucceededForOrder,
  enrichOrderPaymentFields,
  isStripeConfigured,
} = require("../services/orderStripePayment.service");
const {
  fulfillLockedOrderPaymentSuccess,
  runPostFulfillmentSideEffects,
} = require("../services/orderFulfillment.service");
const { logTicketAudit } = require("../services/audit.service");
const { logValidationAttempt } = require("../services/validationLog.service");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────
// SERVICE 1 — POST /orders
// ─────────────────────────────────────────────

/**
 * Create a new order in pending status.
 * Auth: required — role: buyer
 *
 * Body:
 *   event_id         uuid (required)
 *   idempotency_key  uuid-v4 (required)
 *   items[]          array (min 1)
 *     ticket_tier_id  uuid
 *     quantity        integer >= 1
 *     attendees[]     array — length must equal quantity
 *       name          string (required, non-empty)
 */
const createOrder = async (req, res) => {
  const client = await pool.connect();
  try {
    const buyerId = req.user.id;
    const { event_id, idempotency_key, items } = req.body;

    // ── Basic validation ──────────────────────────────────────────────────────
    if (!event_id || !idempotency_key || !Array.isArray(items) || items.length === 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Missing required fields: event_id, idempotency_key, items");
    }

    const eventIdNum = parseInt(event_id, 10);
    if (Number.isNaN(eventIdNum) || eventIdNum <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid event_id");
    }

    for (const item of items) {
      if (!item.ticket_tier_id) {
        return fail(res, req, 400, "VALIDATION_ERROR", "Each item requires ticket_tier_id");
      }
      const ticketTypeIdNum = parseInt(item.ticket_tier_id, 10);
      if (Number.isNaN(ticketTypeIdNum) || ticketTypeIdNum <= 0) {
        return fail(res, req, 400, "VALIDATION_ERROR", `Invalid ticket_tier_id: ${item.ticket_tier_id}`);
      }

      const qty = parseInt(item.quantity, 10);
      if (Number.isNaN(qty) || qty < 1) {
        return fail(res, req, 400, "VALIDATION_ERROR", "Each item requires quantity >= 1");
      }

      if (!Array.isArray(item.attendees) || item.attendees.length !== qty) {
        return fail(res, req, 400, "ATTENDEE_NAME_REQUIRED", "Attendees length must equal quantity");
      }

      for (const attendee of item.attendees) {
        if (!attendee?.name || attendee.name.trim() === "") {
          return fail(res, req, 400, "ATTENDEE_NAME_REQUIRED", "Attendee name is required and must be non-empty");
        }
      }
    }

    await client.query("BEGIN");

    // ── Idempotency check ─────────────────────────────────────────────────────
    // Return existing order if same buyer + same key within 15 minutes
    const idempCheck = await client.query(
      `SELECT
         o.id,
         o.subtotal_amount,
         o.booking_fee_amount,
         o.total_amount,
         o.expires_at,
         o.payment_status,
         o.payment_intent_id,
         o.payment_provider,
         (
           SELECT COALESCE(
             json_agg(json_build_object(
               'attendee_name', oi.buyer_name,
               'tier_name', oi.ticket_name,
               'ticket_price', (oi.ticket_price_amount::numeric / 100),
               'booking_fee', (oi.ticket_booking_fee_amount::numeric / 100)
             ) ORDER BY oi.id),
             '[]'::json
           )
           FROM order_items oi
           WHERE oi.order_id = o.id
         ) AS items_json
       FROM orders o
       WHERE o.buyer_user_id = $1
         AND o.idempotency_key = $2
         AND o.created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY o.created_at DESC
       LIMIT 1`,
      [buyerId, idempotency_key]
    );

    if (idempCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      const existing = idempCheck.rows[0];
      const unpaid = existing.payment_status === "unpaid" || existing.payment_status === "UNPAID";
      const noRealPi =
        !existing.payment_intent_id || !String(existing.payment_intent_id).startsWith("pi_");
      if (unpaid && noRealPi && isStripeConfigured()) {
        try {
          const frontendBase = process.env.FRONTEND_URL || "http://localhost:5173";
          const successUrl = `${frontendBase.replace(/\/$/, "")}/checkout/success?order_id=${existing.id}&session_id={CHECKOUT_SESSION_ID}`;
          const cancelUrl = `${frontendBase.replace(/\/$/, "")}/checkout/cancel?order_id=${existing.id}`;
          const { id: sessionId, url: checkoutUrl, payment_intent: piId } = await createCheckoutSessionForOrder({
            orderId: existing.id,
            totalAmountPence: Number(existing.total_amount),
            currency: "GBP",
            successUrl,
            cancelUrl,
            idempotencyKey: idempotency_key,
          });
          if (piId && String(piId).startsWith("pi_")) {
            await persistStripePaymentIntent(existing.id, piId);
            existing.payment_intent_id = piId;
          } else {
            await pool.query(
              `UPDATE orders SET payment_provider = 'stripe', updated_at = NOW() WHERE id = $1`,
              [existing.id]
            );
          }
          existing.payment_provider = "stripe";
          existing.stripe_checkout_session_id = sessionId;
          existing.stripe_checkout_url = checkoutUrl;
        } catch (e) {
          console.error("createOrder: idempotent Stripe attach failed:", e.message);
        }
      }
      const baseOrder = {
        id: existing.id,
        status: "pending",
        total_ticket_amount: Number(existing.subtotal_amount) / 100,
        total_booking_fee: Number(existing.booking_fee_amount) / 100,
        grand_total: Number(existing.total_amount) / 100,
        expires_at: existing.expires_at,
        payment_intent_ref: existing.payment_intent_id,
        items: existing.items_json || [],
      };
      const orderPayload = await enrichOrderPaymentFields(baseOrder, existing);
      if (existing.stripe_checkout_url) {
        orderPayload.stripe_checkout_url = existing.stripe_checkout_url;
        orderPayload.stripe_checkout_session_id = existing.stripe_checkout_session_id || null;
      }
      return ok(res, req, { order: orderPayload }, 200);
    }

    // ── Per-ticket type validation & fee calculation ─────────────────────────
    let totalTicketPence = 0;
    let totalBookingFeePence = 0;
    const resolvedItems = [];

    for (const item of items) {
      const ticketTypeIdNum = parseInt(item.ticket_tier_id, 10);
      const qty = parseInt(item.quantity, 10);
      const attendees = item.attendees.map((a) => a.name.trim());

      const tierResult = await client.query(
        `SELECT
           id, name, price_amount, booking_fee_amount, capacity_total, qty_sold
         FROM ticket_types
         WHERE id = $1 AND event_id = $2
         FOR UPDATE`,
        [ticketTypeIdNum, eventIdNum]
      );

      if (tierResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return fail(res, req, 400, "VALIDATION_ERROR", `Ticket type ${item.ticket_tier_id} not found for this event`);
      }

      const tier = tierResult.rows[0];

      const reservedResult = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS reserved_qty
         FROM inventory_reservations
         WHERE ticket_type_id = $1
           AND status = 'active'
           AND expires_at > NOW()`,
        [tier.id]
      );

      const reservedQty = reservedResult.rows[0]?.reserved_qty ?? 0;
      const capacity = tier.capacity_total ?? 999999;
      const remaining = capacity - tier.qty_sold - reservedQty;

      if (remaining < qty) {
        await client.query("ROLLBACK");
        return fail(
          res,
          req,
          409,
          "QUANTITY_EXCEEDED",
          `Not enough tickets remaining for tier "${tier.name}". Available: ${remaining}`
        );
      }

      totalTicketPence += tier.price_amount * qty;
      totalBookingFeePence += tier.booking_fee_amount * qty;

      resolvedItems.push({
        ticket_type_id: tier.id,
        tier_name: tier.name,
        ticket_price_amount: tier.price_amount,
        ticket_booking_fee_amount: tier.booking_fee_amount,
        quantity: qty,
        attendees,
      });
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    const useStripe = isStripeConfigured();
    const paymentIntentRef = useStripe ? null : "stub_pi_abc123";
    const paymentProviderInsert = useStripe ? "stripe_pending" : "stub";
    const orderNumber = `EVT-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

    const orderInsert = await client.query(
      `INSERT INTO orders (
         order_number,
         buyer_user_id,
         event_id,
         subtotal_amount,
         booking_fee_amount,
         total_amount,
         currency,
         status,
         payment_status,
         payment_intent_id,
         payment_provider,
         expires_at,
         idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,'GBP','payment_pending','unpaid',$7,$8,$9,$10)
       RETURNING id`,
      [
        orderNumber,
        buyerId,
        eventIdNum,
        totalTicketPence,
        totalBookingFeePence,
        totalTicketPence + totalBookingFeePence,
        paymentIntentRef,
        paymentProviderInsert,
        expiresAt,
        idempotency_key,
      ]
    );

    const orderId = orderInsert.rows[0].id;

    // Reserve inventory for active pending order
    for (const item of resolvedItems) {
      await client.query(
        `INSERT INTO inventory_reservations (order_id, ticket_type_id, quantity, expires_at, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [orderId, item.ticket_type_id, item.quantity, expiresAt]
      );
    }

    const responseItems = [];
    const buyerEmail = req.user.email || null;

    // Insert order items: one row per attendee ticket
    for (const item of resolvedItems) {
      for (const attendeeName of item.attendees) {
        await client.query(
          `INSERT INTO order_items (
             order_id,
             ticket_type_id,
             ticket_name,
             ticket_price_amount,
             ticket_booking_fee_amount,
             quantity,
             subtotal_amount,
             buyer_name,
             buyer_email
           ) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)`,
          [
            orderId,
            item.ticket_type_id,
            item.tier_name,
            item.ticket_price_amount,
            item.ticket_booking_fee_amount,
            item.ticket_price_amount + item.ticket_booking_fee_amount,
            attendeeName,
            buyerEmail,
          ]
        );

        responseItems.push({
          attendee_name: attendeeName,
          tier_name: item.tier_name,
          ticket_price: Number(item.ticket_price_amount) / 100,
          booking_fee: Number(item.ticket_booking_fee_amount) / 100,
        });
      }
    }

    await client.query("COMMIT");

    let finalPaymentIntentRef = paymentIntentRef;
    let rowForEnrich = {
      payment_intent_id: paymentIntentRef,
      payment_provider: paymentProviderInsert,
    };
    let baseOrderStripe = null;

    if (useStripe) {
      try {
        const frontendBase = process.env.FRONTEND_URL || "http://localhost:5173";
        const successUrl = `${frontendBase.replace(/\/$/, "")}/checkout/success?order_id=${orderId}&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${frontendBase.replace(/\/$/, "")}/checkout/cancel?order_id=${orderId}`;
        const { id: sessionId, url: checkoutUrl, payment_intent: piId } = await createCheckoutSessionForOrder({
          orderId,
          totalAmountPence: totalTicketPence + totalBookingFeePence,
          currency: "GBP",
          successUrl,
          cancelUrl,
          idempotencyKey: idempotency_key,
        });
        if (piId && String(piId).startsWith("pi_")) {
          await persistStripePaymentIntent(orderId, piId);
          finalPaymentIntentRef = piId;
          rowForEnrich = { payment_intent_id: piId, payment_provider: "stripe" };
        } else {
          await pool.query(
            `UPDATE orders
             SET payment_provider = 'stripe', updated_at = NOW()
             WHERE id = $1`,
            [orderId]
          );
          finalPaymentIntentRef = null;
          rowForEnrich = { payment_intent_id: null, payment_provider: "stripe" };
        }
        baseOrderStripe = {
          stripe_checkout_url: checkoutUrl,
          stripe_checkout_session_id: sessionId,
        };
      } catch (stripeErr) {
        console.error("createOrder: Stripe Checkout session failed:", stripeErr);
        return fail(
          res,
          req,
          503,
          "PAYMENT_SETUP_FAILED",
          "Could not start payment. Please try again or contact support."
        );
      }
    }

    const baseOrder = {
      id: orderId,
      status: "pending",
      total_ticket_amount: totalTicketPence / 100,
      total_booking_fee: totalBookingFeePence / 100,
      grand_total: (totalTicketPence + totalBookingFeePence) / 100,
      expires_at: expiresAt,
      payment_intent_ref: finalPaymentIntentRef,
      items: responseItems,
    };
    const orderPayload = await enrichOrderPaymentFields(baseOrder, rowForEnrich);
    if (useStripe && typeof baseOrderStripe === "object") {
      orderPayload.stripe_checkout_url = baseOrderStripe.stripe_checkout_url || null;
      orderPayload.stripe_checkout_session_id = baseOrderStripe.stripe_checkout_session_id || null;
    }
    return ok(res, req, { order: orderPayload }, 201);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createOrder error:", err);
    return res.status(500).json({ error: true, message: err.message || "Internal server error", data: null });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// SERVICE 2 — POST /orders/:id/confirm
// ─────────────────────────────────────────────

/**
 * Confirms payment success or failure.
 * Auth: System call (PaymentService stub in Phase 1 / live webhook in production).
 *
 * Body:
 *   payment_ref     string  (must match order's payment_intent_ref)
 *   payment_status  "success" | "failure"
 *
 * On success:
 *   - Order → completed
 *   - QR codes generated per order_item
 *   - escrow_ledger credit entry (total_ticket_amount)
 *   - operating_ledger credit entry (total_booking_fee)
 *   - ticket_tier.quantity_sold incremented
 *   - audit_ledger entries written
 *   - Confirmation email queued
 */
const confirmOrder = async (req, res) => {
  const client = await pool.connect();
  const startedAt = Date.now();
  try {
    const orderId = parseInt(req.params.id, 10);
    console.log("[confirmOrder:start]", {
      orderId: req.params.id,
      parsedOrderId: orderId,
      payment_status: req.body?.payment_status,
      payment_ref: req.body?.payment_ref,
      userId: req.user?.id,
    });
    if (Number.isNaN(orderId) || orderId <= 0) {
      console.log("[confirmOrder:invalid-order-id]", { orderId: req.params.id, ms: Date.now() - startedAt });
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid order id");
    }
    const { payment_ref, payment_status } = req.body;

    // ── payment_status = failure → short circuit ──────────────────────────────
    if (payment_status === "failure") {
      await client.query("BEGIN");
      // Release inventory reservations for this pending order
      await client.query(
        `UPDATE inventory_reservations
         SET status = 'cancelled'
         WHERE order_id = $1`,
        [orderId]
      );
      await client.query(
        `UPDATE orders
         SET payment_status = 'failed'
         WHERE id = $1`,
        [orderId]
      );
      await client.query("COMMIT");
      console.log("[confirmOrder:payment-failure-handled]", { orderId, ms: Date.now() - startedAt });

      return fail(res, req, 400, "PAYMENT_FAILED", "Payment failed. Order remains pending. No escrow entry created.");
    }

    if (payment_status !== "success") {
      console.log("[confirmOrder:invalid-payment-status]", { orderId, payment_status, ms: Date.now() - startedAt });
      return fail(res, req, 400, "VALIDATION_ERROR", "payment_status must be 'success' or 'failure'");
    }

    console.log("[confirmOrder:before-begin]", { orderId, ms: Date.now() - startedAt });
    await client.query("BEGIN");
    console.log("[confirmOrder:after-begin]", { orderId, ms: Date.now() - startedAt });

    // ── Fetch order ───────────────────────────────────────────────────────────
    console.log("[confirmOrder:before-fetch-order-for-update]", { orderId, ms: Date.now() - startedAt });
    let orderResult;
    try {
      orderResult = await client.query(
        `SELECT
           o.*,
           e.territory_id,
           e.promoter_id,
           e.guru_id,
           e.network_manager_id,
           e.id AS event_id
         FROM orders o
         JOIN events e ON e.id = o.event_id
         WHERE o.id = $1
         FOR UPDATE NOWAIT`,
        [orderId]
      );
    } catch (lockErr) {
      // PostgreSQL 55P03 = lock_not_available (row currently locked by another tx)
      if (lockErr?.code === "55P03") {
        await client.query("ROLLBACK");
        console.warn("[confirmOrder:order-row-locked]", { orderId, ms: Date.now() - startedAt });

        // Avoid surfacing an error for normal concurrent confirms.
        // Return current order state so clients can poll until completed.
        const currentOrderResult = await pool.query(
          `SELECT id, status, payment_status, confirmed_at
           FROM orders
           WHERE id = $1`,
          [orderId]
        );

        if (currentOrderResult.rowCount === 0) {
          return fail(res, req, 404, "ORDER_NOT_FOUND", "Order not found");
        }

        const currentOrder = currentOrderResult.rows[0];
        const isCompleted =
          currentOrder.payment_status === "paid" ||
          currentOrder.status === "confirmed" ||
          !!currentOrder.confirmed_at;

        if (isCompleted) {
          return ok(
            res,
            req,
            {
              order: {
                id: currentOrder.id,
                status: "completed",
              },
              processing: false,
            },
            200
          );
        }

        // Hide transient lock contention from client:
        // wait briefly for the in-flight confirmation to finish, then return final status.
        const maxWaitMs = 6000;
        const stepMs = 300;
        let waitedMs = 0;
        while (waitedMs < maxWaitMs) {
          await sleep(stepMs);
          waitedMs += stepMs;
          const polled = await pool.query(
            `SELECT id, status, payment_status, confirmed_at
             FROM orders
             WHERE id = $1`,
            [orderId]
          );
          if (polled.rowCount === 0) break;
          const row = polled.rows[0];
          const done =
            row.payment_status === "paid" ||
            row.status === "confirmed" ||
            !!row.confirmed_at;
          if (done) {
            console.log("[confirmOrder:lock-resolved-after-wait]", {
              orderId,
              waitedMs,
              ms: Date.now() - startedAt,
            });
            return ok(
              res,
              req,
              {
                order: {
                  id: row.id,
                  status: "completed",
                },
                processing: false,
              },
              200
            );
          }
        }

        // Fallback if still not complete after short wait window.
        return fail(
          res,
          req,
          409,
          "ORDER_PROCESSING",
          "Order is currently being processed by another request. Please retry shortly."
        );
      }
      throw lockErr;
    }
    console.log("[confirmOrder:after-fetch-order-for-update]", {
      orderId,
      rowCount: orderResult.rowCount,
      ms: Date.now() - startedAt,
    });

    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log("[confirmOrder:order-not-found]", { orderId, ms: Date.now() - startedAt });
      return fail(res, req, 404, "ORDER_NOT_FOUND", "Order not found");
    }

    const order = orderResult.rows[0];

    const isAdmin = Array.isArray(req.userRoles) && req.userRoles.includes("admin");
    if (order.buyer_user_id !== req.user.id && !isAdmin) {
      await client.query("ROLLBACK");
      return fail(res, req, 403, "FORBIDDEN", "You cannot confirm this order");
    }

    const isStripeOrder =
      order.payment_provider === "stripe" ||
      (order.payment_intent_id && String(order.payment_intent_id).startsWith("pi_"));

    const alreadyConfirmed =
      order.payment_status === "paid" ||
      order.payment_status === "PAID" ||
      order.status === "confirmed" ||
      order.confirmed_at;

    if (alreadyConfirmed) {
      await client.query("ROLLBACK");
      console.log("[confirmOrder:already-confirmed]", { orderId, ms: Date.now() - startedAt });
      if (isStripeOrder) {
        return ok(res, req, {
          order: { id: order.id, status: "completed" },
          already_completed: true,
          escrow_entry_created: true,
          confirmation_email_sent: false,
        });
      }
      return fail(res, req, 400, "ALREADY_COMPLETED", "Order already confirmed");
    }

    if (isStripeOrder) {
      if (!isStripeConfigured()) {
        await client.query("ROLLBACK");
        return fail(res, req, 503, "STRIPE_NOT_CONFIGURED", "Stripe is not configured");
      }

      if (!order.payment_intent_id) {
        const checkoutSessionId =
          typeof payment_ref === "string" && payment_ref.startsWith("cs_")
            ? payment_ref
            : null;

        if (checkoutSessionId) {
          try {
            console.log("[BACKEND][confirmOrder][stripe-session-verify-start]", {
              orderId: order.id,
              checkoutSessionId,
            });
            const stripe = getStripe();
            const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
              expand: ["payment_intent"],
            });

            const metaOrderId = session?.metadata?.orderId
              ? parseInt(session.metadata.orderId, 10)
              : null;
            if (metaOrderId && metaOrderId !== Number(order.id)) {
              console.warn("[BACKEND][confirmOrder][stripe-session-metadata-mismatch]", {
                orderId: order.id,
                checkoutSessionId,
                metadataOrderId: metaOrderId,
              });
              await client.query("ROLLBACK");
              return fail(res, req, 400, "PAYMENT_VERIFICATION_FAILED", "Checkout session metadata mismatch");
            }
            if (session.payment_status !== "paid") {
              console.warn("[BACKEND][confirmOrder][stripe-session-not-paid]", {
                orderId: order.id,
                checkoutSessionId,
                sessionPaymentStatus: session.payment_status,
              });
              await client.query("ROLLBACK");
              return fail(res, req, 402, "PAYMENT_PENDING", `Checkout session status: ${session.payment_status || "unknown"}`);
            }

            const piId =
              typeof session.payment_intent === "string"
                ? session.payment_intent
                : session.payment_intent?.id || null;

            if (!piId || !String(piId).startsWith("pi_")) {
              console.warn("[BACKEND][confirmOrder][stripe-session-missing-payment-intent]", {
                orderId: order.id,
                checkoutSessionId,
                paymentIntentType: typeof session.payment_intent,
              });
              await client.query("ROLLBACK");
              return fail(res, req, 402, "PAYMENT_PENDING", "Payment intent is not ready yet");
            }

            await client.query(
              `UPDATE orders
               SET payment_intent_id = $1, payment_provider = 'stripe', updated_at = NOW()
               WHERE id = $2`,
              [piId, order.id]
            );
            order.payment_intent_id = piId;
            order.payment_provider = "stripe";
            console.log("[BACKEND][confirmOrder][stripe-session-verify-success]", {
              orderId: order.id,
              checkoutSessionId,
              paymentIntentId: piId,
            });
          } catch (sessionErr) {
            console.error("[BACKEND][confirmOrder][stripe-session-verify-failed]", {
              orderId: order.id,
              checkoutSessionId,
              message: sessionErr?.message,
              code: sessionErr?.code,
              type: sessionErr?.type,
            });
            await client.query("ROLLBACK");
            return fail(
              res,
              req,
              400,
              "PAYMENT_VERIFICATION_FAILED",
              sessionErr?.message || "Could not verify Stripe checkout session"
            );
          }
        } else {
          console.warn("[BACKEND][confirmOrder][stripe-missing-payment-ref]", {
            orderId: order.id,
            paymentProvider: order.payment_provider,
            paymentIntentId: order.payment_intent_id || null,
            incomingPaymentRef: payment_ref || null,
          });
          await client.query("ROLLBACK");
          return fail(
            res,
            req,
            409,
            "ORDER_NOT_READY",
            "Payment is still being finalized. Please retry in a moment."
          );
        }
      }

      try {
        await assertPaymentIntentSucceededForOrder(order);
      } catch (e) {
        await client.query("ROLLBACK");
        if (e.code === "PAYMENT_NOT_SUCCEEDED") {
          return fail(res, req, 402, "PAYMENT_PENDING", `Payment status: ${e.stripeStatus || "unknown"}`);
        }
        return fail(res, req, 400, "PAYMENT_VERIFICATION_FAILED", e.message || "Payment verification failed");
      }
    } else {
      if (order.payment_intent_id !== payment_ref) {
        await client.query("ROLLBACK");
        console.log("[confirmOrder:payment-ref-mismatch]", { orderId, ms: Date.now() - startedAt });
        return fail(res, req, 400, "VALIDATION_ERROR", "payment_ref does not match order");
      }
    }

    console.log("[confirmOrder:before-fulfill]", { orderId, ms: Date.now() - startedAt });
    const fulfillResult = await fulfillLockedOrderPaymentSuccess(client, order, orderId);
    console.log("[confirmOrder:before-commit]", {
      orderId,
      mintedTickets: fulfillResult.responseItems?.length ?? 0,
      alreadyConfirmed: fulfillResult.alreadyConfirmed,
      ms: Date.now() - startedAt,
    });
    await client.query("COMMIT");
    console.log("[confirmOrder:after-commit]", { orderId, ms: Date.now() - startedAt });

    let escrowEntryCreated = true;
    if (!fulfillResult.alreadyConfirmed && fulfillResult.qtyByTierLabel) {
      try {
        await runPostFulfillmentSideEffects(fulfillResult.order, orderId, fulfillResult.qtyByTierLabel);
      } catch (sideEffectErr) {
        escrowEntryCreated = false;
        console.error("[confirmOrder:post-commit-side-effect-error]", {
          orderId,
          message: sideEffectErr?.message,
          ms: Date.now() - startedAt,
        });
      }
    }

    console.log("[confirmOrder:done]", { orderId, ms: Date.now() - startedAt, escrowEntryCreated });

    return ok(res, req, {
      order: {
        id: order.id,
        status: "completed",
        items: fulfillResult.responseItems || [],
      },
      escrow_entry_created: escrowEntryCreated,
      confirmation_email_sent: false,
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("confirmOrder error:", err);
    console.error("[confirmOrder:exception]", {
      orderId: req.params?.id,
      message: err?.message,
      ms: Date.now() - startedAt,
    });
    return res.status(500).json({ error: true, message: err.message || "Internal server error", data: null });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// SERVICE 3 — GET /buyer/tickets
// ─────────────────────────────────────────────

/**
 * Returns all tickets for the authenticated buyer, grouped by event.
 * Auth: required — role: buyer
 *
 * Query params:
 *   status  active | used | cancelled  (optional)
 *   page    integer (default 1)
 *   limit   integer (default 20)
 */
const getBuyerTickets = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const { status, page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const params = [buyerId];
    let paramIdx = 2;

    // Module 3 status values -> DB ticket status values
    let ticketStatusFilter = "";
    if (status) {
      if (status === "active") ticketStatusFilter = "AND t.status = 'ACTIVE'";
      else if (status === "used") ticketStatusFilter = "AND t.status = 'USED'";
      else if (status === "cancelled") ticketStatusFilter = "AND t.status IN ('CANCELLED','VOID')";
      else return fail(res, req, 400, "VALIDATION_ERROR", "Invalid status filter");
    }

    const query = `
      SELECT
        e.id AS event_id,
        e.title AS event_title,
        e.start_at AS event_date,
        TO_CHAR(e.start_at, 'HH24:MI') AS event_start_time,
        e.venue_name,
        e.status AS event_status,
        o.id AS order_id,
        o.created_at AS order_created_at,
        (o.subtotal_amount::numeric / 100) AS total_ticket_amount,
        (o.booking_fee_amount::numeric / 100) AS total_booking_fee,
        (o.total_amount::numeric / 100) AS grand_total,
        t.id AS ticket_id,
        t.buyer_name AS attendee_name,
        oi.ticket_name AS tier_name,
        (oi.ticket_price_amount::numeric / 100) AS ticket_price,
        (oi.ticket_booking_fee_amount::numeric / 100) AS booking_fee,
        t.status AS ticket_status
      FROM tickets t
      JOIN orders o ON o.id = t.order_id
      JOIN events e ON e.id = o.event_id
      JOIN order_items oi ON oi.id = t.order_item_id
      WHERE o.buyer_user_id = $1
        AND o.payment_status = 'paid'
        ${ticketStatusFilter}
      ORDER BY e.start_at DESC, o.id DESC, t.id DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(limitNum, offset);

    const result = await pool.query(query, params);

    const eventMap = new Map(); // key = event_id:order_id
    for (const row of result.rows) {
      const key = `${row.event_id}:${row.order_id}`;
      if (!eventMap.has(key)) {
        eventMap.set(key, {
          event: {
            id: row.event_id,
            title: row.event_title,
            date: row.event_date ? String(row.event_date) : null,
            start_time: row.event_start_time,
            venue_name: row.venue_name,
            status: row.event_status,
          },
          order: {
            id: row.order_id,
            created_at: row.order_created_at,
            total_ticket_amount: Number(row.total_ticket_amount),
            total_booking_fee: Number(row.total_booking_fee),
            grand_total: Number(row.grand_total),
          },
          tickets: [],
        });
      }

      const apiTicketStatus =
        row.ticket_status === "ACTIVE"
          ? "active"
          : row.ticket_status === "USED"
            ? "used"
            : row.ticket_status === "REFUNDED"
              ? "refunded"
              : "cancelled";

      eventMap.get(key).tickets.push({
        id: row.ticket_id,
        attendee_name: row.attendee_name,
        tier_name: row.tier_name,
        ticket_price: Number(row.ticket_price),
        booking_fee: Number(row.booking_fee),
        status: apiTicketStatus,
        // Document route: GET /api/buyer/tickets/:itemId/qr
        qr_code_url: `/api/buyer/tickets/${row.ticket_id}/qr`,
      });
    }

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM tickets t
      JOIN orders o ON o.id = t.order_id
      JOIN events e ON e.id = o.event_id
      JOIN order_items oi ON oi.id = t.order_item_id
      WHERE o.buyer_user_id = $1
        AND o.payment_status = 'paid'
        ${ticketStatusFilter}
    `;
    const countResult = await pool.query(countQuery, [buyerId]);
    const total = parseInt(countResult.rows[0].total, 10);

    return ok(res, req, {
      data: Array.from(eventMap.values()),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum)
      }
    });

  } catch (err) {
    console.error("getBuyerTickets error:", err);
    return res.status(500).json({ error: true, message: err.message || "Internal server error", data: null });
  }
};

/**
 * Refund Centre Step 1 — list cancelled-event tickets for buyer.
 * GET /api/orders/buyer/tickets/cancelled-events
 */
const getBuyerCancelledEventTickets = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const { page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    console.log("[getBuyerCancelledEventTickets:start]", {
      buyerId,
      page: pageNum,
      limit: limitNum,
      offset,
    });

    const [ownedAnyTicketsCount, cancelledOwnedTicketsCount, paidCancelledOwnedTicketsCount] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM tickets t
         JOIN orders o ON o.id = t.order_id
         WHERE (o.buyer_user_id = $1 OR t.user_id = $1)`,
        [buyerId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM tickets t
         JOIN orders o ON o.id = t.order_id
         JOIN events e ON e.id = o.event_id
         WHERE (o.buyer_user_id = $1 OR t.user_id = $1)
           AND e.status = 'cancelled'`,
        [buyerId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM tickets t
         JOIN orders o ON o.id = t.order_id
         JOIN events e ON e.id = o.event_id
         WHERE (o.buyer_user_id = $1 OR t.user_id = $1)
           AND e.status = 'cancelled'
           AND o.payment_status IN ('paid', 'completed', 'succeeded')`,
        [buyerId]
      ),
    ]);

    console.log("[getBuyerCancelledEventTickets:stage-counts]", {
      buyerId,
      ownedAnyTickets: ownedAnyTicketsCount.rows[0]?.total ?? 0,
      cancelledOwnedTickets: cancelledOwnedTicketsCount.rows[0]?.total ?? 0,
      paidCancelledOwnedTickets: paidCancelledOwnedTicketsCount.rows[0]?.total ?? 0,
    });

    const sampleResult = await pool.query(
      `SELECT
         t.id AS ticket_id,
         t.user_id AS ticket_user_id,
         o.id AS order_id,
         o.buyer_user_id,
         o.payment_status,
         e.id AS event_id,
         e.status AS event_status
       FROM tickets t
       JOIN orders o ON o.id = t.order_id
       JOIN events e ON e.id = o.event_id
       WHERE (o.buyer_user_id = $1 OR t.user_id = $1)
       ORDER BY t.id DESC
       LIMIT 3`,
      [buyerId]
    );
    console.log("[getBuyerCancelledEventTickets:sample-owned]", sampleResult.rows);

    const result = await pool.query(
      `SELECT
         e.id AS event_id,
         e.title AS event_title,
         e.start_at AS event_date,
         e.venue_name,
         e.city_display,
         e.cancelled_at,
         e.cancel_reason,
         t.id AS ticket_id,
         t.status AS ticket_status,
         t.buyer_name AS attendee_name,
         oi.id AS order_item_id,
         oi.ticket_name AS tier_name,
         oi.ticket_price_amount,
         oi.ticket_booking_fee_amount,
         o.id AS order_id,
         o.order_number,
         o.created_at AS purchased_at
       FROM tickets t
       JOIN orders o ON o.id = t.order_id
       JOIN events e ON e.id = o.event_id
       JOIN order_items oi ON oi.id = t.order_item_id
       WHERE (o.buyer_user_id = $1 OR t.user_id = $1)
         AND o.payment_status IN ('paid', 'completed', 'succeeded')
         AND e.status = 'cancelled'
       ORDER BY e.cancelled_at DESC NULLS LAST, e.id DESC, t.id DESC
       LIMIT $2 OFFSET $3`,
      [buyerId, limitNum, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM tickets t
       JOIN orders o ON o.id = t.order_id
       JOIN events e ON e.id = o.event_id
       JOIN order_items oi ON oi.id = t.order_item_id
       WHERE (o.buyer_user_id = $1 OR t.user_id = $1)
         AND o.payment_status IN ('paid', 'completed', 'succeeded')
         AND e.status = 'cancelled'`,
      [buyerId]
    );
    const total = parseInt(countResult.rows[0].total, 10);
    console.log("[getBuyerCancelledEventTickets:final-count]", { buyerId, total });

    const nowMs = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    const items = result.rows.map((row) => {
      const cancelledAt = row.cancelled_at ? new Date(row.cancelled_at) : null;
      const cancelledAtMs = cancelledAt ? cancelledAt.getTime() : null;
      const primaryWindowEndsAt = cancelledAtMs ? new Date(cancelledAtMs + 30 * DAY_MS) : null;

      let refundWindowStage = "unknown";
      let daysLeftInCurrentWindow = null;
      if (primaryWindowEndsAt && nowMs <= primaryWindowEndsAt.getTime()) {
        refundWindowStage = "primary";
        daysLeftInCurrentWindow = Math.ceil((primaryWindowEndsAt.getTime() - nowMs) / DAY_MS);
      } else if (primaryWindowEndsAt) {
        refundWindowStage = "closed";
        daysLeftInCurrentWindow = 0;
      }

      const ticketStatus = String(row.ticket_status || "").toUpperCase();
      const alreadyRefunded = ticketStatus === "REFUNDED";
      const eligibleWindowOpen = refundWindowStage === "primary";
      const canRequestRefund = eligibleWindowOpen && !alreadyRefunded;

      return {
        event: {
          id: row.event_id,
          title: row.event_title,
          date: row.event_date,
          venue_name: row.venue_name,
          city: row.city_display,
          status: "cancelled",
          cancelled_at: row.cancelled_at,
          cancel_reason: row.cancel_reason || null,
        },
        ticket: {
          id: row.ticket_id,
          order_item_id: row.order_item_id,
          order_id: row.order_id,
          order_number: row.order_number,
          attendee_name: row.attendee_name,
          tier_name: row.tier_name,
          ticket_price: Number(row.ticket_price_amount || 0) / 100,
          booking_fee: Number(row.ticket_booking_fee_amount || 0) / 100,
          status: ticketStatus.toLowerCase(),
          purchased_at: row.purchased_at,
        },
        refund_window: {
          stage: refundWindowStage,
          primary_window_days: 30,
          primary_window_ends_at: primaryWindowEndsAt ? primaryWindowEndsAt.toISOString() : null,
          days_left_in_current_window: daysLeftInCurrentWindow,
          can_request_refund: canRequestRefund,
        },
      };
    });

    return ok(res, req, {
      items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("getBuyerCancelledEventTickets error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message || "Failed to fetch cancelled events");
  }
};

/**
 * Refund Centre Step 2 (Phase 1) — submit buyer refund request.
 * POST /api/orders/buyer/refunds
 */
const submitBuyerRefund = async (req, res) => {
  const client = await pool.connect();
  try {
    const buyerId = req.user.id;
    const { order_item_id, reason_code } = req.body || {};
    const orderItemId = parseInt(order_item_id, 10);

    if (Number.isNaN(orderItemId) || orderItemId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Valid order_item_id is required");
    }
    if (!reason_code) {
      return fail(res, req, 400, "VALIDATION_ERROR", "reason_code is required");
    }

    await client.query("BEGIN");

    const itemResult = await client.query(
      `SELECT
         oi.id AS order_item_id,
         oi.ticket_price_amount,
         oi.ticket_booking_fee_amount,
         oi.quantity,
         o.id AS order_id,
         o.buyer_user_id,
         o.payment_status,
         e.id AS event_id,
         e.status AS event_status,
         e.cancelled_at,
         e.promoter_id,
         e.territory_id
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN ticket_types tt ON tt.id = oi.ticket_type_id
       JOIN events e ON e.id = tt.event_id
       WHERE oi.id = $1
       LIMIT 1`,
      [orderItemId]
    );

    if (itemResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 404, "NOT_FOUND", "Order item not found");
    }

    const item = itemResult.rows[0];
    if (String(item.buyer_user_id) !== String(buyerId)) {
      await client.query("ROLLBACK");
      return fail(res, req, 403, "FORBIDDEN", "Order item does not belong to buyer");
    }
    if (!["paid", "completed", "succeeded"].includes(String(item.payment_status || "").toLowerCase())) {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Only paid orders can be refunded");
    }
    if (item.event_status !== "cancelled") {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Refund request allowed only for cancelled events");
    }
    if (!item.cancelled_at) {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "INVALID_STATE", "Refund window unavailable for this event");
    }

    const cancelledAtMs = new Date(item.cancelled_at).getTime();
    const primaryWindowEndMs = cancelledAtMs + (30 * 24 * 60 * 60 * 1000);
    if (Date.now() > primaryWindowEndMs) {
      await client.query("ROLLBACK");
      return fail(res, req, 400, "REFUND_WINDOW_CLOSED", "Primary refund window has closed");
    }

    const duplicateResult = await client.query(
      `SELECT id
       FROM refund_cases
       WHERE order_item_id = $1
         AND status IN ('submitted', 'under_review', 'approved', 'processing')
       LIMIT 1`,
      [orderItemId]
    );
    if (duplicateResult.rowCount > 0) {
      await client.query("ROLLBACK");
      return fail(res, req, 409, "DUPLICATE_REFUND_CASE", "An open refund case already exists for this order item");
    }

    const refundableAmount = Number(item.ticket_price_amount || 0) * Number(item.quantity || 1);

    // Escrow ring-fence: reserve amount in escrow pending liabilities.
    const territoryId = item.territory_id || 1;
    const escrowColumnsResult = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'escrow_accounts'`
    );
    const escrowColumns = new Set(escrowColumnsResult.rows.map((r) => r.column_name));
    const hasAccountType = escrowColumns.has("account_type");
    const hasBalance = escrowColumns.has("balance");
    const hasCurrentBalance = escrowColumns.has("current_balance");
    const hasPendingLiabilities = escrowColumns.has("pending_liabilities");

    if (hasAccountType) {
      await client.query(
        `INSERT INTO escrow_accounts (territory_id, account_type, current_balance, pending_liabilities, updated_at)
         VALUES ($1, 'escrow', 0, 0, NOW())
         ON CONFLICT (territory_id, account_type) DO NOTHING`,
        [territoryId]
      );
    } else {
      await client.query(
        `INSERT INTO escrow_accounts (territory_id, balance, pending_liabilities, updated_at)
         VALUES ($1, 0, 0, NOW())
         ON CONFLICT (territory_id) DO NOTHING`,
        [territoryId]
      );
    }

    const escrowResult = await client.query(
      hasAccountType
        ? `SELECT
             COALESCE(current_balance, 0) AS current_balance,
             COALESCE(pending_liabilities, 0) AS pending_liabilities
           FROM escrow_accounts
           WHERE territory_id = $1 AND account_type = 'escrow'
           LIMIT 1`
        : `SELECT
             COALESCE(balance, 0) AS balance,
             COALESCE(pending_liabilities, 0) AS pending_liabilities
           FROM escrow_accounts
           WHERE territory_id = $1
           LIMIT 1`,
      [territoryId]
    );

    const escrowRow = escrowResult.rows[0] || {};
    const currentBalancePence = hasBalance
      ? Number(escrowRow.balance || 0)
      : Number(escrowRow.current_balance || 0) * 100;
    const pendingLiabilitiesPence = Number(escrowRow.pending_liabilities || 0) * (hasBalance ? 1 : 100);
    if ((currentBalancePence - pendingLiabilitiesPence) < refundableAmount) {
      await client.query("ROLLBACK");
      return fail(res, req, 409, "INSUFFICIENT_ESCROW", "Insufficient escrow balance to ring-fence refund amount");
    }

    if (hasPendingLiabilities) {
      if (hasBalance) {
        await client.query(
          `UPDATE escrow_accounts
           SET pending_liabilities = COALESCE(pending_liabilities, 0) + $1,
               updated_at = NOW()
           WHERE territory_id = $2`,
          [refundableAmount, territoryId]
        );
      } else if (hasCurrentBalance) {
        const amountInCurrency = refundableAmount / 100;
        await client.query(
          `UPDATE escrow_accounts
           SET pending_liabilities = COALESCE(pending_liabilities, 0) + $1,
               updated_at = NOW()
           WHERE territory_id = $2
             AND account_type = 'escrow'`,
          [amountInCurrency, territoryId]
        );
      }
    }

    await client.query(
      `INSERT INTO ledger_entries (
         entry_type, user_id, role, territory_id, amount, reference_id, reference_type, status
       )
       VALUES ('RING_FENCED', $1, 'buyer', $2, $3, $4, 'REFUND_CASE', 'POSTED')`,
      [buyerId, territoryId, -Math.abs(refundableAmount), orderItemId]
    );

    const refundCaseResult = await client.query(
      `INSERT INTO refund_cases (
         order_item_id, buyer_id, event_id, promoter_id, reason_code, status, amount, escrow_ring_fenced, submitted_at, created_at
       )
       VALUES ($1, $2, $3, $4, $5, 'submitted', $6, TRUE, NOW(), NOW())
       RETURNING id, order_item_id, reason_code, status, amount, escrow_ring_fenced, submitted_at`,
      [orderItemId, buyerId, item.event_id, item.promoter_id, reason_code, refundableAmount]
    );

    await client.query("COMMIT");

    const refundCase = refundCaseResult.rows[0];
    return ok(res, req, {
      refund_case: {
        id: refundCase.id,
        order_item_id: refundCase.order_item_id,
        reason_code: refundCase.reason_code,
        status: refundCase.status,
        amount: Number(refundCase.amount) / 100,
        escrow_ring_fenced: refundCase.escrow_ring_fenced,
        submitted_at: refundCase.submitted_at,
      },
      message: "Refund request submitted successfully",
    }, 201);
  } catch (err) {
    await client.query("ROLLBACK");
    if (String(err.message || "").includes("uq_refund_cases_open_order_item")) {
      return fail(res, req, 409, "DUPLICATE_REFUND_CASE", "An open refund case already exists for this order item");
    }
    console.error("submitBuyerRefund error:", err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// SERVICE 4 — GET /buyer/tickets/:itemId/qr
// ─────────────────────────────────────────────

/**
 * Returns QR code data and signed hash for a specific ticket item.
 * Auth: required — role: buyer. Must own the ticket item.
 *
 * Response:
 *   ticket_item_id   uuid
 *   qr_code_hash     string (sha256 signed hash)
 *   qr_payload       { ticket_item_id, order_id, event_id, buyer_id, attendee_name, tier_name }
 *   qr_image_base64  string (data:image/png;base64,...)
 *   status           active | used | refunded
 */
const getTicketQR = async (req, res) => {
  try {
    const { itemId } = req.params;
    const buyerId = req.user.id;
    const ticketId = parseInt(itemId, 10);
    if (Number.isNaN(ticketId) || ticketId <= 0) {
      return fail(res, req, 404, "TICKET_NOT_FOUND", "Ticket does not exist or does not belong to this buyer");
    }

    const result = await pool.query(
      `SELECT
         t.id,
         t.buyer_name,
         t.qr_code_data,
         t.status AS ticket_status,
         t.event_id,
         t.order_id,
         o.buyer_user_id,
         oi.ticket_name AS tier_name
       FROM tickets t
       JOIN orders o ON o.id = t.order_id
       JOIN order_items oi ON oi.id = t.order_item_id
       WHERE t.id = $1`,
      [ticketId]
    );

    if (result.rowCount === 0) {
      return fail(res, req, 404, "TICKET_NOT_FOUND",
        "Ticket does not exist or does not belong to this buyer");
    }

    const item = result.rows[0];

    if (item.buyer_user_id !== buyerId) {
      return fail(res, req, 404, "TICKET_NOT_FOUND",
        "Ticket does not exist or does not belong to this buyer");
    }

    const qrPayload = {
      ticket_item_id: item.id,
      order_id: item.order_id,
      event_id: item.event_id,
      buyer_id: buyerId,
      attendee_name: item.buyer_name,
      tier_name: item.tier_name,
    };

    // Use stored qr_code_data if present, otherwise re-derive
    const qrCodeHash = item.qr_code_data || signQRHash(qrPayload);

    // Generate QR image as base64 PNG using the qrcode package
    let qrImageBase64 = null;
    try {
      const QRCode = require("qrcode");
      const dataUrl = await QRCode.toDataURL(qrCodeHash, { type: "image/png", width: 300 });
      qrImageBase64 = dataUrl; // already "data:image/png;base64,..."
    } catch (_qrErr) {
      // qrcode package may not be installed in all envs — return null gracefully
      console.warn("getTicketQR: qrcode package unavailable:", _qrErr.message);
    }

    return ok(res, req, {
      ticket_item_id: item.id,
      qr_code_hash: qrCodeHash,
      qr_payload: qrPayload,
      qr_image_base64: qrImageBase64,
      status:
        item.ticket_status === "ACTIVE"
          ? "active"
          : item.ticket_status === "USED"
            ? "used"
            : item.ticket_status === "REFUNDED"
              ? "refunded"
              : "refunded",
    });

  } catch (err) {
    console.error("getTicketQR error:", err);
    return res.status(500).json({ error: true, message: err.message || "Internal server error", data: null });
  }
};

// ─────────────────────────────────────────────
// SERVICE 5 — POST /events/:id/scan
// ─────────────────────────────────────────────

/**
 * Validates a QR code hash at event entry. Marks ticket as used if valid.
 * Auth: required — role: promoter or admin
 *
 * Body:
 *   qr_code_hash  string (scanned from QR code)
 *
 * Response is ALWAYS 200.
 * Use valid: false to handle rejection on client (never 4xx for invalid scans).
 *
 * Rejection reasons: ALREADY_USED | INVALID_HASH | WRONG_EVENT
 */
const scanTicket = async (req, res) => {
  const client = await pool.connect();
  const startedAt = Date.now();
  try {
    const eventId = req.params.id;
    const { qr_code_hash } = req.body;
    console.log("[scanTicket:start]", {
      eventId,
      hashPrefix: String(qr_code_hash || "").slice(0, 12),
      userId: req.user?.id,
    });

    if (!qr_code_hash) {
      // Not a scan error — this is a bad API call; still return 200 with invalid
      console.log("[scanTicket:missing-hash]", { eventId, ms: Date.now() - startedAt });
      return ok(res, req, {
        valid: false,
        reason: "INVALID_HASH",
        message: "No QR code hash provided"
      });
    }

    console.log("[scanTicket:before-begin]", { eventId, ms: Date.now() - startedAt });
    await client.query("BEGIN");
    console.log("[scanTicket:after-begin]", { eventId, ms: Date.now() - startedAt });

    console.log("[scanTicket:before-fetch-ticket-for-update]", { eventId, ms: Date.now() - startedAt });
    const itemResult = await client.query(
      `SELECT
         t.id,
         t.buyer_name,
         t.status AS ticket_status,
         t.event_id,
         t.order_id,
         oi.ticket_name AS tier_name,
         t.qr_code_data
       FROM tickets t
       JOIN order_items oi ON oi.id = t.order_item_id
       WHERE t.qr_code_data = $1
       FOR UPDATE`,
      [qr_code_hash]
    );
    console.log("[scanTicket:after-fetch-ticket-for-update]", {
      eventId,
      rowCount: itemResult.rowCount,
      ms: Date.now() - startedAt,
    });

    if (itemResult.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log("[scanTicket:invalid-hash]", { eventId, ms: Date.now() - startedAt });
      return ok(res, req, {
        valid: false,
        reason: "INVALID_HASH",
        message: "QR code is invalid or unrecognised"
      });
    }

    const item = itemResult.rows[0];

    // ── WRONG_EVENT ───────────────────────────────────────────────────────────
    if (String(item.event_id) !== String(eventId)) {
      await client.query("ROLLBACK");
      console.log("[scanTicket:wrong-event]", {
        requestedEventId: eventId,
        ticketEventId: item.event_id,
        ms: Date.now() - startedAt,
      });
      return ok(res, req, {
        valid: false,
        reason: "WRONG_EVENT",
        message: "This ticket is for a different event"
      });
    }

    // ── ALREADY_USED ──────────────────────────────────────────────────────────
    if (item.ticket_status === "USED") {
      await client.query("ROLLBACK");
      console.log("[scanTicket:already-used]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });
      return ok(res, req, {
        valid: false,
        reason: "ALREADY_USED",
        message: "This ticket has already been used"
      });
    }

    // ── Mark as used ──────────────────────────────────────────────────────────
    console.log("[scanTicket:before-update-ticket-used]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });
    await client.query(
      `UPDATE tickets
       SET status = 'USED',
           used_at = NOW(),
           used_by_user_id = $2,
           checked_in_at = NOW(),
           checked_in_by = $2
       WHERE id = $1`,
      [item.id, req.user.id]
    );
    console.log("[scanTicket:after-update-ticket-used]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });

    // Record check-in + audit + validation log (existing ticketing services)
    console.log("[scanTicket:before-insert-checkin]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });
    await client.query(
      `INSERT INTO checkins (ticket_id, event_id, promoter_user_id, scanned_at)
       VALUES ($1,$2,$3,NOW())`,
      [item.id, item.event_id, req.user.id]
    );
    console.log("[scanTicket:after-insert-checkin]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });

    console.log("[scanTicket:before-audit-log]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });
    await logTicketAudit(req.user.id, item.id, item.event_id, "CHECKED_IN", "ACTIVE", "USED", {
      qr_code_hash,
      ticket_item_id: item.id,
      order_id: item.order_id,
    }, { client });
    console.log("[scanTicket:after-audit-log]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });

    const sha256 = crypto.createHash("sha256").update(String(qr_code_hash)).digest("hex");
    console.log("[scanTicket:before-validation-log]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });
    await logValidationAttempt({
      eventId: item.event_id,
      ticketId: item.id,
      qrHash: sha256,
      resultStatus: "VALID",
      scannedByUserId: req.user.id,
      metadata: {
        ticket_item_id: item.id,
        order_id: item.order_id,
        attendee_name: item.buyer_name,
      },
    }, { client });
    console.log("[scanTicket:after-validation-log]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });

    console.log("[scanTicket:before-commit]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });
    await client.query("COMMIT");
    console.log("[scanTicket:done]", { eventId, ticketId: item.id, ms: Date.now() - startedAt });

    return ok(res, req, {
      valid: true,
      message: "QR code verified successfully. Ticket checked in.",
      ticket: {
        id: item.id,
        attendee_name: item.buyer_name,
        tier_name: item.tier_name,
        status: "used"
      }
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("scanTicket error:", err);
    console.error("[scanTicket:exception]", {
      eventId: req.params?.id,
      message: err?.message,
      ms: Date.now() - startedAt,
    });
    // Per spec: always 200
    return res.status(200).json({
      error: false,
      data: {
        valid: false,
        reason: "INVALID_HASH",
        message: "An internal error occurred while validating the ticket"
      }
    });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// EXPORTS — only the 5 endpoints from Module 3
// ─────────────────────────────────────────────
module.exports = {
  createOrder,   // POST /orders
  confirmOrder,  // POST /orders/:id/confirm
  getBuyerTickets, // GET /buyer/tickets
  getBuyerCancelledEventTickets, // GET /buyer/tickets/cancelled-events
  submitBuyerRefund, // POST /buyer/refunds
  getTicketQR,   // GET /buyer/tickets/:itemId/qr
  scanTicket     // POST /events/:id/scan
};