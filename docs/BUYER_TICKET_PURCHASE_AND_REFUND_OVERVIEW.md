# Buyer Ticket Purchase and Refund, Overview

Covers the Buyer's order/ticket purchase flow and the cancelled-event refund flow.
Event browsing itself (list/detail/categories/tags) is documented in `EVENT_MODULE_OVERVIEW.md` and `EVENT_MODULE_API_REFERENCE.md`. This document starts where "Create Order" is clicked on the event detail page.
Full API details (method, path, auth, body) are in `BUYER_TICKET_PURCHASE_AND_REFUND_API_REFERENCE.md`.

## 1. Frontend Pages

- `src/pages/Buyer/Events/CreateOrderDrawer.jsx`: entry point, opened from the event detail page. Ticket selection, quantity, attendee names. Submits the order and redirects.
- `src/pages/Buyer/Events/confirmOrder.jsx`: manual/stub confirmation screen, shown when Stripe is not configured on the backend. Displays order totals and an "Expires At" countdown, has the Confirm Order button.
- `src/pages/Buyer/Events/StripeCheckoutReturn.jsx`: landing page after a Stripe Checkout redirect, auto-confirms the order.
- `src/pages/Buyer/Events/SuccessScreen.jsx`: final success screen, purely presentational, reads the confirmed order from router state.
- `src/pages/Buyer/TicketPurchase/TicketPurchase.jsx`: "My Tickets" table, one row per ticket, grouped by order/event. QR button per row.
- `src/pages/Buyer/TicketPurchase/QrModal.jsx`: fetches and displays a single ticket's QR code.
- `src/pages/Buyer/Refund/cancelledTickets.jsx`: "Refund Center", lists tickets belonging to events that were later cancelled, with a refund-window status and a Request Refund action.
- `src/pages/Buyer/Refund/DetailsDrawer.jsx`: read-only detail drawer for one cancelled ticket.
- `src/pages/Buyer/Refund/AddRequestDrawer.jsx`: refund request form (reason code).

Sidebar routing (`BuyerLayout.jsx`): "Tickets Purchase" points at `/dashboard/buyer/ticket-purchase` (the My Tickets page above). There is no separate "buy new tickets" list page, tickets are bought from an event's own detail page, not from a dedicated purchase page. A previously duplicated "My Tickets" sidebar entry pointing nowhere was removed.

## 2. Order and Ticket Data Model (brief)

- `orders`: one row per checkout. Key fields: `buyer_user_id`, `event_id`, `status` (`payment_pending`, ...), `payment_status` (`unpaid`, `paid`/`completed`/`succeeded` on success, `failed`), `payment_intent_ref`, `total_ticket_amount`, `total_booking_fee`, `grand_total`, `expires_at`.
- `order_items`: one row per attendee/ticket within an order. Holds `ticket_type_id`, `ticket_name`, `ticket_price_amount`, `ticket_booking_fee_amount`.
- `tickets`: the actual issued ticket, created on successful payment confirmation. Holds `status` (`ACTIVE`, `USED`, `CANCELLED`/`VOID`, `REFUNDED`), `buyer_name`.
- `refund_cases`: one row per refund request, `status` starts at `submitted`.

A ticket only exists after `POST /orders/:id/confirm` succeeds. Creating an order alone does not mint a ticket, it only reserves inventory for a short window.

## 3. Refund Window Rules

Computed per ticket by `getBuyerCancelledEventTickets`:
- `primary_window_ends_at` = `event.cancelled_at` + 30 days.
- `stage`: `"primary"` while now is before that date, `"closed"` after, `"unknown"` if the event has no `cancelled_at` recorded.
- `can_request_refund`: true only when `stage` is `"primary"` and the ticket's own status is not already `REFUNDED`.
- `days_left_in_current_window`: whole days remaining, rounded up.

## 4. End to End Test Flow

To exercise the full purchase-then-refund path, a ticket has to be bought while the event is still published, then the event has to be cancelled afterward. A buyer never sees a non-published event, so this cannot be shortcut.

1. Promoter creates an event, adds a ticket type, publishes it (`POST /promoters/events`, `POST /promoters/events/:id/ticket-types`, `POST /promoters/events/:id/publish`).
2. Buyer finds it (`GET /events`), opens it (`GET /events/:id`) to get a `ticket_tier_id`, creates an order (`POST /orders`), then confirms it (`POST /orders/:id/confirm` with `payment_status: "success"`). This last step is what actually mints the ticket.
3. Promoter cancels the now-published event (`POST /promoters/events/:id/cancel`). Because it was already published, this only sets `cancellation_requested`, it does not cancel outright.
4. King approves the cancellation (`POST /admin/kings-account/events/:id/cancel/approve`). This is the step that sets `status = cancelled` and stamps `cancelled_at`.
5. Buyer now sees the ticket at `GET /orders/buyer/tickets/cancelled-events`, with `refund_window.can_request_refund = true`.
6. Buyer submits the refund (`POST /orders/buyer/refunds`) using `ticket.order_item_id` from step 5's response, not the ticket's own id.

## 5. Known Gaps

- There is no dedicated "browse tickets to buy" page distinct from the event detail page. This was previously implied by two separate sidebar entries pointing at the same "My Tickets" page, one of them has since been removed.
- `getEventPerformance`'s revenue/booking-fee/refund totals are hardcoded placeholders (0) in the current backend implementation, not real aggregates.
