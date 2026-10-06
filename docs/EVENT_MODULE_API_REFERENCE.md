# Event Module API Reference

All paths are relative to `{{base_url}}/api`. Auth is a Bearer token in the `Authorization` header unless marked Public.
A matching Postman collection covering the endpoints actually called by the frontend is at `postman/Eventopia_Event_Module.postman_collection.json`.

## 1. Promoter Events (`/promoters/events`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/promoters/events` | promoter | Create event. |
| GET | `/promoters/events` | promoter | List own events. Query: `page`, `pageSize`, `search`. |
| GET | `/promoters/events/:eventId` | promoter (owner) | Full detail for one event. |
| PATCH | `/promoters/events/:eventId` | promoter (owner) | Update event fields. |
| DELETE | `/promoters/events/:eventId` | promoter (owner) | Delete event. |
| POST | `/promoters/events/:eventId/images?type=cover\|gallery` | promoter (owner) | Multipart upload, field name `image`. |
| DELETE | `/promoters/events/:eventId/cover` | promoter (owner) | Remove cover image. |
| DELETE | `/promoters/events/:eventId/gallery/:imageId` | promoter (owner) | Remove one gallery image. |
| PATCH | `/promoters/events/:eventId/images/reorder` | promoter (owner) | Reorder gallery images. Not wired into current frontend UI. |
| PUT | `/promoters/events/:eventId/category` | promoter (owner) | Body: `{ categoryId }`. Backend route exists but the frontend sets category inline via create/update instead of calling this separately. |
| PUT | `/promoters/events/:eventId/tags` | promoter (owner) | Body: `{ tagIds, tagNames }`. Same note as category above, not called directly by the frontend. |
| POST | `/promoters/events/:eventId/submit` | promoter or kings_account | Submit for approval. Not wired into current frontend UI. |
| POST | `/promoters/events/:eventId/publish` | promoter or kings_account | Body: `{}`. Requires title, description, startAt, endAt, city, format, accessMode, and if ticketed/mixed at least one active ticket type. |
| POST | `/promoters/events/:eventId/pause` | promoter or kings_account | Body: `{}`. Only valid from `published`. Sets `unpublished`. |
| POST | `/promoters/events/:eventId/cancel` | promoter or kings_account | Body: `{ reason? }`. See lifecycle notes in the overview doc for immediate-cancel vs cancellation_requested branching. |
| POST | `/promoters/events/:eventId/republish` | promoter or kings_account | Body: `{}`. Only valid from `unpublished`. |
| POST | `/promoters/events/:eventId/complete` | promoter or kings_account | Body: `{}`. Not wired into current frontend UI. |
| GET | `/promoters/events/:eventId/performance` | promoter (owner) | Views/tickets-sold/conversion metrics. Revenue fields are placeholders (0) in the current implementation. Not wired into current frontend UI. |

### Create/Update body

```json
{
  "title": "string, required",
  "description": "string",
  "startAt": "ISO datetime",
  "endAt": "ISO datetime",
  "timezone": "e.g. Europe/London",
  "format": "in_person | online_live | virtual_on_demand | hybrid",
  "accessMode": "ticketed | guest_list | mixed",
  "visibilityMode": "public | private_link",
  "city": "string",
  "venueName": "string",
  "venueAddress": "string",
  "categoryId": "number",
  "tagIds": [1, 2],
  "tagNames": []
}
```

## 2. Promoter Ticket Types (`/promoters`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/promoters/events/:eventId/ticket-types` | promoter (owner) | Query: `page`, `pageSize`. |
| POST | `/promoters/events/:eventId/ticket-types` | promoter (owner) | Create. |
| PATCH | `/promoters/ticket-types/:ticketTypeId` | promoter (owner) | Update. |
| POST | `/promoters/ticket-types/:ticketTypeId/duplicate` | promoter (owner) | Body: `{}`. |
| POST | `/promoters/ticket-types/:ticketTypeId/pause` | promoter (owner) | Body: `{}`. |
| POST | `/promoters/ticket-types/:ticketTypeId/resume` | promoter (owner) | Body: `{}`. |
| DELETE | `/promoters/ticket-types/:ticketTypeId` | promoter (owner) | Delete. |

### Create/Update body

