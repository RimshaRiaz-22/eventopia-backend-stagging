# Event Module Overview

Covers the Event module across all three roles: Promoter, King (kings_account/admin), and Buyer.
Ticket Purchase and Refund (Buyer side) is documented separately in `BUYER_TICKET_PURCHASE_AND_REFUND_OVERVIEW.md` and `BUYER_TICKET_PURCHASE_AND_REFUND_API_REFERENCE.md`.
Full API details (method, path, auth, body) are in `EVENT_MODULE_API_REFERENCE.md`.

## 1. Roles and Responsibilities

| Role | Can do |
|---|---|
| Promoter | Create, edit, delete, publish, cancel, pause and republish their own events. Manage ticket types, cover/gallery images, category and tags. |
| King (kings_account) | Oversee all promoters' events. View full details, cancel a draft event, approve a promoter's cancellation request. Cannot create, edit or delete events. |
| Buyer | Browse and search published, public events. View event detail and ticket types. Buy tickets (separate document). |

## 2. Event Status Lifecycle

Database enum `event_status_enum`: `draft`, `pending_approval`, `active`, `published`, `completed`, `cancellation_requested`, `cancelled`, `unpublished`.

Statuses actually reachable through the current frontend and controllers:

- `draft`: default state on creation. Only the promoter sees it. Not visible to buyers.
- `published`: set by `POST /promoters/events/:id/publish`. Now visible to buyers if `visibility = public`.
- `unpublished`: set by `POST /promoters/events/:id/pause` (pausing a published event). Can be brought back with `POST /promoters/events/:id/republish`.
- `cancellation_requested`: set when a promoter cancels an event that was not a draft (i.e. already submitted/published). Waits for King's approval.
- `cancelled`: final state. Set directly when a draft/pending_approval event is cancelled, or set by King approving a `cancellation_requested` event.
- `completed`: set manually by `POST /promoters/events/:id/complete`.
- `pending_approval` and `active` exist in the enum but are not currently produced by any wired-up controller path in this codebase.

Note: the frontend's `EVENT_STATUS_MAP` objects (used for the status badge colors) also list `live` and `paused` as possible values, but neither is ever actually written to the database by the current controllers. `pauseEvent` writes `unpublished`, not `paused`. Treat those two map entries as defensive/dead.

### Cancel behavior detail

`cancelEvent` (promoter side, also used by King for draft events) branches on the event's current status:
- If status is `draft` or `pending_approval` (never published, never visible to a buyer): cancels immediately, status becomes `cancelled`.
- Any other status (e.g. `published`, `unpublished`): status becomes `cancellation_requested` and requires King's approval via `POST /admin/kings-account/events/:id/cancel/approve` to actually become `cancelled`.

This means a promoter cancelling a live/published event does not immediately cancel it. The UI must reflect that (see section 5, recent fixes).

### Publish requirements

`POST /promoters/events/:id/publish` rejects the request unless all of these are present: `title`, `description`, `startAt`, `endAt`, `city`, `format`, `accessMode`, and (if `accessMode` is `ticketed` or `mixed`) at least one ticket type with `status = 'active'`.

## 3. Data Model Summary (events table)

Key columns: `id`, `promoter_id`, `title`, `description`, `start_at`, `end_at`, `timezone`, `format` (`in_person`/`online_live`/`virtual_on_demand`/`hybrid`), `access_mode` (`ticketed`/`guest_list`/`mixed`), `visibility` (`public`/`private_link`), `share_token`, `city_display`, `venue_name`, `venue_address`, `status`, `published_at`, `cancelled_at`, `cancel_reason`, `completion_status`, `category_id`, `cover_image_url`, `gallery_image_urls` (array), `tickets_sold`.

The API layer renames some of these for the frontend contract: `visibility` becomes `visibility_mode`, `city_display` becomes `city` on the promoter's single-event GET. The King admin GET does not do this renaming, it returns the raw column names (`visibility`, `city_display`). This inconsistency was found and worked around on the frontend rather than changed on the backend, to avoid touching a working promoter flow.

## 4. Frontend Pages per Role

