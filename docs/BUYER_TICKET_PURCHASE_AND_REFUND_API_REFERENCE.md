# Buyer Ticket Purchase and Refund, API Reference

All paths relative to `{{base_url}}/api`. All require a Bearer token for a `buyer`-role user unless noted.
See `BUYER_TICKET_PURCHASE_AND_REFUND_OVERVIEW.md` for the frontend pages, data model, refund window rules, and an end to end test flow.

## POST `/orders`
Create an order. Rate limited.

```json
{
  "event_id": "string, required",
  "idempotency_key": "string, required",
  "items": [
    {
      "ticket_tier_id": "string, required (a ticket type id)",
      "quantity": 1,
      "attendees": [{ "name": "Alice" }]
    }
  ]
}
```

Attendees array length must equal `quantity`. Rejects with `409 QUANTITY_EXCEEDED` if remaining capacity is insufficient. If the same buyer resends the same `idempotency_key` within 15 minutes, the existing order is returned instead of creating a duplicate. Response includes `stripe_checkout_url` when Stripe is configured on the backend, the frontend redirects there directly; otherwise it falls back to the local confirm screen.

## POST `/orders/:id/confirm`
Confirm payment. Auth required, no role restriction on the route itself, the controller checks the order belongs to the caller (or caller is `admin`).

```json
{
  "payment_ref": "order.payment_intent_ref, or the Stripe checkout session id",
  "payment_status": "success | failure"
}
```

On `"failure"`: releases the reserved inventory, sets `payment_status = failed`, returns `400 PAYMENT_FAILED`.
On `"success"` for a Stripe order: verifies the Checkout Session is actually paid before fulfilling, can return `402`/`409` if payment is not ready yet, the client is expected to retry.
On `"success"` for a stub order: requires `payment_ref` to exactly equal the order's own `payment_intent_id`.
On success: mints the tickets, updates ledgers, increments the ticket type's `qty_sold`.

## GET `/orders/buyer/tickets`
"My Tickets". Query: `status` (`active`/`used`/`cancelled`, optional), `page`, `limit`. Only includes tickets from orders where `payment_status` is paid. Response is grouped by event/order, the frontend flattens it to one row per ticket.

## GET `/orders/buyer/tickets/cancelled-events`
"Refund Center" list. Query: `page`, `limit`. Only returns tickets where the order is paid AND the event's status is `cancelled`. Each item includes a computed `refund_window` object, see the overview document section 3.

## POST `/orders/buyer/refunds`
Submit a refund request.

```json
{
  "order_item_id": "number, required, this is the order item id, not the ticket id",
  "reason_code": "string, required"
}
```

Reason codes used by the frontend dropdown: `event_cancelled`, `event_postponed`, `material_change`, `safety_concern`, `duplicate_purchase`, `technical_error`, or any custom string when `others` is selected. The backend does not enforce this exact list, it only requires a non-empty value.

Validation performed server side, in order:
1. The order item must belong to the calling buyer.
2. The order must be paid.
3. The event must be `cancelled`.
4. The primary refund window (30 days from `cancelled_at`) must still be open.
5. No open refund case (`submitted`, `under_review`, `approved`, `processing`) may already exist for that order item.

On success, the refundable amount (ticket price times quantity, booking fee excluded) is ring-fenced in the territory's escrow account and a `refund_cases` row is inserted with status `submitted`. Escrow processing after that point is a separate module, not covered here.

## GET `/buyer/tickets/:itemId/qr`
Also reachable at `/orders/buyer/tickets/:itemId/qr`, same handler.

Returns the QR image and payload for one ticket. 404s if the ticket does not belong to the caller. Response includes `qr_image_base64` (a data URI) which the frontend renders directly.