```json
{
  "name": "string, required",
  "description": "string",
  "currency": "GBP",
  "priceAmount": 2000,
  "bookingFeeAmount": 285,
  "capacityTotal": 100,
  "perOrderLimit": 4,
  "visibility": "public | hidden"
}
```

`priceAmount` and `bookingFeeAmount` are in the smallest currency unit (pence). The frontend auto-derives `bookingFeeAmount` from `priceAmount` using a fixed UK booking-fee tier table, the field is shown read-only in the form.

## 3. King (kings_account) Event Oversight (`/admin/kings-account`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/admin/kings-account/events/pending-approval` | kings_account/founder/admin | Despite the name, returns events of every status by default. Query: `page`, `pageSize`, `city`, `startDate`, `endDate`, `status`. Only filters by status if `status` is passed and not `all`. |
| GET | `/admin/kings-account/events/:eventId` | kings_account/founder/admin | Full detail, includes `promoter`, `categories`, `tags`, `vouchers`, `ticketTypes`. Field names are raw column names (`visibility`, `city_display`), not remapped like the promoter's own detail endpoint. |
| POST | `/admin/kings-account/events/:eventId/approve` | kings_account/founder/admin | Approves a pending event. Backend exists, not called by the current King frontend UI. |
| POST | `/admin/kings-account/events/:eventId/cancel` | kings_account/founder/admin | Body: `{ reason? }`. Cancels immediately regardless of prior status. Backend exists, not called by the current King frontend UI, which instead reuses the promoter's own cancel endpoint for draft events. |
| POST | `/admin/kings-account/events/:eventId/cancel/approve` | kings_account/founder/admin | Body: `{ reason? }`. Only valid when the event's status is `cancellation_requested`. Sets `cancelled`, stamps `cancelled_at`. |

## 4. Categories (`/categories`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/categories/tree` | Public | Hierarchical, no tags. |
| GET | `/categories` | Public in practice (auth middleware is commented out in the route file despite the "Admin" doc comment) | Flat list. |
| GET | `/categories/:id` | Public | Single category. |
| POST | `/categories` | Public in practice | Body: `{ name }`. Used by the promoter's "add category" inline modal. |
| PUT | `/categories/:id` | Public in practice | Update. |
| DELETE | `/categories/:id` | Public in practice | Delete. |

## 5. Tags (`/tags`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/tags` | Public | Query: `search` (optional, ILIKE match, limit 20). |
| POST | `/tags` | Public | Body: `{ name }`. Creates or returns an existing tag with that name. Used by both the promoter's inline "add tag" modal and buyer-side tag lookups. |
| GET | `/tags/:id` | Public | Single tag. |
| PUT | `/tags/:id` | admin only | Update. |
| DELETE | `/tags/:id` | admin only | Delete. |

## 6. Buyer Browsing (`/events`)

All public, no token required.

| Method | Path | Notes |
|---|---|---|
| GET | `/events` | Query: `page`, `pageSize`, `search`, `city`, `categoryId`, `tagIds` (comma separated), `dateFrom`, `dateTo`, `sort` (`soonest`/`newest`/`popular`). Only returns `status = published` and `visibility = public`. |
| GET | `/events/:id` | Full detail plus `ticketTypes`. Same status/visibility restriction as the list. Ticket types are only included if the event's access mode is `ticketed` or `mixed`, and only tiers that are not hidden. |
| GET | `/events/share/:shareToken` | Access to one `private_link` event by its share token. Sets an access cookie. Not referenced by the current Buyer frontend, kept here for completeness. |

Ticket purchase and refund endpoints (orders, confirm, my tickets, QR, cancelled-event tickets, refund submission) are documented in `BUYER_TICKET_PURCHASE_AND_REFUND_API_REFERENCE.md`, since they belong to a separate module from event browsing.

## 7. Out of Scope

The following exist as routes/controllers under `promoters.routes.js` but are a separate feature area (attendee check-in, not the Events module itself), so they are intentionally not covered above or in the Postman collection: `GET /promoters/events/:eventId/attendees`, `POST /promoters/events/:eventId/validate`, `POST /promoters/events/:eventId/checkin`, `POST /promoters/events/:eventId/checkin/undo`, `GET /promoters/events/:eventId/logs`, `GET`/`PATCH /promoters/events/:eventId/access-settings`, `POST /promoters/events/:eventId/rotate-access`.
