# Event Module — API Reference

Full endpoint list for the Event module: promoter event management, public/buyer browsing, King's Account admin actions, ticket types, and orders/tickets. For the plain-English flow, see `EVENT_MODULE.md`.

All endpoints are mounted under `/api`. All non-public endpoints require `Authorization: Bearer <token>`.

---

## 1. Promoter Event Management
Base: `/api/promoters`
Auth: `requireAuth` + `requireActivePromoter` (promoter must have an approved, active account). A `kings_account` user can also call the status-change endpoints (submit/publish/pause/cancel/republish/complete) on **any** event, not just their own.

### Create event
`POST /api/promoters/events`

Body:
```json
{
  "title": "string",
  "description": "string",
  "startAt": "ISO 8601 datetime",
  "endAt": "ISO 8601 datetime",
  "timezone": "Europe/London",
  "format": "in_person | online_live | virtual_on_demand | hybrid",
  "accessMode": "ticketed | guest_list | mixed",
  "visibilityMode": "public | private_link",
  "city": "string",
  "venueName": "string",
  "venueAddress": "string",
  "lat": 0,
  "lng": 0,
  "categoryId": 1,
  "tagIds": [1, 2],
  "tagNames": ["string"]
}
```
At least one of `title`/`description`/`city`/`startAt`/`endAt` is required. Creates the event with `status = draft`.

Response: `{ id, message }`

### List my events
`GET /api/promoters/events`

### Get event detail
`GET /api/promoters/events/:eventId`
Auth: + `requireEventOwnership`

### Update event
`PATCH /api/promoters/events/:eventId`
Auth: + `requireEventOwnership`

Body — any subset of the create fields, plus:
```json
{ "resetShareToken": true }
```
Blocked if event status is `cancelled` or `cancellation_requested`.

### Delete event
`DELETE /api/promoters/events/:eventId`
Blocked if `tickets_sold > 0` or `status === 'published'`.

### Upload cover/gallery image
`POST /api/promoters/events/:eventId/images`
`multipart/form-data`, field name `image`.

### Delete cover image
`DELETE /api/promoters/events/:eventId/cover`

### Delete gallery image
`DELETE /api/promoters/events/:eventId/gallery/:imageId`

### Reorder gallery images
`PATCH /api/promoters/events/:eventId/images/reorder`

### Set category
`PUT /api/promoters/events/:eventId/category`
Body: `{ "categoryId": 1 }`

### Set tags
`PUT /api/promoters/events/:eventId/tags`
Body: `{ "tagIds": [1,2], "tagNames": ["string"] }`

### Submit for review (optional — no longer gates visibility)
`POST /api/promoters/events/:eventId/submit`
No body. Validates required fields + at least 1 active ticket type. Sets `status = pending_approval`.

### Publish (this is what makes the event buyer-visible)
`POST /api/promoters/events/:eventId/publish`
No body. Same required-field validation as submit. Sets `status = published`, `published_at = NOW()`.

### Pause
`POST /api/promoters/events/:eventId/pause`
No body. `published → unpublished`.

### Republish
`POST /api/promoters/events/:eventId/republish`
No body. `unpublished → published`.

### Cancel
`POST /api/promoters/events/:eventId/cancel`
Body: `{ "reason": "string (optional)" }`
- If event is still `draft` or `pending_approval` (never published) → cancels **immediately**, `status = cancelled`.
- If event is `published`/`unpublished` (already live) → `status = cancellation_requested`, waits for King's approval.

### Complete
`POST /api/promoters/events/:eventId/complete`
No body. Sets `completion_status = completed`, unlocks payout eligibility from escrow.

### Performance stats
`GET /api/promoters/events/:eventId/performance`

---

## 2. Ticket Types
Base: `/api/promoters`
Auth: `requireAuth` + `requireActivePromoter` (+ `requireTicketTypeOwnership` where a ticket type id is in the path)

### List ticket types for an event
`GET /api/promoters/events/:eventId/ticket-types`

### Create ticket type
`POST /api/promoters/events/:eventId/ticket-types`

Body:
```json
{
  "name": "string (required, max 100 chars)",
  "description": "string",
  "priceAmount": 0,
  "bookingFeeAmount": 0,
  "currency": "GBP",
  "salesStartAt": "ISO 8601 datetime",
  "salesEndAt": "ISO 8601 datetime",
  "capacityTotal": 100,
  "perOrderLimit": 10,
  "visibility": "public | hidden",
  "status": "active | hidden | ended",
  "sortOrder": 0,
  "access_mode": "IN_PERSON | ONLINE_LIVE | ON_DEMAND",
  "reveal_rule": "AT_PURCHASE | ONE_HOUR_BEFORE | AT_START",
  "on_demand_start_at": "ISO 8601 datetime",
  "on_demand_end_at": "ISO 8601 datetime"
}
```
Notes: `priceAmount`/`bookingFeeAmount` are integers in pence. `reveal_rule` only valid when `access_mode = ONLINE_LIVE`. `on_demand_start_at`/`on_demand_end_at` only valid when `access_mode = ON_DEMAND`.