### Promoter (`src/pages/Promoter/Events/`)
- `PromoterEvents.jsx`: list of the promoter's own events. Search (debounced), pagination, status badge with a click-to-open action menu (Cancel for any cancellable status, Publish only for draft), row actions View/Edit/Delete.
- `AddEvent.jsx`: multi-step create/edit form (Formik). Step 1 event details, step 2 cover/gallery image upload, step 3 ticket types (delegates to `TicketType.jsx`). Used both as a right-side drawer and as a full page depending on the `view` prop.
- `TicketType.jsx`: ticket type list and CRUD for the event being created/edited (create, edit, pause, resume, duplicate, delete), plus the final Publish/Update action.
- `EventsDetails.jsx`: read-only full-page detail view with cover/gallery images, key/value fields, and ticket type cards.

### King (`src/pages/KingAdmin/Events/`)
- `EventsLists.jsx`: table of all events (default view, all statuses), with a filter drawer (city, date range, status). Row action opens a full detail page (not a drawer). Status badge is clickable only for `draft` (offers Cancel) and `cancellation_requested` (offers Approve Cancellation).
- `EventsDetails.jsx`: full-page detail view, same two-column layout as the Promoter's detail page (cover/gallery on the left with key/value fields, ticket types on the right), fetching from the King-only endpoint.
- `FilterDrawer.jsx`: the city/date/status filter panel.
- `Event StatusModel.jsx` (filename has a literal space): dead code, not imported anywhere. Left in place, not deleted, since removing files was out of scope of the work done here.

### Buyer (`src/pages/Buyer/Events/`)
- `Events.jsx`: public browse/search list (title search, city, category, tag, date range, sort). Only ever shows `published` + `public` events, enforced server side.
- `FilterDrawer.jsx`: category/tag/date/sort filter panel, populated from `/categories` and `/tags`.
- `EventDetails.jsx`: public event detail page with cover/gallery, key/value fields, ticket type cards, and a "Create Order" button.
- `CreateOrderDrawer.jsx`: order creation drawer (ticket selection, quantity, attendee names). Hands off to the ticket purchase flow documented separately.

All three roles' list/detail pages were restyled during this work to share the same visual language: the `components/ui/*` primitives (`StatusBadge`, `DateFormatter`, `Tooltip`, `Button`, `TextField`, `Dropdown`, `Pagination`) instead of hand-rolled markup, so a change to one of those shared components (for example the status badge font size fix below) applies everywhere at once.

## 5. Notable Bugs Found and Fixed in This Round of Work

- Promoter's event list had no way to cancel a published event: the status badge's action dropdown only rendered for `status === "draft"`. Fixed to show Cancel for any cancellable status, matching what the backend already allowed.
- The success toast after cancelling always said "Event cancelled successfully" even when the real outcome was "cancellation request submitted, pending King's approval". Fixed to use the backend's own `message` field.
- King's and Buyer's event detail pages built image URLs from `VITE_IMAGE_BASE_URL`, which pointed at a different host than the backend actually serving the images (`VITE_API_URL`). Fixed both to derive the image origin from `API_BASE_URL` instead, matching the Promoter page's already-working approach.
- The promoter cancel SQL had a Postgres parameter type conflict (`SET status = $1 ... CASE WHEN $1 = 'cancelled'`), causing every cancel request to fail with "inconsistent types deduced for parameter $1". Fixed by comparing against a second bound parameter instead of reusing `$1` in two different inference contexts. Verified directly against the database before and after the fix.
- Buyer's sidebar had a "My Tickets" entry with a dead `"#"` path, and a separate "Tickets Purchase" entry pointing at the one page that actually exists for both purposes. Removed the duplicate "My Tickets" entry.
- Buyer's event detail page hardcoded the event status label as "Unpublished" and every ticket's status as "Active", regardless of the real values. Since the Buyer API only ever returns published events, "Unpublished" was simply wrong. Both now render the real values.

## 6. Status Badge Color Convention (Promoter and King event lists)

`published` / `live` / `completed`: green (success).
`draft` / `pending_approval` / `unpublished` / `paused`: yellow (warning).
`cancelled`: red (danger).
`cancellation_requested`: cyan (info), deliberately different from both `draft` (yellow) and `cancelled` (red) so a pending cancellation cannot be visually confused with either.