### Update ticket type
`PATCH /api/promoters/ticket-types/:ticketTypeId`
Same fields as create, partial update. Price/booking fee can't change once `qty_sold > 0`; capacity can't drop below `qty_sold`.

### Duplicate ticket type
`POST /api/promoters/ticket-types/:ticketTypeId/duplicate`

### Pause / Resume ticket type
`POST /api/promoters/ticket-types/:ticketTypeId/pause`
`POST /api/promoters/ticket-types/:ticketTypeId/resume`

### Delete ticket type
`DELETE /api/promoters/ticket-types/:ticketTypeId`

---

## 3. Door / Check-in (Scanner)
Base: `/api/promoters`
Auth: `requireAuth` + `requireActivePromoter` + `requireEventOwnership`

- `GET /api/promoters/events/:eventId/attendees` — list attendees
- `POST /api/promoters/events/:eventId/validate` — validate a ticket QR without checking in
- `POST /api/promoters/events/:eventId/checkin` — check a ticket in
- `POST /api/promoters/events/:eventId/checkin/undo` — undo a check-in
- `GET /api/promoters/events/:eventId/logs` — check-in activity log

---

## 4. Public / Buyer Browsing
Base: `/api/events`
Auth: **none** (public). Server-side filtered to `status = published` and `visibility = public` (or the matching share link).

### List events
`GET /api/events`
Query params: filters like `city`, `category`, pagination, etc. (see controller for full list).

### Event detail
`GET /api/events/:id`

### Event detail via private link
`GET /api/events/share/:shareToken`
For `visibility = private_link` events — works regardless of who's asking, as long as they have the token.

---

## 5. King's Account (Admin)
Base: `/api/admin`
Auth: `requireRole("kings_account", "founder", "admin")`

### List events pending review
`GET /api/admin/kings-account/events/pending-approval`
Query: `page`, `pageSize`, `city`, `startDate`, `endDate`, `status`
Note: purely informational now — approving here no longer affects buyer visibility (see below).

### Approve event
`POST /api/admin/kings-account/events/:eventId/approve`
No body. Only works if `status === pending_approval`. Sets `status = active`.
> ⚠️ This endpoint still exists but no longer controls buyer visibility — publishing (`status = published`) is what makes an event visible to buyers now, and a promoter/King can publish directly without this approval step.

### Force-cancel an event
`POST /api/admin/kings-account/events/:eventId/cancel`
Body: `{ "reason": "string (optional)" }`
Cancels immediately, no request step needed.

### Approve a promoter's cancellation request
`POST /api/admin/kings-account/events/:eventId/cancel/approve`
Body: `{ "reason": "string (optional)" }`
Only works if `status === cancellation_requested`. Sets `status = cancelled`.

### Plain admin event routes (no kings-account prefix)
- `GET /api/admin/events` — list all events
- `GET /api/admin/events/:eventId` — event detail
- `GET /api/admin/events/audit-logs` — audit log of every status/field change
- `GET /api/admin/events/metrics` — aggregate stats
- `POST /api/admin/events/:eventId/complete` — mark completed
- `POST /api/admin/events/:eventId/cancel` — force-cancel

---

## 6. Orders & Tickets (Buyer purchase flow)
Base: `/api/orders`, `/api/buyer`, `/api/events/:id/scan`

### Create order
`POST /api/orders`
Auth: `requireRole("buyer")`

Body:
```json
{
  "event_id": 1,
  "idempotency_key": "string (unique per checkout attempt)",
  "items": [
    {
      "ticket_tier_id": 1,
      "quantity": 2,
      "attendees": [
        { "name": "string" },
        { "name": "string" }
      ]
    }
  ]
}
```
`attendees.length` must equal `quantity`. Checks live remaining capacity (accounting for other buyers' in-progress reservations). Reuses an existing order if the same `idempotency_key` was used by the same buyer in the last 15 minutes.

### Confirm order (payment result)
`POST /api/orders/:id/confirm`
Body: `{ "payment_status": "success | failure", "payment_ref": "string" }`
On success, issues tickets. On failure, releases the held inventory.

### My tickets
`GET /api/buyer/tickets`
Auth: `requireRole("buyer")`

### My tickets for cancelled events (refund centre)
`GET /api/buyer/tickets/cancelled-events`

### Submit refund request
`POST /api/buyer/refunds`

### Get a ticket's QR code
`GET /api/buyer/tickets/:itemId/qr`

### Scan/check in a ticket at the door
`POST /api/events/:id/scan`
Auth: `requireRole("promoter", "admin")`
Always returns `200` — check the `valid` field in the response rather than relying on HTTP status for rejection.

---

## Status values reference

`events.status`: `draft` → `pending_approval` (optional) → `published` (buyer-visible) ⇄ `unpublished` → `completed` (separate flag) | `cancellation_requested` → `cancelled`

`ticket_types.status`: `active` | `hidden` | `ended`

`orders.payment_status`: `unpaid` | `success`/`paid` | `failed`
